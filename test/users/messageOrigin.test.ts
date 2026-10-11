import { describe, expect, test } from "bun:test";
import type { MessageOrigin } from "grammy/types";
import { messageOriginIdentityId } from "../../packages/users/messageOrigin";

const DATE: number = 1_700_000_000;

describe("messageOriginIdentityId：转发来源的稳定身份", () => {
  test("没有来源时返回 undefined", () => {
    expect(messageOriginIdentityId(undefined)).toBeUndefined();
  });

  test("来源为已知用户时取用户 id", () => {
    const origin: MessageOrigin = {
      type: "user",
      date: DATE,
      sender_user: { id: 7, is_bot: false, first_name: "Alice" },
    };

    expect(messageOriginIdentityId(origin)).toBe(7);
  });

  test("隐藏用户只有显示名，没有可核对的身份", () => {
    const origin: MessageOrigin = { type: "hidden_user", date: DATE, sender_user_name: "匿名" };

    expect(messageOriginIdentityId(origin)).toBeUndefined();
  });

  test("以群身份发出时取发言群 id，不看署名", () => {
    const origin: MessageOrigin = {
      type: "chat",
      date: DATE,
      sender_chat: { id: -100555, type: "supergroup", title: "马甲群" },
      author_signature: "管理员",
    };

    expect(messageOriginIdentityId(origin)).toBe(-100555);
  });

  test("频道原帖取频道 id，不取原帖消息 id", () => {
    const origin: MessageOrigin = {
      type: "channel",
      date: DATE,
      chat: { id: -100777, type: "channel", title: "频道" },
      message_id: 31,
    };

    expect(messageOriginIdentityId(origin)).toBe(-100777);
  });
});
