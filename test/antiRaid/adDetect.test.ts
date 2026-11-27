/**
 * `packages/antiRaid/adDetect.ts` 主线程广告命中处置与自动拉黑写回集成测试：
 * 覆盖 `handleAdDetected` 同时执行发送者处罚与 `persistAutoBlacklistedAdPacks`、
 * 写回抛错或慢于处罚时绝不中断或阻塞处罚、停机排空等待写回结算，以及受保护/关闭群不触发写回。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getTimeZone } from "../../packages/config/time";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../packages/consts/telegram";
import { MINUTE_MS } from "../../packages/consts/time";
import {
  DEFAULT_WHITELIST_PERMISSIONS,
  SUPER_ADMIN_WHITELIST_PERMISSIONS,
} from "../../packages/consts/whitelist";
import { isManagedAdminChat } from "../../packages/infra/blocklist/sweepEligibility";
import type { AutoBlacklistAdPacksOptions } from "../../packages/antiRaid/adBlacklistPersistence";
import type {
  BanChatMemberOutcome,
  KickChatMemberOutcome,
  MuteChatMemberOutcome,
} from "../../packages/infra/telegram";
import type { AdDetectedEvent } from "../../packages/types/antiRaid/adDetect";
import type { RemoveBlockedMembersParams } from "../../packages/types/blocklist";
import type { ChatState } from "../../packages/types/chatState";
import type { AdDetectConfig, BotConfig } from "../../packages/types/config";
import type { WhitelistPermissions } from "../../packages/types/identityPolicy";
import { botPermissions } from "../helpers/botPermissions";
import { chatStateOf } from "../helpers/chatState";
import { diskIOStub } from "../helpers/diskIOMock";
import { identityFieldView } from "../helpers/identityCacheView";
import type { IdentityFieldView } from "../helpers/identityCacheView";
import { loggerStub } from "../helpers/loggerMock";

const whitelistField: IdentityFieldView<"whitelist"> = identityFieldView("whitelist");
const blocklistField: IdentityFieldView<"blocklist"> = identityFieldView("blocklist");
const temporaryAdBypassField: IdentityFieldView<"temporaryAdBypass"> = identityFieldView("temporaryAdBypass");

const chatStates = new Map<number, ChatState>();
const blockedIds = new Set<number>();
const errorLogs: unknown[][] = [];
const dispatchedRemovals: RemoveBlockedMembersParams[][] = [];
const persistedPackCalls: AutoBlacklistAdPacksOptions[] = [];
let removalCounter: number = 0;

const persistAutoBlacklistedAdPacks = mock(
  async (options: AutoBlacklistAdPacksOptions): Promise<void> => {
    persistedPackCalls.push(options);
  }
);
const blockUser = mock((userId: number): boolean => (blockedIds.has(userId) ? false : (blockedIds.add(userId), true)));
const confirmBlocklistPersisted = mock(async (): Promise<boolean> => true);
const isUserBlocked = mock((userId: number): boolean => blockedIds.has(userId));
const trackBlockedRemoval = mock(
  (params: Omit<RemoveBlockedMembersParams, "removalId">): RemoveBlockedMembersParams => ({
    ...params,
    removalId: ++removalCounter,
  })
);
const requestBlocklistResweep = mock((_chatId: number): void => {});
const clearTemporaryAdBypassActivity = mock((_id: number): boolean => true);
const sendMessage = mock(async (params: { readonly onSent?: (id: number) => void }): Promise<number> => {
  params.onSent?.(555);
  return 555;
});
const deleteMessageAfter = mock((..._args: unknown[]): void => {});
const deleteMessages = mock(async (..._args: unknown[]): Promise<boolean> => true);
const releasedDedupKeys: { readonly chatId: number; readonly senderId: number }[] = [];
const muteChatMemberWithOutcome = mock(async (): Promise<MuteChatMemberOutcome> => "muted");
const muteChatMemberPermanentlyWithOutcome = mock(async (): Promise<MuteChatMemberOutcome> => "muted");
const kickChatMemberWithOutcome = mock(async (): Promise<KickChatMemberOutcome> => "kicked");
const banChatMemberWithOutcome = mock(async (): Promise<BanChatMemberOutcome> => "banned");
const probeChatMembership = mock(async (): Promise<boolean | undefined> => true);
const postDiskIODiagnostic = mock((_message: unknown): boolean => true);
let diskIOInitialized: boolean = false;

mock.module("../../packages/antiRaid/adBlacklistPersistence", () => ({
  persistAutoBlacklistedAdPacks,
}));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({
    error: (...args: unknown[]): void => { errorLogs.push(args); },
  }),
}));
mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing",
  SUPER_ADMIN_USER_ID: 1,
  getBotConfig: (): BotConfig => ({
    timeZone: getTimeZone(),
    atmosphere: "mesugaki",
    logLevel: "operation",
    botToken: "telegram-token",
    superAdminUserId: 1,
  }),
}));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  getEffectiveWhitelistPermissions: (id: number): Readonly<WhitelistPermissions> | undefined => {
    if (id === 1) return SUPER_ADMIN_WHITELIST_PERMISSIONS;
    if (id === 100) return DEFAULT_WHITELIST_PERMISSIONS;
    if (id === 101) return { ...DEFAULT_WHITELIST_PERMISSIONS, isCanBypassAdDetection: false };
    return undefined;
  },
  hasPermanentWhitelistPermission: (id: number): boolean => id === 1 || id === 100,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 || (id === 100 && key === "isCanBypassAdDetection"),
  isWhitelisted: (id: number): boolean => id === 1 || id === 100 || id === 101,
  readEffectiveWhitelistOrBlocked: (id: number): "allowed" | "blocked" | "none" => {
    if (id === 1 || id === 100 || id === 101) return "allowed";
    return isUserBlocked(id) ? "blocked" : "none";
  },
}));
const realMessages = await import("../../packages/infra/telegram/actions/messages");
const realMessageLifecycle = await import("../../packages/infra/telegram/actions/messageLifecycle");
mock.module("../../packages/infra/telegram/actions/messages", () => ({
  ...realMessages,
  sendMessage,
}));
mock.module("../../packages/infra/telegram/actions/messageLifecycle", () => ({
  ...realMessageLifecycle,
  deleteMessageAfter,
  deleteMessages,
}));
mock.module("../../packages/infra/telegram", () => ({
  muteChatMemberWithOutcome,
  muteChatMemberPermanentlyWithOutcome,
  kickChatMemberWithOutcome,
  banChatMemberWithOutcome,
  probeChatMembership,
}));
mock.module("../../packages/infra/blocklist/membership", () => ({
  blockUser,
  confirmBlocklistPersisted,
  isUserBlocked,
  managedAdminChatIds: (chatId: number, isAdminHere: boolean): number[] => {
    const ids: number[] = isAdminHere ? [chatId] : [];
    for (const [otherChatId, state] of chatStates) {
      if (otherChatId !== chatId && isManagedAdminChat(state)) ids.push(otherChatId);
    }
    return ids;
  },
}));
mock.module("../../packages/infra/identityPolicy/temporaryAdBypass", () => ({
  clearTemporaryAdBypassActivity,
  clearTemporaryAdBypassActivityOrThrow: (id: number): void => {
    if (!clearTemporaryAdBypassActivity(id)) {
      throw new Error(`Temporary ad bypass reset for identity ${id} was rejected.`);
    }
  },
  hasActiveTemporaryAdBypassAt: (): boolean => false,
  storedTemporaryAdBypassActivities: (): ReadonlyMap<number, never> => new Map<number, never>(),
  currentTemporaryAdBypassActivity: (): null => null,
}));
mock.module("../../packages/infra/blocklist/outbox", () => ({
  trackBlockedRemoval,
}));
mock.module("../../packages/infra/blocklist/sweep", () => ({
  requestBlocklistResweep,
}));
mock.module("../../packages/infra/diskIO", () => diskIOStub({
  isDiskIOInitialized: (): boolean => diskIOInitialized,
  postDiskIODiagnostic,
}));
mock.module("../../packages/infra/chatStateStorage", () => ({
  getChatStateCache: () => chatStates,
  getChatState: (chatId: number): ChatState => chatStates.get(chatId) ?? chatStateOf(),
}));
mock.module("../../packages/infra/botAdmin", () => ({
  botCanDeleteMessagesIn: (chatId: number): boolean | undefined =>
    chatStates.get(chatId)?.botPermissions?.canDeleteMessages,
  botCanRestrictMembersIn: (chatId: number): boolean | undefined =>
    chatStates.get(chatId)?.botPermissions?.canRestrictMembers,
}));

const { drainAdDisposals, handleAdDetected } = await import("../../packages/antiRaid/adDetect");
const {
  adDetectDedupReleaserHolder,
  inFlightAdDisposals,
} = await import("../../packages/cache/main/antiRaid/adDisposal");
const { chatIsSupergroupById } = await import("../../packages/cache/main/antiRaid/chatKind");
const {
  blockedMemberRemoverHolder,
  blocklistIdentityMutationQueues,
} = await import("../../packages/cache/main/blocklist");
const { defaultAdDetectConfigCache } = await import("../../packages/cache/perThread/config");
const { adoptAdDetectConfig } = await import("../../packages/config/adDetectConfig");

let savedAdDetectCache: AdDetectConfig | null = null;
const originalRemover = blockedMemberRemoverHolder.current;
const originalDedupReleaser = adDetectDedupReleaserHolder.current;

function createDetectedEvent(overrides: Partial<AdDetectedEvent> = {}): AdDetectedEvent {
  return {
    type: "adDetected",
    chatId: -1001,
    senderId: 7,
    isChannel: false,
    label: "Spammer",
    meta: { firstName: "Spammer", lastName: "", username: "spammer" },
    reason: "包含引流广告",
    messages: [{ messageId: 10, type: "text", text: "加V领福利", quote: undefined, replyTo: undefined }],
    deleteMessageIds: [10],
    ...overrides,
  };
}

beforeEach((): void => {
  savedAdDetectCache = defaultAdDetectConfigCache.current;
  adoptAdDetectConfig({
    punishment: { kind: "kick", blockScope: "global" },
    samples: ["测试样本"],
  });
  chatStates.clear();
  chatStates.set(-1001, chatStateOf({
    isAdDetectEnabled: true,
    isInitEnabled: true,
    botPermissions: botPermissions({ canRestrictMembers: true, canDeleteMessages: true }),
  }));
  blockedIds.clear();
  errorLogs.length = 0;
  dispatchedRemovals.length = 0;
  persistedPackCalls.length = 0;
  releasedDedupKeys.length = 0;
  removalCounter = 0;
  inFlightAdDisposals.clear();
  blocklistIdentityMutationQueues.clear();
  whitelistField.clear();
  blocklistField.clear();
  temporaryAdBypassField.clear();
  for (const id of [7, 100, 101, -300]) {
    whitelistField.set(id, null);
    blocklistField.set(id, null);
    temporaryAdBypassField.set(id, null);
  }
  diskIOInitialized = false;
  chatIsSupergroupById.clear();
  persistAutoBlacklistedAdPacks.mockReset();
  persistAutoBlacklistedAdPacks.mockImplementation(
    async (options: AutoBlacklistAdPacksOptions): Promise<void> => {
      persistedPackCalls.push(options);
    }
  );
  blockUser.mockClear();
  confirmBlocklistPersisted.mockClear();
  isUserBlocked.mockClear();
  trackBlockedRemoval.mockClear();
  requestBlocklistResweep.mockClear();
  clearTemporaryAdBypassActivity.mockClear();
  sendMessage.mockClear();
  deleteMessageAfter.mockClear();
  deleteMessages.mockReset();
  deleteMessages.mockImplementation(async (): Promise<boolean> => true);
  muteChatMemberWithOutcome.mockClear();
  muteChatMemberPermanentlyWithOutcome.mockClear();
  kickChatMemberWithOutcome.mockClear();
  banChatMemberWithOutcome.mockClear();
  probeChatMembership.mockClear();
  postDiskIODiagnostic.mockClear();
  blockedMemberRemoverHolder.current = async (
    removals: readonly RemoveBlockedMembersParams[]
  ): Promise<number> => {
    dispatchedRemovals.push([...removals]);
    return removals.length;
  };
  adDetectDedupReleaserHolder.current = (chatId: number, senderId: number): void => {
    releasedDedupKeys.push({ chatId, senderId });
  };
});

afterEach((): void => {
  defaultAdDetectConfigCache.current = savedAdDetectCache;
  blockedMemberRemoverHolder.current = originalRemover;
  adDetectDedupReleaserHolder.current = originalDedupReleaser;
});

describe("handleAdDetected 处罚与黑名单自动持久化", () => {
  test("命中事件携带 adStickerPacks 与 adEmojiPacks 时同时执行全局封禁与黑名单持久化", async () => {
    handleAdDetected(createDetectedEvent({
      adStickerPacks: ["SpamStickerPack"],
      adEmojiPacks: ["SpamEmojiPack"],
    }));

    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(blockUser).toHaveBeenCalledTimes(1);
    expect(dispatchedRemovals).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(persistedPackCalls).toEqual([{
      stickerPacks: ["SpamStickerPack"],
      emojiPacks: ["SpamEmojiPack"],
    }]);
    expect(errorLogs).toHaveLength(0);
  });

  test("本群禁言处罚下同样触发黑名单持久化", async () => {
    adoptAdDetectConfig({
      punishment: { kind: "mute", durationMs: 30 * 60_000 },
      samples: ["测试样本"],
    });

    handleAdDetected(createDetectedEvent({
      adStickerPacks: ["MuteAdSticker"],
    }));

    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(muteChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    expect(persistedPackCalls).toEqual([{
      stickerPacks: ["MuteAdSticker"],
      emojiPacks: [],
    }]);
  });

  test("黑名单持久化抛错时记错误日志且绝不中断发送者处罚", async () => {
    const persistError: Error = new Error("unexpected persistence failure");
    persistAutoBlacklistedAdPacks.mockRejectedValueOnce(persistError);

    handleAdDetected(createDetectedEvent({
      adStickerPacks: ["FailingPack"],
    }));

    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(blockUser).toHaveBeenCalledTimes(1);
    expect(dispatchedRemovals).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toEqual([
      "Failed to persist auto-blacklisted ad packs:",
      { chatId: -1001, senderId: 7 },
      persistError,
    ]);
  });

  test("黑名单持久化耗时较长时不延迟发送者处罚，但 drainAdDisposals 等待其结算", async () => {
    let finishPersist: (() => void) | undefined;
    let persistStarted: boolean = false;
    persistAutoBlacklistedAdPacks.mockImplementationOnce(
      async (options: AutoBlacklistAdPacksOptions): Promise<void> => {
        persistStarted = true;
        persistedPackCalls.push(options);
        await new Promise<void>((resolve) => {
          finishPersist = resolve;
        });
      }
    );

    handleAdDetected(createDetectedEvent({
      adEmojiPacks: ["SlowEmojiPack"],
    }));

    // 让处罚链完成：此时持久化仍在挂起，但发送者封禁与播报必须已完成。
    for (let attempt: number = 0; attempt < 20 && sendMessage.mock.calls.length === 0; attempt++) {
      await Bun.sleep(5);
    }
    expect(persistStarted).toBeTrue();
    expect(blockUser).toHaveBeenCalledTimes(1);
    expect(dispatchedRemovals).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(inFlightAdDisposals.size).toBe(1);

    const drainPromise = drainAdDisposals(5_000);
    finishPersist!();
    expect(await drainPromise).toBe("flushed");
    expect(inFlightAdDisposals.size).toBe(0);
  });

  test("未携带包名、发送者受保护或群关闭广告检测时不触发黑名单持久化", async () => {
    // 未携带包名。
    handleAdDetected(createDetectedEvent());
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(blockUser).toHaveBeenCalledTimes(1);
    expect(persistedPackCalls).toHaveLength(0);

    // 受保护白名单成员。
    deleteMessages.mockClear();
    releasedDedupKeys.length = 0;
    handleAdDetected(createDetectedEvent({
      senderId: 100,
      adStickerPacks: ["ShouldNotPersistProtected"],
    }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(persistedPackCalls).toHaveLength(0);
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(releasedDedupKeys).toEqual([{ chatId: -1001, senderId: 100 }]);

    // 群关闭广告检测。
    releasedDedupKeys.length = 0;
    chatStates.set(-1001, chatStateOf({
      isAdDetectEnabled: false,
      isInitEnabled: true,
      botPermissions: botPermissions(),
    }));
    handleAdDetected(createDetectedEvent({
      adStickerPacks: ["ShouldNotPersistDisabled"],
    }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(persistedPackCalls).toHaveLength(0);
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(releasedDedupKeys).toEqual([{ chatId: -1001, senderId: 7 }]);
  });

  test("裁决通过后才在主线程按上限分批删除消息；缺删消息权限或批删失败只记错误日志，不中断处罚", async () => {
    const manyIds: number[] = Array.from(
      { length: TELEGRAM_DELETE_MESSAGES_BATCH_MAX + 5 },
      (_value: unknown, index: number): number => 1_000 + index
    );
    handleAdDetected(createDetectedEvent({ deleteMessageIds: manyIds }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");

    expect(deleteMessages).toHaveBeenCalledTimes(2);
    expect(deleteMessages.mock.calls[0]).toEqual([-1001, manyIds.slice(0, TELEGRAM_DELETE_MESSAGES_BATCH_MAX)]);
    expect(deleteMessages.mock.calls[1]).toEqual([-1001, manyIds.slice(TELEGRAM_DELETE_MESSAGES_BATCH_MAX)]);
    // 触发群移除批次已交给 Worker，由 blocklistEffects 负责释放处置抑制标记。
    expect(releasedDedupKeys).toEqual([]);

    // 确认缺少删消息权限时跳过删除请求并记错误日志，处罚仍照常完成。
    deleteMessages.mockClear();
    errorLogs.length = 0;
    adoptAdDetectConfig({
      punishment: { kind: "mute", durationMs: 30 * MINUTE_MS },
      samples: ["测试样本"],
    });
    chatStates.set(-1001, chatStateOf({
      isAdDetectEnabled: true,
      isInitEnabled: true,
      botPermissions: botPermissions({ canRestrictMembers: true, canDeleteMessages: false }),
    }));
    handleAdDetected(createDetectedEvent({ deleteMessageIds: [21, 22] }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");

    expect(deleteMessages).not.toHaveBeenCalled();
    expect(muteChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    expect(releasedDedupKeys).toEqual([{ chatId: -1001, senderId: 7 }]);
    expect(errorLogs).toContainEqual([
      "Ad disposal skipped deleting messages; the bot is known to lack can_delete_messages there.",
      { chatId: -1001, messageCount: 2 },
    ]);

    // 批量删除返回 false 时汇总一条权限诊断。
    deleteMessages.mockReset();
    deleteMessages.mockImplementation(async (): Promise<boolean> => false);
    errorLogs.length = 0;
    chatStates.set(-1001, chatStateOf({
      isAdDetectEnabled: true,
      isInitEnabled: true,
      botPermissions: botPermissions({ canRestrictMembers: true, canDeleteMessages: true }),
    }));
    handleAdDetected(createDetectedEvent({ deleteMessageIds: [31, 32] }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");

    expect(deleteMessages).toHaveBeenCalledTimes(1);
    expect(errorLogs).toContainEqual([
      expect.stringContaining("Ad disposal could not delete message batches"),
      { chatId: -1001, failedBatchCount: 1, messageCount: 2 },
    ]);
  });

  test("被拒裁决（永久白名单、移除配置、冷读失败）绝不删消息并立即释放 Worker 处置抑制标记", async () => {
    // 1. 永久白名单成员（含 isCanBypassAdDetection=false 的 101）。
    handleAdDetected(createDetectedEvent({ senderId: 101, deleteMessageIds: [11, 12] }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(releasedDedupKeys).toEqual([{ chatId: -1001, senderId: 101 }]);

    // 2. 热重载移除 ad_detect.json。
    releasedDedupKeys.length = 0;
    defaultAdDetectConfigCache.current = null;
    handleAdDetected(createDetectedEvent({ senderId: 7, deleteMessageIds: [14] }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(releasedDedupKeys).toEqual([{ chatId: -1001, senderId: 7 }]);

    // 3. 身份策略冷读失败。
    releasedDedupKeys.length = 0;
    adoptAdDetectConfig({
      punishment: { kind: "kick", blockScope: "global" },
      samples: ["测试样本"],
    });
    blocklistField.delete(7);
    whitelistField.delete(7);
    temporaryAdBypassField.delete(7);
    diskIOInitialized = true;
    handleAdDetected(createDetectedEvent({ senderId: 7, deleteMessageIds: [15] }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(releasedDedupKeys).toEqual([{ chatId: -1001, senderId: 7 }]);
  });

  test("本群处罚与未把触发群批次交回 Worker 的全局封禁，结算后立即释放 Worker 处置抑制标记", async () => {
    chatIsSupergroupById.set(-1001, true);
    for (const [punishment, overrides] of [
      [{ kind: "mute", durationMs: 30 * MINUTE_MS }, {}],
      [{ kind: "kick", blockScope: null }, {}],
      [{ kind: "kick", blockScope: "chat" }, {}],
      [{ kind: "mute", durationMs: null }, { senderId: -300, isChannel: true }],
    ] as const) {
      releasedDedupKeys.length = 0;
      adoptAdDetectConfig({
        punishment,
        samples: ["测试样本"],
      });
      const event: AdDetectedEvent = createDetectedEvent(overrides);
      handleAdDetected(event);
      expect(await drainAdDisposals(5_000)).toBe("flushed");
      expect(releasedDedupKeys).toEqual([{ chatId: -1001, senderId: event.senderId }]);
    }

    // 全局封禁仅对其他群登记成功、触发群未交回 Worker 时，由主线程释放处置抑制标记。
    releasedDedupKeys.length = 0;
    adoptAdDetectConfig({
      punishment: { kind: "kick", blockScope: "global" },
      samples: ["测试样本"],
    });
    chatStates.set(-1001, chatStateOf({
      isAdDetectEnabled: true,
      isInitEnabled: true,
      botPermissions: botPermissions({ isAdministrator: false, canManageChat: false }),
    }));
    chatStates.set(-1002, chatStateOf({
      isInitEnabled: true,
      botPermissions: botPermissions(),
    }));
    handleAdDetected(createDetectedEvent({ senderId: 7 }));
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(dispatchedRemovals[0]?.map((params: RemoveBlockedMembersParams): number => params.chatId)).toEqual([-1002]);
    expect(releasedDedupKeys).toEqual([{ chatId: -1001, senderId: 7 }]);
  });
});
