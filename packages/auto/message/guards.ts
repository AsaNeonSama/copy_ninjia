import type { Message } from "grammy/types";
import { recordChatMessage } from "../../aiChat";
import { isAiChatActiveIn } from "../../aiChat/availability";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { hasGagInlineMarker } from "../../commands/gag/identity";
import { activeCopyTargetIdIn } from "../../infra/storage/stateStore";
import { stripLuckReceipt } from "../../libs/luckReceipt";
import type { AiBotInfo } from "../../types/aiChat/protocol";
import { resolveSpeaker } from "./facts";
import { buildInlineSenderRecordMessage } from "./recordContext";

/**
 * 本机器人 via_bot 内联结果写入 AI 上下文，但不再触发任何主动行为：
 * gag 入口发言按真实发言身份记录原样正文，其余内联结果（如运势）按机器人自身身份记录。
 *
 * @param message 由本机器人内联发出的消息
 * @param bot 本机器人身份信息
 */
export function recordSelfInlineResult(message: Message, bot: AiBotInfo): void {
  if (message.chat.type === "private" || typeof message.text !== "string") return;
  const chatId: number = message.chat.id;
  if (activeCopyTargetIdIn(chatId) !== undefined || !isAiChatActiveIn(chatId)) return;
  if (hasGagInlineMarker(message, bot.id)) {
    recordChatMessage(buildInlineSenderRecordMessage({
      chatId,
      speaker: resolveSpeaker(message),
      messageId: message.message_id,
      text: message.text,
    }));
    return;
  }
  recordChatMessage(buildSelfRecordMessage({
    chatId,
    self: bot,
    messageId: message.message_id,
    text: stripLuckReceipt(message.text),
  }));
}
