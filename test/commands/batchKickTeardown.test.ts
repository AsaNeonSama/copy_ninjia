import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { groupCommandContext } from "../helpers/groupCommandContext";
import { replyCommandNoticeVia } from "../helpers/common";
import { loggerStub } from "../helpers/loggerMock";
import {
  installMiniAppTestDiskIOMock,
  miniAppTestJoinLogState,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";
import type { MiniAppBatchKickCompletion, MiniAppBatchKickResult } from "../../packages/types/miniApp";
import type { InstalledTelegramApi } from "../../packages/types/telegramWorker";

/**
 * `/batch_kick` 完成结果、预检登记与在途序号的群生命周期及并发/撤销清理：
 * 删数据类 teardown（`explicitDisable`、`departed`、`gone`）与群内 `/init disable` 清除本群状态，
 * `lostAuthority` 保留；预检期关群重开、并发 API 请求与排队撤销/停机取消均保持单飞且不残留登记。
 */

installMiniAppTestDiskIOMock();

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
let probeGate: Promise<void> | null = null;
mock.module("../../packages/antiRaid/workerBridge/controller", () => ({
  postAntiRaid: (): boolean => true,
  deactivateAntiRaidChat: (): void => {},
}));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub(),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
  replyCommandNotice: replyCommandNoticeVia(sendMessage),
  probeChatMembership: async (): Promise<boolean> => {
    if (probeGate !== null) await probeGate;
    return false;
  },
  kickChatMemberWithOutcome: async (): Promise<string> => "absent",
  banChatMemberWithOutcome: async (): Promise<string> => "absent",
}));

await import("../../packages/commands/batchKick");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { DEFERRED_COMMAND_MAX_CONCURRENT } = await import("../../packages/consts/deferredCommands");
const { chatIsSupergroupById } = await import("../../packages/cache/main/antiRaid/chatKind");
const {
  batchKickChats,
  batchKickPreflightSeqsByChat,
  miniAppBatchKickCompletedByChat,
  miniAppBatchKickInFlightSeqByChat,
} = await import("../../packages/cache/main/batchKick");
const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const {
  drainDeferredCommandRuntime,
  initDeferredCommandRuntime,
  submitDeferredCommand,
} = await import("../../packages/commands/deferredCommands");
const { handleInitCommand } = await import("../../packages/commands/init");
const { disableManagedChat } = await import("../../packages/infra/botAdmin");
const { teardownChatRuntime } = await import("../../packages/infra/chatTeardown");
const { getOrCreateChatState } = await import("../../packages/infra/storage/stateStore");
const { runWithUpdateAbortSignal } = await import("../../packages/infra/updateContext");
const { triggerManagedChatBatchKick } = await import(
  "../../packages/mini-app-api-server/view/chats/batchKick"
);

/** 构造一份批踢完成结果夹具。 */
function sampleCompletion(kicked: number = 3): Readonly<MiniAppBatchKickCompletion> {
  return {
    hours: 2,
    recordCount: kicked,
    scanned: kicked,
    kicked,
    absent: 0,
    protected: 0,
    blocked: 0,
    forbidden: 0,
    failed: 0,
    aborted: false,
    unmanaged: false,
    completedAt: 1_700_000_000_000,
  };
}

beforeEach((): void => {
  sendMessage.mockClear();
  probeGate = null;
  initDeferredCommandRuntime();
  batchKickChats.clear();
  batchKickPreflightSeqsByChat.clear();
  chatIsSupergroupById.clear();
  miniAppBatchKickCompletedByChat.clear();
  miniAppBatchKickInFlightSeqByChat.clear();
  telegramApiState.current = null;
  resetChatStateCache();
});

afterEach(async (): Promise<void> => {
  probeGate = null;
  await drainDeferredCommandRuntime(1_000);
  batchKickChats.clear();
  batchKickPreflightSeqsByChat.clear();
  chatIsSupergroupById.clear();
  miniAppBatchKickCompletedByChat.clear();
  miniAppBatchKickInFlightSeqByChat.clear();
  telegramApiState.current = null;
  resetMiniAppTestDiskIOState();
  resetChatStateCache();
});

describe("batchKick 完成结果的群 teardown 与关群清理", () => {
  test("explicitDisable、departed、gone 删除本群完成结果、预检登记与在途登记且不影响其它群，lostAuthority 保留", async () => {
    const targetChatId: number = -1_008_001;
    const siblingChatId: number = -1_008_002;
    miniAppBatchKickCompletedByChat.set(siblingChatId, sampleCompletion(5));
    miniAppBatchKickInFlightSeqByChat.set(siblingChatId, 99);
    batchKickPreflightSeqsByChat.set(siblingChatId, new Set([88]));

    miniAppBatchKickCompletedByChat.set(targetChatId, sampleCompletion(2));
    miniAppBatchKickInFlightSeqByChat.set(targetChatId, 11);
    batchKickPreflightSeqsByChat.set(targetChatId, new Set([7]));
    await teardownChatRuntime(targetChatId, "lostAuthority");
    expect(miniAppBatchKickCompletedByChat.get(targetChatId)?.kicked).toBe(2);
    expect(miniAppBatchKickInFlightSeqByChat.get(targetChatId)).toBe(11);
    expect(batchKickPreflightSeqsByChat.get(targetChatId)?.has(7)).toBeTrue();
    expect(miniAppBatchKickCompletedByChat.get(siblingChatId)?.kicked).toBe(5);
    expect(miniAppBatchKickInFlightSeqByChat.get(siblingChatId)).toBe(99);
    expect(batchKickPreflightSeqsByChat.get(siblingChatId)?.has(88)).toBeTrue();

    for (const reason of ["explicitDisable", "departed", "gone"] as const) {
      miniAppBatchKickCompletedByChat.set(targetChatId, sampleCompletion(4));
      miniAppBatchKickInFlightSeqByChat.set(targetChatId, 12);
      batchKickPreflightSeqsByChat.set(targetChatId, new Set([9]));
      await teardownChatRuntime(targetChatId, reason);
      expect(miniAppBatchKickCompletedByChat.has(targetChatId)).toBeFalse();
      expect(miniAppBatchKickInFlightSeqByChat.has(targetChatId)).toBeFalse();
      expect(batchKickPreflightSeqsByChat.has(targetChatId)).toBeFalse();
      expect(miniAppBatchKickCompletedByChat.get(siblingChatId)?.kicked).toBe(5);
      expect(miniAppBatchKickInFlightSeqByChat.get(siblingChatId)).toBe(99);
      expect(batchKickPreflightSeqsByChat.get(siblingChatId)?.has(88)).toBeTrue();
    }
  });

  test("群内执行 /init disable 后删除本群批踢完成结果", async () => {
    const chatId: number = -1_008_003;
    getOrCreateChatState(chatId).isInitEnabled = true;
    miniAppBatchKickCompletedByChat.set(chatId, sampleCompletion(6));

    await handleInitCommand(
      groupCommandContext({
        match: "disable",
        userId: SUPER_ADMIN_USER_ID,
        chatId,
        messageId: 19,
      }) as never
    );

    expect(miniAppBatchKickCompletedByChat.has(chatId)).toBeFalse();
  });

  test("API 预检 getChat 在途期间经历「关群 → 重开 /init」时拒绝提交旧批次且不污染新生命周期", async () => {
    const chatId: number = -1_008_004;
    getOrCreateChatState(chatId).isInitEnabled = true;
    miniAppTestJoinLogState.records = [{ userId: 9001, joinedAt: Date.now() - 5_000 }];

    const getChatEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const releaseGetChat: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    telegramApiState.current = {
      getChat: async (cId: number): Promise<unknown> => {
        getChatEntered.resolve();
        await releaseGetChat.promise;
        return { id: cId, type: "supergroup", title: "预检测试群" };
      },
    } as unknown as InstalledTelegramApi;

    const pendingTrigger: Promise<Readonly<MiniAppBatchKickResult>> =
      triggerManagedChatBatchKick(chatId, 2);
    await getChatEntered.promise;
    expect(batchKickPreflightSeqsByChat.has(chatId)).toBeTrue();

    expect(await disableManagedChat(chatId)).toBeFalse();
    getOrCreateChatState(chatId).isInitEnabled = true;

    releaseGetChat.resolve();
    const result: Readonly<MiniAppBatchKickResult> = await pendingTrigger;
    expect(result.outcome).toBe("notInitialized");
    expect(result.detail).toBeNull();
    expect(batchKickChats.has(chatId)).toBeFalse();
    expect(batchKickPreflightSeqsByChat.has(chatId)).toBeFalse();
    expect(miniAppBatchKickInFlightSeqByChat.has(chatId)).toBeFalse();
    expect(miniAppBatchKickCompletedByChat.has(chatId)).toBeFalse();
  });

  test("同群并发两次 API /batch_kick 跨越异步预检时严格单飞：仅首笔 accepted、次笔 running", async () => {
    const chatId: number = -1_008_005;
    getOrCreateChatState(chatId).isInitEnabled = true;
    miniAppTestJoinLogState.records = [{ userId: 9002, joinedAt: Date.now() - 5_000 }];

    const holdProbe: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    probeGate = holdProbe.promise;
    const releaseGetChat: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    let getChatCalls: number = 0;
    const bothEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    telegramApiState.current = {
      getChat: async (cId: number): Promise<unknown> => {
        getChatCalls += 1;
        if (getChatCalls === 2) bothEntered.resolve();
        await releaseGetChat.promise;
        return { id: cId, type: "supergroup", title: "并发预检群" };
      },
    } as unknown as InstalledTelegramApi;

    const first: Promise<Readonly<MiniAppBatchKickResult>> = triggerManagedChatBatchKick(chatId, 2);
    const second: Promise<Readonly<MiniAppBatchKickResult>> = triggerManagedChatBatchKick(chatId, 4);
    await bothEntered.promise;
    releaseGetChat.resolve();

    const res1: Readonly<MiniAppBatchKickResult> = await first;
    const res2: Readonly<MiniAppBatchKickResult> = await second;
    const outcomes: string[] = [res1.outcome, res2.outcome].sort();
    expect(outcomes).toEqual(["accepted", "running"]);
    expect(batchKickPreflightSeqsByChat.has(chatId)).toBeFalse();
    expect(miniAppBatchKickInFlightSeqByChat.has(chatId)).toBeTrue();

    holdProbe.resolve();
    for (let turn: number = 0; turn < 20 && batchKickChats.has(chatId); turn += 1) {
      await Bun.sleep(10);
    }
    expect(miniAppBatchKickInFlightSeqByChat.has(chatId)).toBeFalse();
    expect(miniAppBatchKickCompletedByChat.get(chatId)?.absent).toBe(1);
  });

  test("API 批次在排队期被撤销或执行期停机取消时清理 miniAppBatchKickInFlightSeqByChat", async () => {
    const chatId: number = -1_008_006;
    getOrCreateChatState(chatId).isInitEnabled = true;
    chatIsSupergroupById.set(chatId, true);
    miniAppTestJoinLogState.records = [{ userId: 9003, joinedAt: Date.now() - 5_000 }];

    // 1. 占满并发槽使 API 批次进入 background 排队，随后零预算排空触发 onSkipped。
    const blocker: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    for (let index: number = 0; index < DEFERRED_COMMAND_MAX_CONCURRENT; index += 1) {
      expect(
        submitDeferredCommand({
          priority: "interactive",
          task: (): Promise<void> => blocker.promise,
          errorLabel: "test-slot:",
        })
      ).toBeTrue();
    }
    const queuedResult: Readonly<MiniAppBatchKickResult> = await triggerManagedChatBatchKick(chatId, 2);
    expect(queuedResult.outcome).toBe("accepted");
    expect(miniAppBatchKickInFlightSeqByChat.has(chatId)).toBeTrue();

    await drainDeferredCommandRuntime(0);
    await Bun.sleep(0);
    expect(batchKickChats.has(chatId)).toBeFalse();
    expect(miniAppBatchKickInFlightSeqByChat.has(chatId)).toBeFalse();
    expect(miniAppBatchKickCompletedByChat.has(chatId)).toBeFalse();
    blocker.resolve();
    await drainDeferredCommandRuntime(1_000);

    // 2. 重新初始化执行器，在批次执行期间触发 AbortSignal 取消（completedStats === null）。
    initDeferredCommandRuntime();
    const controller: AbortController = new AbortController();
    const abortOnProbe: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    probeGate = abortOnProbe.promise.then((): never => {
      controller.abort(new DOMException("shutdown", "AbortError"));
      throw controller.signal.reason;
    });
    const abortedResult: Readonly<MiniAppBatchKickResult> = await runWithUpdateAbortSignal(
      controller.signal,
      (): Promise<Readonly<MiniAppBatchKickResult>> => triggerManagedChatBatchKick(chatId, 2)
    );
    expect(abortedResult.outcome).toBe("accepted");
    expect(miniAppBatchKickInFlightSeqByChat.has(chatId)).toBeTrue();
    abortOnProbe.resolve();
    await drainDeferredCommandRuntime(1_000);
    expect(batchKickChats.has(chatId)).toBeFalse();
    expect(miniAppBatchKickInFlightSeqByChat.has(chatId)).toBeFalse();
    expect(miniAppBatchKickCompletedByChat.has(chatId)).toBeFalse();
  });
});
