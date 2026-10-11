import { describe, expect, test } from "bun:test";
import type { Chat, Message } from "grammy/types";
import { messageIdentityMetadata } from "../../packages/users/identityMetadata";
import type { TelegramIdentityMetadata } from "../../packages/types/identityPolicy";

const GROUP: Record<string, unknown> = { id: -1001, type: "supergroup", title: "群" };

/** 只带基础字段的消息夹具；各用例叠加 from。 */
function message(overrides: Record<string, unknown>): Message {
  return { message_id: 1, date: 0, chat: GROUP, ...overrides } as unknown as Message;
}

const FULL_FROM: Record<string, unknown> = {
  id: 7,
  is_bot: false,
  first_name: "Alice",
  last_name: "Liddell",
  username: "alice",
};

describe("messageIdentityMetadata：用户身份", () => {
  test("没有 sender_chat 时按 from 的三项名字映射", () => {
    const metadata: Readonly<TelegramIdentityMetadata> = messageIdentityMetadata(message({ from: FULL_FROM }), undefined);

    expect(metadata).toEqual({ firstName: "Alice", lastName: "Liddell", username: "alice" });
  });

  test("from 缺姓与用户名时对应字段为空串", () => {
    const metadata: Readonly<TelegramIdentityMetadata> = messageIdentityMetadata(
      message({ from: { id: 7, is_bot: false, first_name: "Alice" } }),
      undefined
    );

    expect(metadata).toEqual({ firstName: "Alice", lastName: "", username: "" });
  });

  test("没有 from 的消息三项都是空串", () => {
    expect(messageIdentityMetadata(message({}), undefined)).toEqual({ firstName: "", lastName: "", username: "" });
  });

  test("名字原样保留，不做 trim", () => {
    const metadata: Readonly<TelegramIdentityMetadata> = messageIdentityMetadata(
      message({ from: { id: 7, is_bot: false, first_name: " A ", last_name: "" } }),
      undefined
    );

    expect(metadata.firstName).toBe(" A ");
    expect(metadata.lastName).toBe("");
  });
});

describe("messageIdentityMetadata：频道或群身份", () => {
  test("频道身份取标题与用户名，姓恒为空串，且不看 from", () => {
    const channel: Chat = { id: -100900, type: "channel", title: "频道", username: "news" };

    const metadata: Readonly<TelegramIdentityMetadata> = messageIdentityMetadata(message({ from: FULL_FROM }), channel);

    expect(metadata).toEqual({ firstName: "频道", lastName: "", username: "news" });
  });

  test("没有公开用户名的群身份用户名为空串", () => {
    const group: Chat = { id: -100555, type: "supergroup", title: "马甲群" };

    expect(messageIdentityMetadata(message({}), group)).toEqual({ firstName: "马甲群", lastName: "", username: "" });
  });

  test("没有 title 字段的私聊形态身份名字为空串，first_name 不作为标题", () => {
    const privateChat: Chat = { id: 8, type: "private", first_name: "Bob", last_name: "B", username: "bob" };

    expect(messageIdentityMetadata(message({ from: FULL_FROM }), privateChat))
      .toEqual({ firstName: "", lastName: "", username: "bob" });
  });
});
