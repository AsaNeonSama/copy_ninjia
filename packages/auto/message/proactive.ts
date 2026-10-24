import type { Message } from "grammy/types";
import { recordChatMessage } from "../../aiChat";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import {
  BATH_TRIGGER_MAX_MESSAGE_LENGTH,
  BATH_TRIGGER_PATTERN,
  BATH_TRIGGER_REPLY_TEXT,
  RANDOM_ECHO_MODES,
  RANDOM_ECHO_PROBABILITY,
} from "../../consts/auto";
import { sendMessage } from "../../infra/telegram";
import { forumTopicThreadId } from "../../libs/forumTopic";
import { pickRandom } from "../../libs/random";
import type { AiBotInfo } from "../../types/aiChat/protocol";
import type { CopyMode } from "../../types/chatState";
import { echoMessage } from "./echo";
import { hasCopyableContent } from "./facts";

/** 群聊主动行为（洗澡关键词回复与随机复读）的判定与执行参数。 */
export interface HandleProactiveMessageActionsParams {
  /** 入站消息 */
  message: Message;
  /** 本机器人身份信息 */
  bot: AiBotInfo;
  /** 当前群是否处于安静模式 */
  isQuiet: boolean;
  /** 当前群是否启用 AI 聊天 */
  aiChatEnabled: boolean;
}

/**
 * 洗澡关键词命中后的异步发送与 AI 自消息记录。
 *
 * @param message 触发洗澡回复的入站消息
 * @param bot 本机器人身份信息
 * @param aiChatEnabled 当前群是否启用 AI 聊天
 */
async function replyToBathTrigger(
  message: Message,
  bot: AiBotInfo,
  aiChatEnabled: boolean
): Promise<void> {
  const sentMessageId: number | undefined = await sendMessage({
    chatId: message.chat.id,
    text: BATH_TRIGGER_REPLY_TEXT,
    replyToMessageId: message.message_id,
    // 这条回复长期留在群里，自带话题（同随机复读，见 SendMessageBaseParams.messageThreadId）。
    messageThreadId: forumTopicThreadId(message),
  });
  if (aiChatEnabled && sentMessageId !== undefined) {
    recordChatMessage(buildSelfRecordMessage({
      chatId: message.chat.id,
      self: bot,
      messageId: sentMessageId,
      text: BATH_TRIGGER_REPLY_TEXT,
    }));
  }
}

/**
 * 洗澡触发和随机复读；仅由无活动复制目标的非私聊流水线调用。AI 开启时
 * 保留洗澡关键词响应，禁用随机复读。
 *
 * @param params 入站消息、机器人身份及当前群安静期与 AI 启用状态。
 * @returns 触发异步发送时的 Promise；未命中任何主动行为时返回 `undefined`。
 */
export function handleProactiveMessageActions({
  message,
  bot,
  isQuiet,
  aiChatEnabled,
}: HandleProactiveMessageActionsParams): Promise<void> | undefined {
  const chatId: number = message.chat.id;
  if (
    !isQuiet &&
    typeof message.text === "string" &&
    !message.text.startsWith("/") &&
    message.text.length <= BATH_TRIGGER_MAX_MESSAGE_LENGTH &&
    BATH_TRIGGER_PATTERN.test(message.text)
  ) {
    return replyToBathTrigger(message, bot, aiChatEnabled);
  }

  if (
    !aiChatEnabled &&
    !isQuiet &&
    hasCopyableContent(message) &&
    Math.random() < RANDOM_ECHO_PROBABILITY
  ) {
    const mode: CopyMode | undefined = pickRandom(RANDOM_ECHO_MODES);
    return echoMessage({ chatId, message, mode, messageThreadId: forumTopicThreadId(message) });
  }
  return undefined;
}
