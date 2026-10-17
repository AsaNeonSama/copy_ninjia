import type { FlushResult } from "../../packages/types/lifecycle";
import { createFlushBlocklistDomain, diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import type { IdentityStoragePersistedReply } from "../../packages/types/diskIO/replies";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { groupCommandContext } from "../helpers/groupCommandContext";
import { loggerStub } from "../helpers/loggerMock";
import { runWithUpdateAbortSignal } from "../../packages/infra/updateContext";
import type { CachedUser } from "../../packages/types/chatState";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import {
  blockedIdentityTestView as blockedUserIds,
  seedMissingIdentity,
} from "../helpers/identityStorage";
import { replyCommandNoticeVia } from "../helpers/common";
import { waitUntil } from "../helpers/waitUntil";

/** 管理员且有「限制与封禁成员」：/block disable 照常对这类群发解封请求。 */
const RESTRICT_PERMISSIONS: BotChatPermissions = botPermissions({ canRestrictMembers: true });
const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const unbanChatMemberIfBanned = mock(async (..._args: unknown[]): Promise<boolean> => true);
const unbanChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
const resolveBotAdminStatus = mock(async (_chatId: number): Promise<boolean> => false);
const chatStates: Map<number, { isInitEnabled?: boolean; botPermissions?: BotChatPermissions }> = new Map<
  number,
  { isInitEnabled?: boolean; botPermissions?: BotChatPermissions }
>();
let target: CachedUser | undefined;
/**
 * 与生产同构的桩：预热身份名单后，传了 currentChatTargetText 的调用在这一层挡下
 * 「当前群自己的频道身份」（见 commands/targetResolution.ts），命令侧只负责把文案
 * 传进来。真实闸的用例在 test/commands/targetResolution.test.ts。
 */
const resolveCommandTarget = mock(async (
  params: { chatId: number; message: { message_id: number }; currentChatTargetText?: string }
): Promise<CachedUser | undefined> => {
  if (target === undefined) return target;
  seedMissingIdentity(target.id);
  if (params.currentChatTargetText !== undefined && target.isChannel === true && target.id === params.chatId) {
    await sendMessage({ chatId: params.chatId, text: params.currentChatTargetText, replyToMessageId: params.message.message_id });
    return undefined;
  }
  return target;
});
const loggerError = mock((..._args: unknown[]): void => {});
const postDiskIO = mock((..._args: unknown[]): boolean => true);
const flushDiskIO = mock(async (): Promise<FlushResult> => "flushed");
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
/** 为 false 时 flush 成功也不回执身份写入，模拟 Worker 尚未提交这批事务。 */
const identityAck: { enabled: boolean } = { enabled: true };
const flushBlocklistDomain = createFlushBlocklistDomain({
  flushDiskIO,
  postDiskIO,
  listeners: persistedListeners,
  identityAck,
});

mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing", SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError }),
}));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  isWhitelisted: (id: number): boolean => id === 1 || id === 100,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 || (id === 100 && key === "isCanUnBlock"),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
  replyCommandNotice: replyCommandNoticeVia(sendMessage),
  unbanChatMemberIfBanned,
  unbanChatSenderChat,
}));
mock.module("../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  telegramApi: { kind: "guard-api" },
}));
mock.module("../../packages/infra/botAdmin", () => ({
  resolveBotAdminStatus,
  // 与生产同构：读各群 ChatState 里的权限快照，没有记录即未知。
  botCanRestrictMembersIn: (chatId: number): boolean | undefined =>
    chatStates.get(chatId)?.botPermissions?.canRestrictMembers,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (): Record<string, never> => ({}), getChatStateCache: () => chatStates }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  relayLogMessage: (): boolean => true,
  // 身份表的确认等精确 revision ACK（flushBlocklistDomain），其余领域只看 flush 结果。
  flushDiskIODomain: async (domain: string): Promise<{ result: FlushResult }> =>
    domain === "blocklist" || domain === "whitelist" ? flushBlocklistDomain() : { result: await flushDiskIO() },
  onDiskIOReply: diskIOReplyStub({
    identityStoragePersisted: (listener: (reply: IdentityStoragePersistedReply) => void): void => {
      persistedListeners.push(listener);
    },
  }),
  flushDiskIO,
})));

const { handleBlockDisable } = await import("../../packages/commands/unblock");
const { formatTargetLabel } = await import("../../packages/users/userLabel");

/** `/block <目标> disable` 经 handleBlockCommand 去掉末位动作后交给解除流程的形态。 */
function handleUnblockCommand(ctx: never): Promise<void> {
  return handleBlockDisable(ctx, (ctx as { match: string }).match);
}
const { blocklistIdentityMutationQueues } = await import("../../packages/cache/main/blocklist");

function context(userId: number = 100, match: string = "@alice"): never {
  return groupCommandContext({ userId, match });
}

beforeEach(() => {
  target = { id: 7, first_name: "Alice", username: "alice" };
  chatStates.clear();
  blockedUserIds.clear();
  blocklistIdentityMutationQueues.clear();
  for (const mocked of [
    sendMessage,
    resolveCommandTarget,
    postDiskIO,
    flushDiskIO,
    unbanChatSenderChat,
    loggerError,
  ]) mocked.mockClear();
  unbanChatMemberIfBanned.mockReset();
  resolveBotAdminStatus.mockReset();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  postDiskIO.mockImplementation((): boolean => true);
  flushDiskIO.mockImplementation(async (): Promise<FlushResult> => "flushed");
  identityAck.enabled = true;
  unbanChatMemberIfBanned.mockImplementation(async (): Promise<boolean> => true);
  unbanChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  resolveBotAdminStatus.mockImplementation(async (): Promise<boolean> => false);
});

describe("/block disable", () => {
  test("非授权身份不解析目标也不改名单", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    await handleUnblockCommand(context(101));
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(blockedUserIds.has(7)).toBeTrue();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unblockRejected("@admin"),
      replyToMessageId: 10,
    });
  });

  test("解析不出发起身份时同样拒绝，标签退化为未知发起人", async () => {
    const ctx = context() as unknown as { from?: object };
    delete ctx.from;
    await handleUnblockCommand(ctx as never);
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unblockRejected(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unknownActor),
      replyToMessageId: 10,
    });
  });

  test("从 SQLite 视图移除后在所有管理员群解除真人封禁", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: RESTRICT_PERMISSIONS });
    resolveBotAdminStatus.mockResolvedValueOnce(true);

    await handleUnblockCommand(context());

    expect(blockedUserIds.has(7)).toBeFalse();
    expect(unbanChatMemberIfBanned.mock.calls.map((call): unknown[] => call)).toEqual([
      [-1001, 7],
      [-2002, 7],
    ]);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("2 个群"),
    }));
  });

  test("tombstone 没收到精确 revision ACK 时回执说破；再次解除补投同一 tombstone，仍未确认照样说破，确认后不再补投", async () => {
    const warning: string = ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unblockPersistFailed;
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    identityAck.enabled = false;

    await handleUnblockCommand(context());

    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining(warning) }));

    // 名单里已没有目标：补投仍未确认时，「本来就不在」的回执同样带警告。
    await handleUnblockCommand(context());

    expect(postDiskIO).toHaveBeenCalledTimes(2);
    expect(postDiskIO.mock.calls[1]![0]).toEqual(postDiskIO.mock.calls[0]![0]);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining(warning) }));

    identityAck.enabled = true;
    await handleUnblockCommand(context());

    expect(postDiskIO).toHaveBeenCalledTimes(3);
    expect(postDiskIO.mock.calls[2]![0]).toEqual(postDiskIO.mock.calls[0]![0]);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.not.objectContaining({ text: expect.stringContaining(warning) }));

    // 已确认之后没有未 ACK 最终值，再解除不补投。
    await handleUnblockCommand(context());
    expect(postDiskIO).toHaveBeenCalledTimes(3);
  });

  test("跨群解封与连坐同一清单：是管理员但未 /init enable 的群不解封", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: RESTRICT_PERMISSIONS });
    chatStates.set(-3003, { botPermissions: RESTRICT_PERMISSIONS });
    resolveBotAdminStatus.mockResolvedValueOnce(true);

    await handleUnblockCommand(context());

    expect(unbanChatMemberIfBanned.mock.calls.map((call): unknown => call[0])).toEqual([-1001, -2002]);
  });

  test("权限快照已确证缺封禁权限的群不发解封请求，计为失败", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: botPermissions({ canRestrictMembers: false }) });
    chatStates.set(-3003, { isInitEnabled: true, botPermissions: RESTRICT_PERMISSIONS });

    await handleUnblockCommand(context());

    expect(unbanChatMemberIfBanned.mock.calls.map((call): unknown => call[0])).toEqual([-3003]);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringMatching(/在 1 个群把封禁一并解开了.*还有 1 个群没解开/),
    }));
  });

  test("目标名单预热失败由解析层拒绝：不回「本来就不在小本本上」，也不跨群解封", async () => {
    // unblockUser 按名单结论决定是否写 tombstone，冷读失败时不当成「不在名单」。
    target = undefined;
    resolveBotAdminStatus.mockResolvedValue(true);

    await handleUnblockCommand(context(1, "777"));

    expect(resolveCommandTarget).toHaveBeenCalledWith(expect.objectContaining({ requireIdentityPolicies: true }));
    expect(postDiskIO).not.toHaveBeenCalled();
    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("频道身份使用 unbanChatSenderChat，裸负 ID 可直接解除", async () => {
    target = { id: -4004, title: "Channel", isChannel: true };
    blockedUserIds.set(-4004, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    resolveBotAdminStatus.mockResolvedValueOnce(true);

    await handleUnblockCommand(context(1, "-4004"));

    expect(unbanChatSenderChat).toHaveBeenCalledWith(-1001, -4004);
    expect(blockedUserIds.has(-4004)).toBeFalse();
  });

  test("当前群自己的 sender_chat 身份仍在破坏性操作闸前拒绝", async () => {
    target = { id: -1001, title: "Current", isChannel: true };
    blockedUserIds.set(-1001, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    await handleUnblockCommand(context(1, "-1001"));

    expect(blockedUserIds.has(-1001)).toBeTrue();
    expect(unbanChatSenderChat).not.toHaveBeenCalled();
  });

  test("单群意外 rejection 只算这一个群失败，不掀掉其余群的解封", async () => {
    // 扇出与 /block 共用 runManagedChatBatch：常规 API 错误由适配层归一化成 false，能抛到这里的是意外异常；
    // 逐项结算，不让整条命令连同战报一起失败。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: RESTRICT_PERMISSIONS });
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    unbanChatMemberIfBanned
      .mockRejectedValueOnce(new Error("unexpected adapter rejection"))
      .mockResolvedValueOnce(true);

    await handleUnblockCommand(context());

    expect(unbanChatMemberIfBanned).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringMatching(/在 1 个群把封禁一并解开了.*还有 1 个群没解开/),
    }));
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error while running lift the ban on identity 7 in chat -1001"),
      expect.any(Error)
    );
  });

  test("update 被取消时各群的取消不逐群记意外错误，整条命令以取消解开", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: RESTRICT_PERMISSIONS });
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    const controller: AbortController = new AbortController();
    unbanChatMemberIfBanned.mockImplementation(async (): Promise<boolean> => {
      controller.abort(new DOMException("shutdown", "AbortError"));
      throw controller.signal.reason;
    });

    await expect(runWithUpdateAbortSignal(
      controller.signal,
      (): Promise<void> => handleUnblockCommand(context())
    )).rejects.toThrow("shutdown");

    expect(unbanChatMemberIfBanned).toHaveBeenCalledTimes(2);
    expect(loggerError).not.toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error while running"),
      expect.anything()
    );
  });

  test("机器人不在任何群担任管理员：按名单结论回无受管群文案，不发解封请求", async () => {
    const notices = ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS;
    const label: string = formatTargetLabel(target!, ATMOSPHERE_TEXTS.teasing);
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    await handleUnblockCommand(context());
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      replyToMessageId: 10,
      text: notices.unblockNoManagedChat(notices.unblockRecorded(label, "")),
    });

    sendMessage.mockClear();
    seedMissingIdentity(7);
    await handleUnblockCommand(context());
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      replyToMessageId: 10,
      text: notices.unblockNoManagedChat(notices.unblockNotRecorded(label, "")),
    });
    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
    expect(unbanChatSenderChat).not.toHaveBeenCalled();
  });

  test("跨群解封与回执交给延迟命令执行器后台档：名单在 update 内解除，update 不等解封", async () => {
    const { drainDeferredCommandRuntime, initDeferredCommandRuntime } = await import("../../packages/commands/deferredCommands");
    initDeferredCommandRuntime();
    try {
      blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
      resolveBotAdminStatus.mockResolvedValueOnce(true);
      const unbanGate: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
      unbanChatMemberIfBanned.mockImplementationOnce(async (): Promise<boolean> => unbanGate.promise);

      await handleUnblockCommand(context());

      // handler 已返回：名单已解除，解封仍在后台等待，回执还没发。
      expect(blockedUserIds.has(7)).toBeFalse();
      await waitUntil((): boolean => unbanChatMemberIfBanned.mock.calls.length > 0);
      expect(sendMessage).not.toHaveBeenCalled();
      unbanGate.resolve(true);
      expect(await drainDeferredCommandRuntime(1_000)).toBe("flushed");
      expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        chatId: -1001,
        replyToMessageId: 10,
        text: expect.stringContaining("1 个群"),
      }));
    } finally {
      await drainDeferredCommandRuntime(0);
    }
  });

  test("同身份更早的处置还在串行位上时 update 不等它，名单解除排在它之后", async () => {
    const { drainDeferredCommandRuntime, initDeferredCommandRuntime } = await import("../../packages/commands/deferredCommands");
    const { blocklistIdentityMutationRunner } = await import("../../packages/cache/main/blocklist");
    initDeferredCommandRuntime();
    try {
      blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
      const earlier: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      void blocklistIdentityMutationRunner.run(7, (): Promise<void> => earlier.promise);

      await handleUnblockCommand(context());

      // 更早的处置（如 /block enable 的扇出或广告处置）没结算前名单不动。
      expect(blockedUserIds.has(7)).toBeTrue();
      earlier.resolve();
      expect(await drainDeferredCommandRuntime(1_000)).toBe("flushed");
      expect(blockedUserIds.has(7)).toBeFalse();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      await drainDeferredCommandRuntime(0);
    }
  });

  test("名单原本不存在仍执行 Telegram 解封，但不排队数据库 tombstone", async () => {
    seedMissingIdentity(7);
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    await handleUnblockCommand(context());
    expect(unbanChatMemberIfBanned).toHaveBeenCalledTimes(1);
    expect(postDiskIO).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "identityPolicyWrite",
    }));
  });
});
