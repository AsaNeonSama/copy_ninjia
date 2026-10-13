/** `/delete_message` 的命令与群状态持久化、消息 ingress、待删队列、群 teardown、停机排空与启动互斥校验。 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "grammy/types";
import { loggerStub } from "../helpers/loggerMock";
import { botPermissions } from "../helpers/botPermissions";
import { replyCommandNoticeVia } from "../helpers/common";
import { groupCommandContext } from "../helpers/groupCommandContext";
import { lastReplyText } from "../helpers/replies";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import {
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  DELETE_MESSAGE_QUEUE_MAX,
} from "../../packages/consts/deleteMessage";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../packages/consts/telegram";
import { describeBotPermissionGap } from "../../packages/libs/botPermissionGap";
import { formatTargetLabel } from "../../packages/users/userLabel";
import type { CachedUser } from "../../packages/types/chatState";
import type { DeleteMessageAction } from "../../packages/types/deleteMessage";
import type { ResolveCommandTargetParams } from "../../packages/commands/targetResolution";
import type { BotChatPermissions } from "../../packages/types/telegram";

const SUPER_ADMIN_ID: number = 1;
const CHAT_ID: number = -1001;
const OTHER_CHAT_ID: number = -1002;
const TARGET: CachedUser = { id: 7, first_name: "Alice", username: "alice" };
const CHANNEL_TARGET: CachedUser = { id: -1009, title: "Spam Channel", isChannel: true };

interface CommandMessageParams {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
}

const sendCommandMessage = mock(async (_params: CommandMessageParams): Promise<number | undefined> => 55);
const deleteMessages = mock(async (_chatId: number, _messageIds: readonly number[]): Promise<boolean> => true);
const resolveCommandTarget = mock(
  async (_params: ResolveCommandTargetParams): Promise<CachedUser | undefined> => TARGET
);
const botChatPermissionsIn = mock(
  async (_chatId: number): Promise<BotChatPermissions | undefined> => botPermissions({ canDeleteMessages: true })
);
/** persistChatState 被调用那一刻本群的删除目标，按调用顺序。 */
const persistedTargets: (readonly number[] | undefined)[] = [];
const persistChatState = mock(async (_chatId: number, _context: string): Promise<void> => {});
const loggerWarn = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing",
  SUPER_ADMIN_USER_ID: SUPER_ADMIN_ID,
}));
mock.module("../../packages/infra/botAdmin", () => ({ botChatPermissionsIn }));
mock.module("../../packages/infra/telegram", () => ({
  deleteMessages,
  sendCommandMessage,
  replyCommandNotice: replyCommandNoticeVia(sendCommandMessage),
}));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ warn: loggerWarn, error: loggerError }),
}));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
const realStateStore = await import("../../packages/infra/storage/stateStore");
mock.module("../../packages/infra/storage/stateStore", () => ({ ...realStateStore, persistChatState }));

const {
  assertSuperAdminNotDeleteMessageTarget,
  handleDeleteMessageCommand,
  handleDeleteMessageIngress,
  parseDeleteMessageCommand,
} = await import("../../packages/commands/deleteMessage");
const {
  drainTargetMessageDeletions,
  resetTargetMessageDeletionQueue,
} = await import("../../packages/commands/deleteMessage/queue");
const {
  deleteMessageQueue,
  deleteMessageQueueRuntime,
} = await import("../../packages/cache/main/deleteMessage");
const { botAtmosphereState } = await import("../../packages/cache/main/atmosphere");
const { chatStateCache } = await import("../../packages/cache/main/chatState");
const { getChatState, getOrCreateChatState } = await import("../../packages/infra/storage/stateStore");
const { teardownRegisteredChat } = await import("../../packages/infra/chatTeardownRegistry");
const { currentUpdateAbortSignal, runWithUpdateAbortSignal } = await import("../../packages/infra/updateContext");

/** 本文件默认通知风格下的群提示文案表。 */
const TEXTS = ATMOSPHERE_TEXTS.teasing;
const NOTICES = TEXTS.NOTICE_TEXTS;

/** 未结束的挂起删除；afterEach 统一放行，保证消费循环在复位前结束。 */
const heldDeletions: (() => void)[] = [];

/** 让 deleteMessages 的下一次调用挂起，直到返回的放行函数被调用。 */
function holdNextDeletion(): () => void {
  const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  heldDeletions.push(resolve);
  deleteMessages.mockImplementationOnce(async (): Promise<boolean> => {
    await promise;
    return true;
  });
  return resolve;
}

interface GroupMessageParams {
  readonly messageId: number;
  readonly chatId?: number;
  readonly fromId?: number;
  readonly senderChatId?: number;
}

/** 群里的一条普通文字消息；缺省由 TARGET 在 CHAT_ID 发出。 */
function groupMessage({
  messageId,
  chatId = CHAT_ID,
  fromId = TARGET.id,
  senderChatId,
}: GroupMessageParams): Message {
  return {
    message_id: messageId,
    date: 1,
    chat: { id: chatId, type: "supergroup", title: "测试群" },
    from: { id: fromId, is_bot: false, first_name: "Someone" },
    ...(senderChatId === undefined ? {} : { sender_chat: { id: senderChatId, type: "channel", title: "Channel" } }),
    text: "hello",
  } as Message;
}

/** 超级管理员在 CHAT_ID 下的 `/delete_message` 命令上下文。 */
function commandContext(match: string, chatId: number = CHAT_ID): never {
  return groupCommandContext({ match, userId: SUPER_ADMIN_ID, chatId });
}

/** deleteMessages 收到的 (群, 消息 id 列表)，按调用顺序。 */
function deletionCalls(): (readonly [number, readonly number[]])[] {
  return deleteMessages.mock.calls.map(
    ([chatId, messageIds]: [number, readonly number[]]): readonly [number, readonly number[]] => [chatId, [...messageIds]]
  );
}

/** 本群当前的删除目标。 */
function targetsOf(chatId: number): readonly number[] | undefined {
  return getChatState(chatId).deleteMessageTargets;
}

/** 直接把删除目标写进群状态热读副本。 */
function armTargets(chatId: number, targets: readonly number[]): void {
  getOrCreateChatState(chatId).deleteMessageTargets = targets;
}

/** 连续的消息 id 区间 [from, to]。 */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_value: unknown, index: number): number => from + index);
}

const preloadedAtmosphere: typeof botAtmosphereState.current = botAtmosphereState.current;

beforeEach((): void => {
  botAtmosphereState.current = "teasing";
  chatStateCache.clear();
  getOrCreateChatState(CHAT_ID).isInitEnabled = true;
  getOrCreateChatState(OTHER_CHAT_ID).isInitEnabled = true;
  sendCommandMessage.mockReset();
  sendCommandMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  deleteMessages.mockReset();
  deleteMessages.mockImplementation(async (): Promise<boolean> => true);
  resolveCommandTarget.mockReset();
  resolveCommandTarget.mockImplementation(async (): Promise<CachedUser | undefined> => TARGET);
  botChatPermissionsIn.mockReset();
  botChatPermissionsIn.mockImplementation(
    async (): Promise<BotChatPermissions | undefined> => botPermissions({ canDeleteMessages: true })
  );
  persistChatState.mockReset();
  persistChatState.mockImplementation(async (chatId: number): Promise<void> => {
    persistedTargets.push(targetsOf(chatId));
  });
  persistedTargets.length = 0;
  loggerWarn.mockClear();
  loggerError.mockClear();
});

afterEach(async (): Promise<void> => {
  for (const release of heldDeletions.splice(0)) release();
  await drainTargetMessageDeletions(1_000);
  resetTargetMessageDeletionQueue();
  chatStateCache.clear();
  botAtmosphereState.current = preloadedAtmosphere;
});

describe("parseDeleteMessageCommand", () => {
  test.each<[string, DeleteMessageAction, string]>([
    ["", "start", ""],
    ["@alice", "start", "@alice"],
    ["  -1009  ", "start", "-1009"],
    ["stopper", "start", "stopper"],
    ["stop", "stop", ""],
    ["STOP @alice", "stop", "@alice"],
    ["  stop   123  ", "stop", "123"],
  ])("%p → %s %p", (match: string, action: DeleteMessageAction, rawTarget: string) => {
    expect(parseDeleteMessageCommand(match)).toEqual({ action, rawTarget });
  });
});

describe("/delete_message 命令", () => {
  test("非超级管理员被拒绝，不解析目标也不登记", async () => {
    await handleDeleteMessageCommand(groupCommandContext({ match: "@alice", userId: 100 }));

    expect(lastReplyText(sendCommandMessage)).toBe(NOTICES.deleteMessageRejected);
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(targetsOf(CHAT_ID)).toBeUndefined();
  });

  test("机器人没有删除消息权限时拒绝登记", async () => {
    const permissions: BotChatPermissions = botPermissions({ canDeleteMessages: false });
    botChatPermissionsIn.mockImplementation(async (): Promise<BotChatPermissions | undefined> => permissions);

    await handleDeleteMessageCommand(commandContext("@alice"));

    const gap: string | undefined = describeBotPermissionGap(permissions, "canDeleteMessages", NOTICES);
    expect(gap).toBeDefined();
    expect(lastReplyText(sendCommandMessage)).toBe(NOTICES.deleteMessageMissingRights(gap!));
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(targetsOf(CHAT_ID)).toBeUndefined();
  });

  test("登记目标：接受用户与频道 id，拒绝当前群身份，回执说明之前的消息不受影响", async () => {
    await handleDeleteMessageCommand(commandContext("@alice"));

    const params: ResolveCommandTargetParams = resolveCommandTarget.mock.calls[0]![0];
    expect(params).toMatchObject({
      chatId: CHAT_ID,
      botUserId: 999,
      rawArgument: "@alice",
      acceptUserId: true,
      acceptChatId: true,
      messages: TEXTS.DELETE_MESSAGE_TARGET_TEXTS,
      currentChatTargetText: NOTICES.deleteMessageCurrentChat,
    });
    expect(params.requireIdentityPolicies).toBeUndefined();
    expect(targetsOf(CHAT_ID)).toEqual([TARGET.id]);
    expect(lastReplyText(sendCommandMessage)).toBe(
      NOTICES.deleteMessageStarted(formatTargetLabel(TARGET, TEXTS))
    );
  });

  test("登记先写群状态再等落盘确认，确认之后才回执；落盘失败时不回执并上抛", async () => {
    const events: string[] = [];
    persistChatState.mockImplementation(async (chatId: number): Promise<void> => {
      events.push(`persist:${String(targetsOf(chatId))}`);
    });
    sendCommandMessage.mockImplementation(async (): Promise<number | undefined> => {
      events.push("reply");
      return 55;
    });

    await handleDeleteMessageCommand(commandContext("@alice"));
    expect(events).toEqual([`persist:${TARGET.id}`, "reply"]);
    expect(persistChatState.mock.calls[0]![0]).toBe(CHAT_ID);

    const failure: Error = new Error("flush failed");
    persistChatState.mockImplementation(async (): Promise<void> => {
      throw failure;
    });
    resolveCommandTarget.mockImplementation(async (): Promise<CachedUser | undefined> => CHANNEL_TARGET);
    events.length = 0;
    await expect(handleDeleteMessageCommand(commandContext(String(CHANNEL_TARGET.id)))).rejects.toBe(failure);
    expect(events).toEqual([]);
  });

  test("目标解析失败时不登记、不另发回执", async () => {
    resolveCommandTarget.mockImplementation(async (): Promise<CachedUser | undefined> => undefined);

    await handleDeleteMessageCommand(commandContext(""));

    expect(targetsOf(CHAT_ID)).toBeUndefined();
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("不能把超级管理员设为目标", async () => {
    resolveCommandTarget.mockImplementation(
      async (): Promise<CachedUser | undefined> => ({ id: SUPER_ADMIN_ID, first_name: "Root" })
    );

    await handleDeleteMessageCommand(commandContext(String(SUPER_ADMIN_ID)));

    expect(lastReplyText(sendCommandMessage)).toBe(NOTICES.deleteMessageSuperAdminTarget);
    expect(targetsOf(CHAT_ID)).toBeUndefined();
  });

  test("同一目标重复登记只回执已在删除", async () => {
    await handleDeleteMessageCommand(commandContext("@alice"));
    await handleDeleteMessageCommand(commandContext("@alice"));

    expect(lastReplyText(sendCommandMessage)).toBe(NOTICES.deleteMessageExists(formatTargetLabel(TARGET, TEXTS)));
    expect(targetsOf(CHAT_ID)).toEqual([TARGET.id]);
    expect(persistChatState).toHaveBeenCalledTimes(1);
  });

  test("每群目标达到上限后拒绝新目标，别的群不受影响", async () => {
    for (let index: number = 0; index < DELETE_MESSAGE_CHAT_TARGET_MAX; index++) {
      const target: CachedUser = { id: 1_000 + index, first_name: `User${index}` };
      resolveCommandTarget.mockImplementationOnce(async (): Promise<CachedUser | undefined> => target);
      await handleDeleteMessageCommand(commandContext(String(target.id)));
    }
    expect(targetsOf(CHAT_ID)).toHaveLength(DELETE_MESSAGE_CHAT_TARGET_MAX);

    await handleDeleteMessageCommand(commandContext("@alice"));
    expect(lastReplyText(sendCommandMessage)).toBe(NOTICES.deleteMessageCapacity(DELETE_MESSAGE_CHAT_TARGET_MAX));
    expect(targetsOf(CHAT_ID)).not.toContain(TARGET.id);
    expect(persistChatState).toHaveBeenCalledTimes(DELETE_MESSAGE_CHAT_TARGET_MAX);

    await handleDeleteMessageCommand(commandContext("@alice", OTHER_CHAT_ID));
    expect(targetsOf(OTHER_CHAT_ID)).toEqual([TARGET.id]);
  });

  test("目标解析期间本群已不再初始化时不登记、不回执", async () => {
    resolveCommandTarget.mockImplementation(async (): Promise<CachedUser | undefined> => {
      getOrCreateChatState(CHAT_ID).isInitEnabled = false;
      return TARGET;
    });

    await handleDeleteMessageCommand(commandContext("@alice"));

    expect(targetsOf(CHAT_ID)).toBeUndefined();
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("stop 撤销目标并落盘；最后一个目标撤销后字段回到缺省，未登记的目标回执不在删除且不落盘", async () => {
    armTargets(CHAT_ID, [TARGET.id, CHANNEL_TARGET.id]);

    await handleDeleteMessageCommand(commandContext("stop @alice"));
    const params: ResolveCommandTargetParams = resolveCommandTarget.mock.calls[0]![0];
    expect(params).toMatchObject({
      rawArgument: "@alice",
      acceptUserId: true,
      acceptChatId: true,
      messages: TEXTS.DELETE_MESSAGE_STOP_TARGET_TEXTS,
    });
    expect(params.currentChatTargetText).toBeUndefined();
    expect(lastReplyText(sendCommandMessage)).toBe(NOTICES.deleteMessageStopped(formatTargetLabel(TARGET, TEXTS)));
    expect(targetsOf(CHAT_ID)).toEqual([CHANNEL_TARGET.id]);
    expect(persistedTargets).toEqual([[CHANNEL_TARGET.id]]);

    await handleDeleteMessageCommand(commandContext("stop @alice"));
    expect(lastReplyText(sendCommandMessage)).toBe(NOTICES.deleteMessageAbsent(formatTargetLabel(TARGET, TEXTS)));
    expect(persistChatState).toHaveBeenCalledTimes(1);

    resolveCommandTarget.mockImplementation(async (): Promise<CachedUser | undefined> => CHANNEL_TARGET);
    await handleDeleteMessageCommand(commandContext(`stop ${CHANNEL_TARGET.id}`));
    expect(targetsOf(CHAT_ID)).toBeUndefined();
    expect(persistedTargets).toEqual([[CHANNEL_TARGET.id], undefined]);
  });
});

describe("消息 ingress 与待删队列", () => {
  test("本群没有目标、发送者不是目标或目标在别的群时不认领", async () => {
    expect(handleDeleteMessageIngress(groupMessage({ messageId: 1 }))).toBeFalse();
    armTargets(CHAT_ID, [TARGET.id]);
    expect(handleDeleteMessageIngress(groupMessage({ messageId: 2, fromId: 8 }))).toBeFalse();
    expect(handleDeleteMessageIngress(groupMessage({ messageId: 3, chatId: OTHER_CHAT_ID }))).toBeFalse();
    // 频道马甲发言按 sender_chat 判定，背后的 from 不算目标本人。
    expect(handleDeleteMessageIngress(groupMessage({ messageId: 4, senderChatId: CHANNEL_TARGET.id }))).toBeFalse();

    await drainTargetMessageDeletions(1_000);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  test("目标发一条就入队一条，空闲时当场经 deleteMessages 删除", async () => {
    armTargets(CHAT_ID, [TARGET.id, CHANNEL_TARGET.id]);

    expect(handleDeleteMessageIngress(groupMessage({ messageId: 11 }))).toBeTrue();
    expect(await drainTargetMessageDeletions(1_000)).toBe("flushed");
    expect(handleDeleteMessageIngress(groupMessage({ messageId: 12, fromId: 8, senderChatId: CHANNEL_TARGET.id }))).toBeTrue();
    expect(await drainTargetMessageDeletions(1_000)).toBe("flushed");

    expect(deletionCalls()).toEqual([[CHAT_ID, [11]], [CHAT_ID, [12]]]);
  });

  test("请求在途期间到达的消息按群的连续段合批，单批不超过 Telegram 上限", async () => {
    armTargets(CHAT_ID, [TARGET.id]);
    armTargets(OTHER_CHAT_ID, [TARGET.id]);
    const release: () => void = holdNextDeletion();
    handleDeleteMessageIngress(groupMessage({ messageId: 1 }));
    const lastBatchId: number = TELEGRAM_DELETE_MESSAGES_BATCH_MAX + 2;
    for (const messageId of range(2, lastBatchId)) handleDeleteMessageIngress(groupMessage({ messageId }));
    handleDeleteMessageIngress(groupMessage({ messageId: 500, chatId: OTHER_CHAT_ID }));
    handleDeleteMessageIngress(groupMessage({ messageId: 501, chatId: OTHER_CHAT_ID }));
    handleDeleteMessageIngress(groupMessage({ messageId: 600 }));

    release();
    expect(await drainTargetMessageDeletions(1_000)).toBe("flushed");

    expect(deletionCalls()).toEqual([
      [CHAT_ID, [1]],
      [CHAT_ID, range(2, TELEGRAM_DELETE_MESSAGES_BATCH_MAX + 1)],
      [CHAT_ID, [lastBatchId]],
      [OTHER_CHAT_ID, [500, 501]],
      [CHAT_ID, [600]],
    ]);
  });

  test("队列满时新消息照常认领但不入队，满队与排空各记一行 warn", async () => {
    armTargets(CHAT_ID, [TARGET.id]);
    const release: () => void = holdNextDeletion();
    handleDeleteMessageIngress(groupMessage({ messageId: 1 }));
    for (const messageId of range(2, DELETE_MESSAGE_QUEUE_MAX + 4)) {
      expect(handleDeleteMessageIngress(groupMessage({ messageId }))).toBeTrue();
    }
    expect(deleteMessageQueue.size).toBe(DELETE_MESSAGE_QUEUE_MAX);
    expect(loggerWarn).toHaveBeenCalledTimes(1);

    release();
    expect(await drainTargetMessageDeletions(1_000)).toBe("flushed");

    const deleted: number[] = deletionCalls().flatMap(([, messageIds]: readonly [number, readonly number[]]): readonly number[] => messageIds);
    expect(deleted).toEqual(range(1, DELETE_MESSAGE_QUEUE_MAX + 1));
    expect(loggerWarn).toHaveBeenCalledTimes(2);
    expect(String(loggerWarn.mock.calls[1]![0])).toContain("Dropped 3 ");
  });

  test("消费循环在队列自己的取消上下文里运行，不继承触发它的 update", async () => {
    armTargets(CHAT_ID, [TARGET.id]);
    const signals: (AbortSignal | undefined)[] = [];
    deleteMessages.mockImplementation(async (): Promise<boolean> => {
      signals.push(currentUpdateAbortSignal());
      return true;
    });
    const updateController: AbortController = new AbortController();

    await runWithUpdateAbortSignal(updateController.signal, async (): Promise<void> => {
      handleDeleteMessageIngress(groupMessage({ messageId: 21 }));
    });
    updateController.abort();
    handleDeleteMessageIngress(groupMessage({ messageId: 22 }));
    expect(await drainTargetMessageDeletions(1_000)).toBe("flushed");

    expect(deletionCalls()).toEqual([[CHAT_ID, [21]], [CHAT_ID, [22]]]);
    expect(signals).toEqual([deleteMessageQueueRuntime.controller.signal, deleteMessageQueueRuntime.controller.signal]);
  });

  test("群 teardown 撤销本群目标并落盘、摘掉本群尚未发出的条目，别的群照常删除", async () => {
    armTargets(CHAT_ID, [TARGET.id]);
    armTargets(OTHER_CHAT_ID, [TARGET.id]);
    const release: () => void = holdNextDeletion();
    handleDeleteMessageIngress(groupMessage({ messageId: 1 }));
    handleDeleteMessageIngress(groupMessage({ messageId: 2 }));
    handleDeleteMessageIngress(groupMessage({ messageId: 30, chatId: OTHER_CHAT_ID }));
    handleDeleteMessageIngress(groupMessage({ messageId: 3 }));
    handleDeleteMessageIngress(groupMessage({ messageId: 31, chatId: OTHER_CHAT_ID }));

    await teardownRegisteredChat("deleteMessage", CHAT_ID, "explicitDisable");
    expect(targetsOf(CHAT_ID)).toBeUndefined();
    expect(targetsOf(OTHER_CHAT_ID)).toEqual([TARGET.id]);
    expect(persistChatState.mock.calls.map(([chatId]: [number, string]): number => chatId)).toEqual([CHAT_ID]);
    expect(persistedTargets).toEqual([undefined]);
    expect(handleDeleteMessageIngress(groupMessage({ messageId: 4 }))).toBeFalse();

    // 本群已没有目标时，再次 teardown 不落盘。
    await teardownRegisteredChat("deleteMessage", CHAT_ID, "lostAuthority");
    expect(persistChatState).toHaveBeenCalledTimes(1);

    release();
    expect(await drainTargetMessageDeletions(1_000)).toBe("flushed");
    expect(deletionCalls()).toEqual([[CHAT_ID, [1]], [OTHER_CHAT_ID, [30, 31]]]);
  });
});

describe("停机排空", () => {
  test("空闲时立即 flushed；在途请求结算后才 flushed", async () => {
    expect(await drainTargetMessageDeletions(1_000)).toBe("flushed");
    armTargets(CHAT_ID, [TARGET.id]);
    const release: () => void = holdNextDeletion();
    handleDeleteMessageIngress(groupMessage({ messageId: 1 }));
    handleDeleteMessageIngress(groupMessage({ messageId: 2 }));

    let settled: string | undefined;
    const drained: Promise<void> = drainTargetMessageDeletions(1_000).then((result: string): void => {
      settled = result;
    });
    await Bun.sleep(0);
    expect(settled).toBeUndefined();

    release();
    await drained;
    expect(settled).toBe("flushed");
    expect(deletionCalls()).toEqual([[CHAT_ID, [1]], [CHAT_ID, [2]]]);
  });

  test("超出预算时整队丢弃并记错误，取消上下文中止后不再入队", async () => {
    armTargets(CHAT_ID, [TARGET.id]);
    const release: () => void = holdNextDeletion();
    handleDeleteMessageIngress(groupMessage({ messageId: 1 }));
    handleDeleteMessageIngress(groupMessage({ messageId: 2 }));
    handleDeleteMessageIngress(groupMessage({ messageId: 3 }));

    expect(await drainTargetMessageDeletions(10)).toBe("timedOut");
    expect(deleteMessageQueue.size).toBe(0);
    expect(deleteMessageQueueRuntime.controller.signal.aborted).toBeTrue();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(String(loggerError.mock.calls[0]![0])).toContain("dropped 2 ");

    // 目标的消息仍被认领，但不再入队。
    expect(handleDeleteMessageIngress(groupMessage({ messageId: 4 }))).toBeTrue();
    expect(deleteMessageQueue.size).toBe(0);
    release();
    expect(await drainTargetMessageDeletions(1_000)).toBe("flushed");
    expect(deletionCalls()).toEqual([[CHAT_ID, [1]]]);
  });
});

describe("启动互斥校验", () => {
  test("超级管理员出现在任一群的删除目标里时拒绝启动，错误写明行路径与字段路径", () => {
    armTargets(CHAT_ID, [TARGET.id]);
    expect((): void => assertSuperAdminNotDeleteMessageTarget(SUPER_ADMIN_ID)).not.toThrow();

    armTargets(OTHER_CHAT_ID, [TARGET.id, SUPER_ADMIN_ID]);
    expect((): void => assertSuperAdminNotDeleteMessageTarget(SUPER_ADMIN_ID)).toThrow(
      `chat_states[${OTHER_CHAT_ID}].status: $.deleteMessageTargets[1] must not be the configured super admin identity`
    );
  });
});
