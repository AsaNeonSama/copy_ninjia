import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { CachedUser } from "../../packages/types/chatState";

const errorLogs: unknown[][] = [];
async function getChatStub(chatId: number, _signal?: unknown): Promise<Record<string, unknown>> {
  return { id: chatId, type: "channel", title: "Channel", username: "channel_now" };
}
const getChat = mock(getChatStub);
async function readChatMemberUserStub(
  { userId }: { chatId: number; userId: number }
): Promise<Record<string, unknown> | undefined> {
  return { id: userId, is_bot: false, first_name: "Alice", last_name: "A", username: "alice_now" };
}
const readChatMemberUser = mock(readChatMemberUserStub);

mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error(...args: unknown[]): void { errorLogs.push(args); } }),
}));
mock.module("../../packages/infra/telegram/client", () => ({
  logApiError: (...args: unknown[]): void => { errorLogs.push(args); },
  telegramApi: { getChat },
}));
mock.module("../../packages/infra/telegram/actions/membership", () => ({ readChatMemberUser }));

const { readLiveTargetIdentity } = await import("../../packages/commands/liveTargetIdentity");

beforeEach((): void => {
  errorLogs.length = 0;
  getChat.mockReset();
  getChat.mockImplementation(getChatStub);
  readChatMemberUser.mockReset();
  readChatMemberUser.mockImplementation(readChatMemberUserStub);
});

describe("@username 目标的现查", () => {
  test("用户经命令所在群的 getChatMember 现查，按用户身份形态返回", async () => {
    const target: CachedUser = { id: 7, username: "alice_old" };

    expect(await readLiveTargetIdentity(-1001, target)).toEqual({
      id: 7,
      username: "alice_now",
      first_name: "Alice",
      last_name: "A",
    });
    expect(readChatMemberUser).toHaveBeenCalledWith({ chatId: -1001, userId: 7 });
    expect(getChat).not.toHaveBeenCalled();
  });

  test("用户现查失败返回 undefined", async () => {
    readChatMemberUser.mockResolvedValueOnce(undefined);

    expect(await readLiveTargetIdentity(-1001, { id: 7, username: "alice_old" })).toBeUndefined();
  });

  test("频道与群身份经 getChat 现查，按频道身份形态返回", async () => {
    expect(await readLiveTargetIdentity(-1001, { id: -1002, username: "channel_old", isChannel: true })).toEqual({
      id: -1002,
      username: "channel_now",
      title: "Channel",
      isChannel: true,
    });
    expect(getChat.mock.calls[0]?.[0]).toBe(-1002);
    expect(readChatMemberUser).not.toHaveBeenCalled();
  });

  test("getChat 失败记 API 错误并返回 undefined", async () => {
    getChat.mockRejectedValueOnce(new Error("chat not found"));

    expect(await readLiveTargetIdentity(-1001, { id: -1002, isChannel: true })).toBeUndefined();
    expect(errorLogs.length).toBeGreaterThan(0);
  });
});
