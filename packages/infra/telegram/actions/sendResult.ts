import type { TelegramSendResult } from "../../../types/telegram";
import type { TelegramSentMessage } from "../../../types/telegramWorker";
import { markSelfSent } from "../../selfSentTracker";

/** 登记机器人自发消息，并投影 Telegram 实际建立的回复关系。 */
export function toTelegramSendResult(
  chatId: number,
  sent: TelegramSentMessage
): TelegramSendResult {
  markSelfSent(chatId, sent.message_id);
  return { messageId: sent.message_id, repliedToMessageId: sent.reply_to_message?.message_id };
}
