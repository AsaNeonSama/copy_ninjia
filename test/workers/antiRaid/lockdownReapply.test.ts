/** 私密模式 API 执行层（`lockdownApi.ts`）：纠偏、公告 onSent 登记与清理失败、提交写权限失败边界。 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatFullInfo, ChatPermissions } from "grammy/types";
import type { LockdownMachineEvent, LockdownState } from "../../../packages/types/states/lockdown";
import { loggerStub } from "../../helpers/loggerMock";

interface SendMessageMockParams {
  readonly chatId: number;
  readonly text: string;
  readonly onSent?: (messageId: number) => void;
}

const CHAT_ID: number = -1007;
const permissionWrites: ChatPermissions[] = [];
const deletedCalls: { readonly chatId: number; readonly messageId: number }[] = [];
const loggedErrors: unknown[][] = [];
let chatInfo: Partial<ChatFullInfo> = {};
let getChatCalls: number = 0;
let onGetChat: (() => void) | undefined;

const deleteMessage = mock(async (chatId: number, messageId: number): Promise<boolean> => {
  deletedCalls.push({ chatId, messageId });
  return true;
});
const sendMessage = mock(async (_params: SendMessageMockParams): Promise<number | undefined> => 1);
const setChatPermissions = mock(async (_chatId: number, permissions: ChatPermissions): Promise<true> => {
  permissionWrites.push(permissions);
  return true;
});

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error(...args: unknown[]): void { loggedErrors.push(args); } }),
}));
mock.module("../../../packages/infra/telegram", () => ({
  deleteMessage,
  sendMessage,
  telegramApi: {
    getChat: async (): Promise<Partial<ChatFullInfo>> => {
      getChatCalls++;
      onGetChat?.();
      return chatInfo;
    },
    setChatPermissions,
  },
}));
mock.module("../../../packages/workers/antiRaid/taskTracker", () => ({
  trackAntiRaidTask: ({ task }: { task: Promise<void> }): Promise<void> => task,
}));

const { lockdownApiChains, lockdownEntries } = await import("../../../packages/cache/workers/antiRaid/lockdown");
const {
  beginLockdownAnnouncement,
  commitApplyLockdown,
  deleteLockdownAnnouncement,
  reapplyLockdownRestriction,
} = await import("../../../packages/workers/antiRaid/lockdownApi");

const dispatched: LockdownMachineEvent[] = [];

function reconcilingState(): LockdownState {
  return {
    kind: "reconciling",
    originalPermissions: { can_invite_users: true },
    intentId: 1,
    reapplyAfterPersist: false,
    announced: false,
    announcementPending: false,
    announcementMessageId: undefined,
  };
}

function preparedApplyingState(intentId: number = 11): LockdownState {
  return {
    kind: "applying",
    stage: "prepared",
    originalPermissions: { can_invite_users: true },
    intentId,
    commitStarted: false,
    announced: false,
    announcementPending: false,
    announcementMessageId: undefined,
  };
}

async function drain(): Promise<void> {
  for (let round: number = 0; round < 20; round++) {
    await Promise.resolve();
    const pending: Promise<void> | undefined = lockdownApiChains.get(CHAT_ID);
    if (pending === undefined) return;
    await pending;
  }
}

function lockdownEntry(state: LockdownState = reconcilingState()): Parameters<typeof lockdownEntries.set>[1] {
  return {
    state,
    restoreTimer: undefined,
    retryTimer: undefined,
    restoreAt: undefined,
    restorePermanentFailures: 0,
  };
}

beforeEach((): void => {
  getChatCalls = 0;
  onGetChat = undefined;
  permissionWrites.length = 0;
  deletedCalls.length = 0;
  loggedErrors.length = 0;
  dispatched.length = 0;
  deleteMessage.mockReset();
  deleteMessage.mockImplementation(async (chatId: number, messageId: number): Promise<boolean> => {
    deletedCalls.push({ chatId, messageId });
    return true;
  });
  sendMessage.mockReset();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 1);
  setChatPermissions.mockReset();
  setChatPermissions.mockImplementation(async (_chatId: number, permissions: ChatPermissions): Promise<true> => {
    permissionWrites.push(permissions);
    return true;
  });
  lockdownEntries.set(CHAT_ID, lockdownEntry());
});

afterEach((): void => {
  lockdownEntries.delete(CHAT_ID);
});

test("重读到权限时只关闭邀请、保留其它字段，并回投成功", async () => {
  chatInfo = { permissions: { can_invite_users: true, can_send_messages: true } };
  reapplyLockdownRestriction(CHAT_ID, (_chatId: number, event: LockdownMachineEvent): void => { dispatched.push(event); });
  await drain();

  expect(permissionWrites).toEqual([{ can_invite_users: false, can_send_messages: true }]);
  expect(dispatched).toEqual([{ type: "reapplyResult", ok: true }]);
});

test("getChat 缺 permissions 时不写权限、记错误并回投失败，由状态机安排重试", async () => {
  chatInfo = {};
  reapplyLockdownRestriction(CHAT_ID, (_chatId: number, event: LockdownMachineEvent): void => { dispatched.push(event); });
  await drain();

  expect(permissionWrites).toEqual([]);
  expect(dispatched).toEqual([{ type: "reapplyResult", ok: false }]);
  expect(loggedErrors).toHaveLength(1);
});

test("条目已不在 RECONCILING 时不重读权限、不写权限也不回投", async () => {
  lockdownEntries.delete(CHAT_ID);
  chatInfo = { permissions: { can_invite_users: true } };
  reapplyLockdownRestriction(CHAT_ID, (_chatId: number, event: LockdownMachineEvent): void => { dispatched.push(event); });
  await drain();

  expect(getChatCalls).toBe(0);
  expect(permissionWrites).toEqual([]);
  expect(dispatched).toEqual([]);
});

test("getChat 期间条目被新一代替换时丢弃迟到结果，不写权限也不回投", async () => {
  chatInfo = { permissions: { can_invite_users: true } };
  onGetChat = (): void => { lockdownEntries.set(CHAT_ID, lockdownEntry()); };
  reapplyLockdownRestriction(CHAT_ID, (_chatId: number, event: LockdownMachineEvent): void => { dispatched.push(event); });
  await drain();

  expect(getChatCalls).toBe(1);
  expect(permissionWrites).toEqual([]);
  expect(dispatched).toEqual([]);
});

describe("lockdownApi 公告与提交边界", () => {
  const dispatchLockdown = (_chatId: number, event: LockdownMachineEvent): void => {
    dispatched.push(event);
  };

  test("beginLockdownAnnouncement 在 onSent 已登记但返回 undefined 时仍回投该 messageId", async () => {
    lockdownEntries.set(CHAT_ID, lockdownEntry(preparedApplyingState()));
    sendMessage.mockImplementationOnce(async (params: SendMessageMockParams): Promise<number | undefined> => {
      params.onSent?.(404);
      return undefined;
    });

    beginLockdownAnnouncement(CHAT_ID, 6, dispatchLockdown);
    await drain();

    expect(dispatched).toEqual([{ type: "announcementResult", messageId: 404 }]);
    expect(deletedCalls).toEqual([]);
  });

  test("beginLockdownAnnouncement 在 onSent 登记后条目换代且抛 AbortError 时清理孤儿公告且不记错误", async () => {
    lockdownEntries.set(CHAT_ID, lockdownEntry(preparedApplyingState(11)));
    sendMessage.mockImplementationOnce(async (params: SendMessageMockParams): Promise<number | undefined> => {
      params.onSent?.(405);
      lockdownEntries.set(CHAT_ID, lockdownEntry(preparedApplyingState(12)));
      throw new DOMException("aborted", "AbortError");
    });

    beginLockdownAnnouncement(CHAT_ID, 6, dispatchLockdown);
    await drain();

    expect(dispatched).toEqual([]);
    expect(deletedCalls).toEqual([{ chatId: CHAT_ID, messageId: 405 }]);
    expect(loggedErrors).toEqual([]);
  });

  test("deleteLockdownAnnouncement 删除失败记录错误并放行后续链任务，AbortError 不记错误日志", async () => {
    const deleteError: Error = new Error("deleteMessage failed");
    deleteMessage.mockRejectedValueOnce(deleteError);

    deleteLockdownAnnouncement(CHAT_ID, 501);
    deleteLockdownAnnouncement(CHAT_ID, 502);
    await drain();

    expect(loggedErrors).toEqual([[
      "Error deleting the anti-raid lockdown announcement:",
      { chatId: CHAT_ID },
      deleteError,
    ]]);
    expect(deletedCalls).toEqual([{ chatId: CHAT_ID, messageId: 502 }]);

    loggedErrors.length = 0;
    deleteMessage.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    deleteLockdownAnnouncement(CHAT_ID, 503);
    await drain();
    expect(loggedErrors).toEqual([]);
  });

  test("commitApplyLockdown 写权限失败时记录错误并回投 applyResult(ok:false) 触发恢复对账", async () => {
    chatInfo = { permissions: { can_invite_users: true, can_send_messages: true } };
    lockdownEntries.set(CHAT_ID, lockdownEntry(preparedApplyingState(21)));
    const writeError: Error = new Error("setChatPermissions timed out");
    setChatPermissions.mockRejectedValueOnce(writeError);

    commitApplyLockdown(CHAT_ID, dispatchLockdown);
    await drain();

    expect(loggedErrors).toEqual([[
      "Error applying anti-raid lockdown; scheduling a restorative reconciliation:",
      { chatId: CHAT_ID },
      writeError,
    ]]);
    expect(dispatched).toEqual([{
      type: "applyResult",
      ok: false,
      restoreIntentId: expect.any(Number),
    }]);
  });

  test("commitApplyLockdown 写权限因 AbortError 失败时不记错误，但在条目仍匹配时仍回投恢复对账", async () => {
    chatInfo = { permissions: { can_invite_users: true } };
    lockdownEntries.set(CHAT_ID, lockdownEntry(preparedApplyingState(22)));
    setChatPermissions.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

    commitApplyLockdown(CHAT_ID, dispatchLockdown);
    await drain();

    expect(loggedErrors).toEqual([]);
    expect(dispatched).toEqual([{
      type: "applyResult",
      ok: false,
      restoreIntentId: expect.any(Number),
    }]);
  });

  test("commitApplyLockdown 写权限抛错期间条目已换代时记录错误但不回投 applyResult", async () => {
    chatInfo = { permissions: { can_invite_users: true } };
    lockdownEntries.set(CHAT_ID, lockdownEntry(preparedApplyingState(23)));
    const writeError: Error = new Error("setChatPermissions failed after replace");
    setChatPermissions.mockImplementationOnce(async (): Promise<never> => {
      lockdownEntries.set(CHAT_ID, lockdownEntry(preparedApplyingState(24)));
      throw writeError;
    });

    commitApplyLockdown(CHAT_ID, dispatchLockdown);
    await drain();

    expect(loggedErrors).toEqual([[
      "Error applying anti-raid lockdown; scheduling a restorative reconciliation:",
      { chatId: CHAT_ID },
      writeError,
    ]]);
    expect(dispatched).toEqual([]);
  });
});
