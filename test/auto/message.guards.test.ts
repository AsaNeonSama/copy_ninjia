import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message, User } from "grammy/types";
import { LUCK_RECEIPT_DISPLAY_PREFIX } from "../../packages/consts/luckReceipt";
import { GAG_PROFILE_CHAT_SEPARATOR } from "../../packages/consts/gag";
import { SELF_SPEAKER_NAME } from "../../packages/consts/aiChat/prompts/transcript";
import { createGagTargetProfileUrl } from "../../packages/commands/gag/identity";
import type { AiBotInfo } from "../../packages/types/aiChat/protocol";
import {
  autoMessageChatState,
  autoMessageCopyState,
  copyMessageMock,
  generateAndSendReplyMock,
  recordChatMessageMock,
  resetAutoMessageMocks,
  sendMessageMock,
} from "../helpers/autoMessageMocks";

mock.module("../../packages/aiChat/availability", () => ({
  isAiChatActiveIn: (_chatId: number): boolean => autoMessageChatState.isAIChatEnabled,
  isAiChatConfigured: (): boolean => autoMessageChatState.isAIChatEnabled,
}));

const { recordSelfInlineResult } = await import("../../packages/auto/message/guards");
const { handleIncomingMessageMiddleware: handleIncomingMessageWithState } = await import("../../packages/auto/message");
const { getChatState } = await import("../../packages/infra/storage/stateStore");
const { DEFAULT_CHAT_STATE } = await import("../../packages/libs/chatState");

/** 与前置链一致：读一次本条消息所在群的状态快照，再交给自动流水线。 */
function handleIncomingMessageMiddleware(ctx: any): Promise<void> | undefined {
  const chatId: number | undefined = ctx.msg?.chat.id;
  return handleIncomingMessageWithState(ctx, chatId === undefined ? DEFAULT_CHAT_STATE : getChatState(chatId));
}

const bot: AiBotInfo = { id: 99, username: "ninja_bot", first_name: "Ninja" };
const viaBot: User = { id: bot.id, is_bot: true, first_name: bot.first_name, username: bot.username };

function message(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 17,
    date: 1_786_447_200,
    chat: { id: -1001, type: "supergroup", title: "test" },
    via_bot: viaBot,
    text: "可读正文",
    ...overrides,
  } as Message;
}

function gagMarkerUrlForUser(userId: number, username: string | undefined, chatId: number = -1001): string {
  return `${createGagTargetProfileUrl({ id: userId, first_name: "Alice", username })}${GAG_PROFILE_CHAT_SEPARATOR}${chatId}`;
}

function gagMarkerUrlForChannel(channelId: number, username: string | undefined, chatId: number = -1001): string {
  return `${createGagTargetProfileUrl({ id: channelId, first_name: "Channel", username })}${GAG_PROFILE_CHAT_SEPARATOR}${chatId}`;
}

beforeEach((): void => {
  resetAutoMessageMocks();
});

describe("inline 结果自录门禁", () => {
  test("AI 活跃群普通 inline 结果按机器人自身身份记录可读正文，剥离运势回执", () => {
    recordSelfInlineResult(message({
      from: { id: 123, is_bot: false, first_name: "Alice", username: "alice_dev" },
      text: `可读正文\n${LUCK_RECEIPT_DISPLAY_PREFIX}${"a".repeat(64)}`,
    }), bot);

    expect(recordChatMessageMock.mock.calls).toEqual([[{
      type: "record",
      chatId: -1001,
      senderId: 99,
      firstName: SELF_SPEAKER_NAME,
      lastName: "",
      username: undefined,
      messageId: 17,
      replyTo: undefined,
      forwardedFrom: undefined,
      persistImmediately: false,
      text: "可读正文",
    }]]);
  });

  test("gag inline 发言按真实用户与频道马甲身份原样记入 AI 上下文", () => {
    const userSpeech: string = "【口球】呜呜唔唔";
    recordSelfInlineResult(message({
      message_id: 21,
      from: { id: 123, is_bot: false, first_name: "Alice", last_name: "Liddell", username: "alice_dev" },
      text: userSpeech,
      entities: [{
        type: "text_link",
        offset: 0,
        length: 4,
        url: gagMarkerUrlForUser(123, "alice_dev"),
      }],
    }), bot);

    const channelSpeech: string = "【丝袜】唔唔唔";
    recordSelfInlineResult(message({
      message_id: 22,
      from: { id: 136817688, is_bot: true, first_name: "Channel_Bot", username: "Channel_Bot" },
      sender_chat: { id: -100200300, type: "channel", title: "测试频道", username: "test_chan" },
      text: channelSpeech,
      entities: [{
        type: "text_link",
        offset: 0,
        length: 4,
        url: gagMarkerUrlForChannel(-100200300, "test_chan"),
      }],
    }), bot);

    expect(recordChatMessageMock.mock.calls).toEqual([
      [{
        type: "record",
        chatId: -1001,
        senderId: 123,
        firstName: "Alice",
        lastName: "Liddell",
        username: "alice_dev",
        messageId: 21,
        replyTo: undefined,
        forwardedFrom: undefined,
        persistImmediately: false,
        text: userSpeech,
      }],
      [{
        type: "record",
        chatId: -1001,
        senderId: -100200300,
        firstName: "测试频道",
        lastName: "",
        username: "test_chan",
        messageId: 22,
        replyTo: undefined,
        forwardedFrom: undefined,
        persistImmediately: false,
        text: channelSpeech,
      }],
    ]);
  });

  test("handleIncomingMessageMiddleware 遇到本 bot 的 gag inline 消息只记录发言者，不触发 AI 回复或复读", () => {
    const text: string = `【口球】@${bot.username} 唔唔`;
    const result: Promise<void> | undefined = handleIncomingMessageMiddleware({
      me: bot,
      msg: message({
        message_id: 30,
        from: { id: 123, is_bot: false, first_name: "Alice", username: "alice_dev" },
        text,
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: 4,
            url: gagMarkerUrlForUser(123, "alice_dev"),
          },
          {
            type: "mention",
            offset: 4,
            length: bot.username!.length + 1,
          },
        ],
      }),
    } as never);

    expect(result).toBeUndefined();
    expect(recordChatMessageMock).toHaveBeenCalledTimes(1);
    expect(recordChatMessageMock.mock.calls[0]?.[0]).toEqual({
      type: "record",
      chatId: -1001,
      senderId: 123,
      firstName: "Alice",
      lastName: "",
      username: "alice_dev",
      messageId: 30,
      replyTo: undefined,
      forwardedFrom: undefined,
      persistImmediately: false,
      text,
    });
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("私聊、非文本、复读接管或 AI 未启用时都不记录（含 gag inline 消息）", () => {
    const gagMsg: Message = message({
      from: { id: 123, is_bot: false, first_name: "Alice" },
      text: "【口球】唔唔",
      entities: [{
        type: "text_link",
        offset: 0,
        length: 4,
        url: gagMarkerUrlForUser(123, undefined),
      }],
    });
    recordSelfInlineResult(message({
      chat: { id: 7, type: "private", first_name: "Alice" },
    }), bot);
    recordSelfInlineResult(message({ text: undefined }), bot);
    autoMessageCopyState.targetId = 123;
    recordSelfInlineResult(gagMsg, bot);
    autoMessageCopyState.targetId = undefined;
    autoMessageChatState.isAIChatEnabled = false;
    recordSelfInlineResult(gagMsg, bot);

    expect(recordChatMessageMock).not.toHaveBeenCalled();
  });
});
