import { beforeEach, describe, expect, mock, test } from "bun:test";
import { replyCommandNoticeVia } from "../helpers/common";

/** 头像执行槽的回执开关：silent 任务只换头像、不发回执。 */

const restoreDefaultProfilePhoto = mock(async (..._args: unknown[]): Promise<boolean> => true);
const sendCommandMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
mock.module("../../packages/infra/telegram/avatar/restore", () => ({ restoreDefaultProfilePhoto }));
mock.module("../../packages/infra/telegram/avatar/copy", () => ({
  copyUserProfilePhoto: async (): Promise<boolean> => true,
}));
mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage, replyCommandNotice: replyCommandNoticeVia(sendCommandMessage) }));
mock.module("../../packages/config/assets", () => ({
  getAssetConfig: (): Readonly<{ botDefaultAvatar: string }> => ({ botDefaultAvatar: "avatar.png" }),
}));

const { drainAvatarUpdates, initAvatarUpdates, queueAvatarUpdate } = await import("../../packages/copy/avatarQueue");
const { currentUpdateAbortSignal, runWithUpdateAbortSignal } = await import("../../packages/infra/updateContext");

beforeEach(() => {
  restoreDefaultProfilePhoto.mockReset();
  restoreDefaultProfilePhoto.mockImplementation(async (): Promise<boolean> => true);
  sendCommandMessage.mockReset();
  sendCommandMessage.mockImplementation(async (): Promise<number | undefined> => 1);
  initAvatarUpdates();
});

describe("头像更新回执", () => {
  test("silent 复原照常换头像但不发回执", async () => {
    queueAvatarUpdate({ chatId: -1001, target: { kind: "default" }, source: "copy", silent: true });
    await expect(drainAvatarUpdates(1_000)).resolves.toBe("flushed");

    expect(restoreDefaultProfilePhoto).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("缺省不是 silent，复原后在提交群发一条回执", async () => {
    queueAvatarUpdate({ chatId: -1001, target: { kind: "default" }, source: "copy" });
    await expect(drainAvatarUpdates(1_000)).resolves.toBe("flushed");

    expect(restoreDefaultProfilePhoto).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage.mock.calls[0]?.[0]).toMatchObject({ chatId: -1001 });
  });

  test("触发 update 中止后，已脱离 update 作用域的后台头像更新与回执照常完成且保留话题", async () => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const observedSignals: (AbortSignal | undefined)[] = [];
    restoreDefaultProfilePhoto.mockImplementationOnce(async (): Promise<boolean> => {
      observedSignals.push(currentUpdateAbortSignal());
      await gate.promise;
      return true;
    });
    sendCommandMessage.mockImplementationOnce(async (): Promise<number | undefined> => {
      observedSignals.push(currentUpdateAbortSignal());
      return 1;
    });
    const updateController: AbortController = new AbortController();

    await runWithUpdateAbortSignal(updateController.signal, async (): Promise<void> => {
      queueAvatarUpdate({ chatId: -1001, target: { kind: "default" }, source: "copy" });
      updateController.abort(new DOMException("update aborted", "AbortError"));
    }, { chatId: -1001, threadId: 55 });

    gate.resolve();
    await expect(drainAvatarUpdates(1_000)).resolves.toBe("flushed");
    expect(observedSignals).toEqual([undefined, undefined]);
    expect(sendCommandMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      messageThreadId: 55,
      signal: expect.any(AbortSignal),
    }));
  });
});
