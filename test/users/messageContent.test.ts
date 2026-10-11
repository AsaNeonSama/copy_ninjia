import { describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import { hasUserMessageContent } from "../../packages/users/messageContent";

const GROUP: Record<string, unknown> = { id: -1001, type: "supergroup", title: "群" };
const FROM: Record<string, unknown> = { id: 7, is_bot: false, first_name: "Alice" };
const FILE: Record<string, unknown> = { file_id: "f", file_unique_id: "u" };

/** 只带基础字段的消息夹具；各用例叠加自己关心的字段。 */
function message(overrides: Record<string, unknown>): Message {
  return { message_id: 1, date: 0, chat: GROUP, from: FROM, ...overrides } as unknown as Message;
}

/** 用户主动发送的各类内容，每项一个最小载荷。 */
const USER_CONTENT: readonly (readonly [string, unknown])[] = [
  ["text", "你好"],
  ["rich_message", { text: "富文本" }],
  ["animation", { ...FILE, width: 1, height: 1, duration: 1 }],
  ["audio", { ...FILE, duration: 1 }],
  ["document", FILE],
  ["live_photo", { photo: [], video: FILE }],
  ["paid_media", { star_count: 1, paid_media: [] }],
  ["photo", [{ ...FILE, width: 1, height: 1 }]],
  ["sticker", { ...FILE, type: "regular", width: 1, height: 1, is_animated: false, is_video: false }],
  ["story", { chat: GROUP, id: 1 }],
  ["video", { ...FILE, width: 1, height: 1, duration: 1 }],
  ["video_note", { ...FILE, length: 1, duration: 1 }],
  ["voice", { ...FILE, duration: 1 }],
  ["contact", { phone_number: "1", first_name: "Bob" }],
  ["dice", { emoji: "🎲", value: 3 }],
  ["game", { title: "游戏", description: "d", photo: [] }],
  ["poll", { id: "p", question: "q", options: [] }],
  ["venue", { location: { latitude: 0, longitude: 0 }, title: "t", address: "a" }],
  ["location", { latitude: 0, longitude: 0 }],
  ["checklist", { title: "清单", tasks: [] }],
];

/** 平台生成的服务事件：没有用户主动发送的内容。 */
const SERVICE_EVENTS: readonly (readonly [string, unknown])[] = [
  ["new_chat_members", [FROM]],
  ["left_chat_member", FROM],
  ["new_chat_title", "新群名"],
  ["new_chat_photo", [{ ...FILE, width: 1, height: 1 }]],
  ["delete_chat_photo", true],
  ["pinned_message", { message_id: 2, date: 0, chat: GROUP }],
  ["forum_topic_created", { name: "话题", icon_color: 0 }],
  ["video_chat_started", {}],
  ["message_auto_delete_timer_changed", { message_auto_delete_time: 60 }],
];

describe("hasUserMessageContent：区分用户内容与服务事件", () => {
  test.each(USER_CONTENT)("携带 %s 的消息算用户内容", (field: string, value: unknown) => {
    expect(hasUserMessageContent(message({ [field]: value }))).toBeTrue();
  });

  test.each(SERVICE_EVENTS)("只有 %s 的服务消息不算用户内容", (field: string, value: unknown) => {
    expect(hasUserMessageContent(message({ [field]: value }))).toBeFalse();
  });

  test("没有任何内容字段的消息不算用户内容", () => {
    expect(hasUserMessageContent(message({}))).toBeFalse();
  });

  test("空字符串文本也是用户发送的内容", () => {
    expect(hasUserMessageContent(message({ text: "" }))).toBeTrue();
  });

  test("只有附属字段（说明、回复、转发来源）而没有内容本体时不算", () => {
    expect(hasUserMessageContent(message({
      caption: "说明",
      reply_to_message: { message_id: 2, date: 0, chat: GROUP, text: "被回复" },
      forward_origin: { type: "hidden_user", date: 0, sender_user_name: "匿名" },
    }))).toBeFalse();
  });

  test("服务事件与内容并存时按内容判定", () => {
    expect(hasUserMessageContent(message({ new_chat_title: "新群名", text: "顺便说一句" }))).toBeTrue();
  });
});
