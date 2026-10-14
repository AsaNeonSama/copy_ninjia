/**
 * 主线程 abuse_mark 用户冷处理状态（`packages/aiChat/abuseMark.ts`）与 AI 群聊入口拦截：
 * - 每个被标记用户独立持有一个 `setTimeout`（时长 `ABUSE_MARK_DURATION_MS`），到期只清理该用户自身条目，不做轮扫
 * - 重复标记同一用户时先 `clearTimeout` 旧定时器并重排到 `FifoMap` 队尾
 * - 达到 `ABUSE_MARK_MAX_USERS` 容量上限时按 `FifoMap.oldestKey()` O(1) 驱逐最老条目并清理其定时器
 * - 在 `handleIncomingMessageMiddleware` 的 AI 群聊入口拦截被标记用户的消息（不记入滚动记忆、不触发 AI 回复），未标记用户不受影响
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  generateAndSendReplyMock,
  recordChatMediaMock,
  recordChatMessageMock,
  resetAutoMessageMocks,
} from "../helpers/autoMessageMocks";

const {
  ABUSE_MARK_DURATION_MS,
  ABUSE_MARK_MAX_USERS,
} = await import("../../packages/consts/aiChat/rateLimit");
const { abuseMarkedUsers } = await import("../../packages/cache/main/aiChat");
const {
  clearAbuseMarkedUsers,
  isAbuseMarkedUser,
  markAbuseUser,
} = await import("../../packages/aiChat/abuseMark");
const { handleIncomingMessageMiddleware } = await import("../../packages/auto/message");

const botInfo = { id: 999_999, username: "test_bot", first_name: "TestBot" };

beforeEach(() => {
  resetAutoMessageMocks();
});

afterEach(() => {
  clearAbuseMarkedUsers();
});

describe("主线程 abuse_mark 独立定时器与 AI 入口拦截", () => {
  test("每个元素独立挂载 setTimeout，到期回调只移除该用户自身条目", () => {
    const callbacks = new Map<number, () => void>();
    const delays: number[] = [];
    let nextTimerId: number = 1;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: unknown,
      timeout?: number
    ): ReturnType<typeof setTimeout> => {
      const id: number = nextTimerId++;
      delays.push(Number(timeout));
      if (typeof handler === "function") {
        callbacks.set(id, handler as () => void);
      }
      return {
        unref: (): void => {},
        __id: id,
      } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((): void => {}) as typeof clearTimeout);

    try {
      markAbuseUser(101);
      markAbuseUser(202);

      expect(delays).toEqual([ABUSE_MARK_DURATION_MS, ABUSE_MARK_DURATION_MS]);
      expect(isAbuseMarkedUser(101)).toBe(true);
      expect(isAbuseMarkedUser(202)).toBe(true);
      expect(abuseMarkedUsers.size).toBe(2);

      // 触发 101 的到期回调：只删除 101，202 仍保持有效。
      callbacks.get(1)?.();
      expect(isAbuseMarkedUser(101)).toBe(false);
      expect(isAbuseMarkedUser(202)).toBe(true);
      expect(abuseMarkedUsers.size).toBe(1);

      callbacks.get(2)?.();
      expect(isAbuseMarkedUser(202)).toBe(false);
      expect(abuseMarkedUsers.size).toBe(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  test("重复标记同一用户会清理旧定时器并刷新 FifoMap 顺序，容量满时淘汰最老条目", () => {
    markAbuseUser(1);
    const firstTimer: ReturnType<typeof setTimeout> | undefined = abuseMarkedUsers.get(1);
    expect(firstTimer).toBeDefined();

    for (let userId: number = 2; userId <= ABUSE_MARK_MAX_USERS; userId++) {
      markAbuseUser(userId);
    }
    expect(abuseMarkedUsers.size).toBe(ABUSE_MARK_MAX_USERS);
    expect(abuseMarkedUsers.oldestKey()).toBe(1);

    // 重新标记用户 1：旧定时器被替换，用户 1 移至队尾，此时最老条目变为用户 2。
    markAbuseUser(1);
    expect(abuseMarkedUsers.get(1)).not.toBe(firstTimer);
    expect(abuseMarkedUsers.oldestKey()).toBe(2);

    // 再新增一个超出容量的用户：淘汰最老的用户 2，用户 1 仍在表内。
    markAbuseUser(ABUSE_MARK_MAX_USERS + 1);
    expect(abuseMarkedUsers.size).toBe(ABUSE_MARK_MAX_USERS);
    expect(isAbuseMarkedUser(2)).toBe(false);
    expect(isAbuseMarkedUser(1)).toBe(true);
    expect(isAbuseMarkedUser(ABUSE_MARK_MAX_USERS + 1)).toBe(true);
  });

  test("被标记用户的群消息在 AI 聊天入口被拦截，未标记用户正常进入 AI 流水线", async () => {
    markAbuseUser(777);

    await handleIncomingMessageMiddleware({
      me: botInfo,
      msg: {
        message_id: 50,
        date: 1,
        chat: { id: -100800, type: "supergroup", title: "Test Group" },
        from: { id: 777, is_bot: false, username: "spammer", first_name: "Spammer" },
        text: "@test_bot 继续写违规内容",
        entities: [{ type: "mention", offset: 0, length: 9 }],
      },
    } as any);

    expect(recordChatMessageMock).not.toHaveBeenCalled();
    expect(recordChatMediaMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();

    await handleIncomingMessageMiddleware({
      me: botInfo,
      msg: {
        message_id: 51,
        date: 1,
        chat: { id: -100800, type: "supergroup", title: "Test Group" },
        from: { id: 888, is_bot: false, username: "normal_user", first_name: "Normal" },
        text: "@test_bot 你好呀",
        entities: [{ type: "mention", offset: 0, length: 9 }],
      },
    } as any);

    expect(recordChatMessageMock).toHaveBeenCalledTimes(1);
    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
  });
});
