/**
 * Anti-Raid 主线程控制器（packages/antiRaid/workerBridge/controller.ts）的
 * 公开控制命令、双工能力分派，以及初始化与重建重放（含已落盘终态验证的回执补投）。
 *
 * 与 workerBridgeObservers.test.ts 分工：那一条驱动「注册一次、由上游回调」
 * 的观察者；本文件驱动命令侧——`/antiraid disable`、`/ad_detect disable`、
 * `/flood_control disable` 与统一 teardown 各自投什么，以及 Worker 不可用时它们
 * 上抛而不是静默吞掉。
 */

import { botPermissions } from "../helpers/botPermissions";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid/protocol";
import type { BotChatPermissions } from "../../packages/types/telegram";
import type { VerificationSnapshot, VerificationSnapshotBase } from "../../packages/types/antiRaid/verification";

const workerPosts: AntiRaidWorkerMessage[] = [];
/**
 * post 的返回值；false 模拟「Worker 正在重建或已放弃」。`rejectType` 只拒这一种消息，
 * 模拟重放中途被拒。
 */
const delivery: { accepts: boolean; rejectType: string | null } = { accepts: true, rejectType: null };
const deletedDeferralChats: number[] = [];
const grantedPermits: unknown[] = [];
const telegramRequests: unknown[] = [];
const telegramTransfers: unknown[] = [];
const adBypassIds: Set<number> = new Set<number>();
const permanentWhitelistIds: Set<number> = new Set<number>();
let identityPrefetchSucceeds: boolean = true;
const prefetchIdentityPolicies = mock(async (): Promise<boolean> =>
  identityPrefetchSucceeds
);

/** superviseDuplexWorker 收到的 options；用来直接驱动 handleRequest 等回调。 */
const captured: { options?: Record<string, any> } = {};
const terminateWorker = mock(async (): Promise<void> => {});

mock.module("../../packages/infra/supervisedDuplexWorker", () => ({
  superviseDuplexWorker: (options: Record<string, any>) => {
    captured.options = options;
    return {
      init: (): void => {},
      post: (message: AntiRaidWorkerMessage): boolean => {
        if (!delivery.accepts || message.type === delivery.rejectType) return false;
        workerPosts.push(message);
        return true;
      },
      terminate: terminateWorker,
    };
  },
}));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub() }));
mock.module("../../packages/antiRaid/verificationAttempts", () => ({
  advanceDeferredVerificationGeneration: (): void => {},
  deleteDeferredVerificationsForChat: (chatId: number): void => {
    deletedDeferralChats.push(chatId);
  },
  grantVerificationAttempt: (request: unknown): { granted: true } => {
    grantedPermits.push(request);
    return { granted: true };
  },
  // 整份模块被替换时需要提供全部导出；这两个本文件不驱动，只为让模块形状完整。
  acceptVerificationDeferred: (): boolean => false,
  settlePersistedVerificationDeferral: (): boolean => false,
  resetVerificationAttemptRuntime: (): void => {},
}));
mock.module("../../packages/infra/telegram/workerRequests", () => ({
  handleAntiRaidWorkerTelegramRequest: async (
    request: unknown,
    _signal: AbortSignal
  ): Promise<string> => {
    telegramRequests.push(request);
    return "telegram-result";
  },
  telegramWorkerResponseTransfer: (
    request: unknown,
    _value: unknown
  ): undefined => {
    telegramTransfers.push(request);
    return undefined;
  },
}));
const identityStorage = await import("../../packages/infra/identityStorage");
mock.module("../../packages/infra/identityStorage", () => ({
  ...identityStorage,
  prefetchIdentityPolicies,
}));
const whitelistPolicy = await import("../../packages/infra/identityPolicy/whitelist");
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  ...whitelistPolicy,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    key === "isCanBypassAdDetection" && adBypassIds.has(id),
  isWhitelisted: (id: number): boolean => permanentWhitelistIds.has(id),
}));
const temporaryAdBypassPolicy = await import(
  "../../packages/infra/identityPolicy/temporaryAdBypass"
);
mock.module("../../packages/infra/identityPolicy/temporaryAdBypass", () => ({
  ...temporaryAdBypassPolicy,
  hasActiveTemporaryAdBypassAt: (id: number): boolean => adBypassIds.has(id),
}));
mock.module("../../packages/antiRaid/workerBridge/observers", () => ({
  registerAntiRaidBridgeObservers: (): void => {},
}));

const {
  clearAdDetection,
  clearFloodControl,
  deactivateAntiRaidChat,
  deactivateJoinGuardChat,
  hydratePendingVerifications,
  initAntiRaid,
  postAntiRaid,
  terminateAntiRaid,
} = await import("../../packages/antiRaid/workerBridge/controller");
const { antiRaidRuntimeState } =
  await import("../../packages/cache/main/antiRaid/proxy");
const { chatIsSupergroupById } = await import("../../packages/cache/main/antiRaid/chatKind");
const { getOrCreateChatState } = await import("../../packages/infra/storage/stateStore");
const { VERIFICATION_RECORD_CAPACITY } =
  await import("../../packages/consts/antiRaid/verification");
const {
  clearActiveVerificationSnapshots,
  persistedVerificationRevisions,
  setActiveVerificationSnapshot,
} = await import("../../packages/cache/main/antiRaid/verificationMirror");
const { verificationKey } = await import("../../packages/libs/verificationKey");

const CHAT_ID: number = -1001;

function typesOf(): string[] {
  return workerPosts.map((message: AntiRaidWorkerMessage): string => message.type);
}

/**
 * 一条活动验证快照夹具；expelling 终态带上处置原因，pending 不带。代际取当前进程代际，
 * 与 persistedVerificationRevisions 里的落盘水位线对得上。
 */
function verificationSnapshot(
  userId: number,
  phase: "pending" | "expelling",
  revision: number
): VerificationSnapshot {
  const base: VerificationSnapshotBase = {
    chatId: CHAT_ID,
    userId,
    generation: antiRaidRuntimeState.generation,
    revision,
    label: "Zako",
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 2_000,
  };
  return phase === "expelling"
    ? { ...base, phase, expelReason: "timeout" }
    : { ...base, phase };
}

/** 登记一条活动快照，并把它当前的 (generation, revision) 记为已落盘。 */
function seedPersistedVerification(snapshot: VerificationSnapshot): string {
  const key: string = verificationKey(snapshot.chatId, snapshot.userId);
  setActiveVerificationSnapshot(key, snapshot);
  persistedVerificationRevisions.set(key, { generation: snapshot.generation, revision: snapshot.revision });
  return key;
}

beforeEach(() => {
  workerPosts.length = 0;
  deletedDeferralChats.length = 0;
  grantedPermits.length = 0;
  telegramRequests.length = 0;
  telegramTransfers.length = 0;
  adBypassIds.clear();
  permanentWhitelistIds.clear();
  identityPrefetchSucceeds = true;
  prefetchIdentityPolicies.mockClear();
  delivery.accepts = true;
  delivery.rejectType = null;
  antiRaidRuntimeState.initialized = false;
});

describe("Anti-Raid 控制命令", () => {
  test("统一 teardown 先丢本进程延后闩锁，再投 deactivateChat 并带上清理标记", () => {
    deactivateAntiRaidChat(CHAT_ID, true, false);

    expect(deletedDeferralChats).toEqual([CHAT_ID]);
    expect(workerPosts).toEqual([{
      type: "deactivateChat",
      chatId: CHAT_ID,
      cleanupVerificationMessages: true,
      abandonLockdown: false,
    }]);
  });

  test("teardown 的清理与放弃私密模式标记原样传下去，不在主线程改写", () => {
    deactivateAntiRaidChat(CHAT_ID, false, true);

    expect(workerPosts).toEqual([{
      type: "deactivateChat",
      chatId: CHAT_ID,
      cleanupVerificationMessages: false,
      abandonLockdown: true,
    }]);
  });

  test("/antiraid disable 只收验证与 lockdown，同样先丢延后闩锁", () => {
    deactivateJoinGuardChat(CHAT_ID);

    expect(deletedDeferralChats).toEqual([CHAT_ID]);
    expect(workerPosts).toEqual([{ type: "deactivateJoinGuard", chatId: CHAT_ID }]);
  });

  test("/ad_detect disable 与 /flood_control disable 各自只投自己那条", () => {
    clearAdDetection(CHAT_ID);
    clearFloodControl(CHAT_ID);

    expect(typesOf()).toEqual(["clearAdDetect", "clearFloodControl"]);
    expect(deletedDeferralChats).toEqual([]);
  });

  test("Worker 不可用时四条控制命令一律上抛，不静默吞掉", () => {
    delivery.accepts = false;

    expect(() => deactivateAntiRaidChat(CHAT_ID, true, false))
      .toThrow("Anti-Raid Worker is unavailable.");
    expect(() => deactivateJoinGuardChat(CHAT_ID))
      .toThrow("Anti-Raid Worker is unavailable.");
    expect(() => clearAdDetection(CHAT_ID))
      .toThrow("Anti-Raid Worker is unavailable.");
    expect(() => clearFloodControl(CHAT_ID))
      .toThrow("Anti-Raid Worker is unavailable.");
    expect(workerPosts).toEqual([]);
  });

  test("尽力投递的 postAntiRaid 只报结果，不上抛", () => {
    delivery.accepts = false;
    expect(postAntiRaid({ type: "clearAdDetect", chatId: CHAT_ID })).toBeFalse();

    delivery.accepts = true;
    expect(postAntiRaid({ type: "clearAdDetect", chatId: CHAT_ID })).toBeTrue();
    expect(typesOf()).toEqual(["clearAdDetect"]);
  });
});

describe("Anti-Raid 双工能力分派", () => {
  test("验证名额许可在主线程就地结算，不进 Telegram 边界", async () => {
    const request = { operation: "verificationAttemptPermit", chatId: CHAT_ID } as never;

    const value: unknown = await captured.options!.handleRequest(
      request,
      new AbortController().signal
    );

    expect(value).toEqual({ granted: true });
    expect(grantedPermits).toEqual([request]);
    expect(telegramRequests).toEqual([]);
  });

  test("其余能力请求交给 Telegram 边界", async () => {
    const request = { operation: "sendMessage", chatId: CHAT_ID } as never;

    const value: unknown = await captured.options!.handleRequest(
      request,
      new AbortController().signal
    );

    expect(value).toBe("telegram-result");
    expect(telegramRequests).toEqual([request]);
    expect(grantedPermits).toEqual([]);
  });

  test("引用广告警告发送前复查当前单项豁免，冷读失败同样不误警告", async () => {
    const request = {
      operation: "sendTemporaryMessage",
      purpose: "adWarning",
      chatId: CHAT_ID,
      identityId: 7,
      text: "warning",
    } as never;

    adBypassIds.add(7);
    await expect(captured.options!.handleRequest(
      request,
      new AbortController().signal
    )).resolves.toEqual({ suppressed: true });
    expect(telegramRequests).toEqual([]);

    adBypassIds.clear();
    permanentWhitelistIds.add(7);
    await expect(captured.options!.handleRequest(
      request,
      new AbortController().signal
    )).resolves.toBe("telegram-result");
    expect(telegramRequests).toEqual([request]);

    permanentWhitelistIds.clear();
    identityPrefetchSucceeds = false;
    await expect(captured.options!.handleRequest(
      request,
      new AbortController().signal
    )).resolves.toEqual({ suppressed: true });
    expect(telegramRequests).toEqual([request]);

    identityPrefetchSucceeds = true;
    await expect(captured.options!.handleRequest(
      request,
      new AbortController().signal
    )).resolves.toBe("telegram-result");
    expect(telegramRequests).toEqual([request, request]);
  });

  test("许可回执没有可转移缓冲；只有 Telegram 回执才问 transfer 清单", () => {
    expect(captured.options!.responseTransfer(
      { operation: "verificationAttemptPermit" } as never,
      { granted: true }
    )).toBeUndefined();
    expect(telegramTransfers).toEqual([]);

    const download = { operation: "downloadFile" } as never;
    captured.options!.responseTransfer(download, new ArrayBuffer(8));
    expect(telegramTransfers).toEqual([download]);
  });

  test("Worker 监督句柄按既定标签与放弃后果注册", () => {
    expect(captured.options!.label).toBe("Anti-raid guard Worker");
    expect(captured.options!.giveUpConsequence).toContain("join verification");
  });
});

describe("Anti-Raid 初始化与重建重放", () => {
  test("任一重放被拒时 initAntiRaid 回滚 initialized，不把半接管的状态留着", () => {
    delivery.accepts = false;

    terminateWorker.mockClear();
    expect(() => initAntiRaid()).toThrow("Anti-Raid Worker");
    expect(antiRaidRuntimeState.initialized).toBeFalse();
    // 生命周期不会替半途失败的初始化终止 Worker，失败分支自己收掉。
    expect(terminateWorker).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["botPermissionsChanged", "bot permissions snapshot"],
    ["chatKind", "chat kind snapshot"],
  ])("权限或群类型重放中途被拒（%s）同样中止接管并回滚", (rejectType: string, snapshot: string) => {
    getOrCreateChatState(CHAT_ID).botPermissions = { canRestrictMembers: true, canDeleteMessages: true } as BotChatPermissions;
    chatIsSupergroupById.set(CHAT_ID, true);
    delivery.rejectType = rejectType;
    try {
      expect(() => initAntiRaid()).toThrow(`Anti-Raid Worker rejected the ${snapshot}.`);
      expect(antiRaidRuntimeState.initialized).toBeFalse();
      expect(typesOf()).not.toContain("adoptVerifications");
    } finally {
      delete getOrCreateChatState(CHAT_ID).botPermissions;
      chatIsSupergroupById.delete(CHAT_ID);
    }
  });

  test("接管重放的机器人权限只投影出 Worker 需要的两位", () => {
    getOrCreateChatState(CHAT_ID).botPermissions = botPermissions({ canRestrictMembers: true, canDeleteMessages: false });
    try {
      initAntiRaid();
      expect(workerPosts.filter((message: AntiRaidWorkerMessage): boolean => message.type === "botPermissionsChanged"))
        .toEqual([{
          type: "botPermissionsChanged",
          chatId: CHAT_ID,
          permissions: { canRestrictMembers: true, canDeleteMessages: false },
        }]);
    } finally {
      delete getOrCreateChatState(CHAT_ID).botPermissions;
    }
  });

  test("接管成功后 initialized 置位，重复调用幂等", () => {
    initAntiRaid();
    const afterFirst: number = workerPosts.length;

    initAntiRaid();

    expect(antiRaidRuntimeState.initialized).toBeTrue();
    expect(workerPosts).toHaveLength(afterFirst);
  });

  test("重建重放按 FIFO 先投配置再投接管快照", () => {
    const replayed: AntiRaidWorkerMessage[] = [];
    captured.options?.onRespawn((message: AntiRaidWorkerMessage): boolean => {
      replayed.push(message);
      return true;
    });

    const types: string[] = replayed.map((message: AntiRaidWorkerMessage): string => message.type);
    expect(types[0]).toBe("agentConfig");
    expect(types).toContain("adoptVerifications");
    expect(types.indexOf("agentConfig")).toBeLessThan(types.indexOf("adoptVerifications"));
  });

  test("重建重放在第一条被拒时立刻停手，不继续投后面的接管快照", () => {
    const replayed: AntiRaidWorkerMessage[] = [];
    captured.options?.onRespawn((message: AntiRaidWorkerMessage): boolean => {
      replayed.push(message);
      return false;
    });

    // 第一条被拒后停止投递，留给下一次重建重放同一份镜像。
    expect(replayed.map((message: AntiRaidWorkerMessage): string => message.type)).toEqual(["agentConfig"]);
  });

  test("已落盘的终态验证在接管快照之后补投落盘回执，带新代际与原 revision；未进终态的不补", () => {
    const oldGeneration: number = antiRaidRuntimeState.generation;
    const terminalKey: string = seedPersistedVerification(verificationSnapshot(501, "expelling", 4));
    seedPersistedVerification(verificationSnapshot(502, "pending", 2));
    const replayed: AntiRaidWorkerMessage[] = [];
    try {
      captured.options?.onRespawn((message: AntiRaidWorkerMessage): boolean => {
        replayed.push(message);
        return true;
      });
    } finally {
      clearActiveVerificationSnapshots();
      persistedVerificationRevisions.clear();
    }

    const adopt: AntiRaidWorkerMessage | undefined = replayed.find(
      (message: AntiRaidWorkerMessage): boolean => message.type === "adoptVerifications"
    );
    if (adopt?.type !== "adoptVerifications") throw new Error("Expected an adoptVerifications replay.");
    expect(adopt.generation).not.toBe(oldGeneration);
    const persisted: AntiRaidWorkerMessage[] = replayed.filter(
      (message: AntiRaidWorkerMessage): boolean => message.type === "verificationPersisted"
    );
    // 新 Worker 凭这条回执直接续跑终态副作用，不必等 Disk I/O 再写一遍同一 revision。
    expect(persisted).toEqual([{
      type: "verificationPersisted",
      key: terminalKey,
      generation: adopt.generation,
      revision: 4,
    }]);
    const types: string[] = replayed.map((message: AntiRaidWorkerMessage): string => message.type);
    expect(types.indexOf("adoptVerifications")).toBeLessThan(types.indexOf("verificationPersisted"));
    // 本群没开 /antiraid：回执之后照常清理残留的入群守卫。
    expect(types.indexOf("verificationPersisted")).toBeLessThan(types.indexOf("deactivateJoinGuard"));
  });

  test("补投落盘回执被拒时立刻停手，不再投后面的守卫清理", () => {
    const terminalKey: string = seedPersistedVerification(verificationSnapshot(503, "expelling", 6));
    const replayed: AntiRaidWorkerMessage[] = [];
    try {
      captured.options?.onRespawn((message: AntiRaidWorkerMessage): boolean => {
        replayed.push(message);
        return message.type !== "verificationPersisted";
      });
    } finally {
      clearActiveVerificationSnapshots();
      persistedVerificationRevisions.clear();
    }

    expect(replayed.at(-1)).toMatchObject({ type: "verificationPersisted", key: terminalKey, revision: 6 });
    expect(replayed.map((message: AntiRaidWorkerMessage): string => message.type)).not.toContain("deactivateJoinGuard");
  });
});

describe("待验证镜像灌入的守卫", () => {
  test("必须早于 Anti-Raid 初始化", () => {
    initAntiRaid();

    expect(() => hydratePendingVerifications(new Map()))
      .toThrow("before Anti-Raid initialization");
  });

  test("超过容量上限时拒绝灌入", async () => {
    await terminateAntiRaid();
    const records = new Map<string, never>();
    for (let index: number = 0; index <= VERIFICATION_RECORD_CAPACITY; index++) {
      records.set(`-1001:${index}`, undefined as never);
    }

    expect(() => hydratePendingVerifications(records))
      .toThrow(`${VERIFICATION_RECORD_CAPACITY}-record capacity`);
  });
});
