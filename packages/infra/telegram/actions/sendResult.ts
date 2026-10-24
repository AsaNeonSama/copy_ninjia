import type { TelegramSendResult } from "../../../types/telegram";
import type { TelegramSentMessage } from "../../../types/telegramWorker";
import { markSelfSent } from "../../selfSentTracker";

/**
 * 登记机器人自发消息，并投影 Telegram 实际建立的回复关系。
 * @param chatId 消息所属的聊天 ID。
 * @param sent Telegram 返回的已发送消息对象。
 * @returns 包含 messageId 与实际被回复消息 ID 的发送结果。
 */
export function toTelegramSendResult(
  chatId: number,
  sent: TelegramSentMessage
): TelegramSendResult {
  markSelfSent(chatId, sent.message_id);
  return { messageId: sent.message_id, repliedToMessageId: sent.reply_to_message?.message_id };
}
