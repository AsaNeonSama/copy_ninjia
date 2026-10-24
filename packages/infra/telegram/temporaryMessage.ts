/** 主线程临时群提示组合能力：发送成功与统一延迟删除登记不可拆开确认。 */

import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";
import { deleteMessageAfter } from "./actions/messageLifecycle";
import { sendMessage } from "./actions/messages";
import type { TelegramWorkerTemporaryMessageSentResult } from "../../types/telegramWorker";

export interface SendTemporaryMessageOnMainParams {
  /** 目标群聊 ID。 */
  readonly chatId: number;
  /** 提示文本内容。 */
  readonly text: string;
  /** 论坛群的话题标识。 */
  readonly messageThreadId?: number;
  /** 要回复的目标消息 ID。 */
  readonly replyToMessageId?: number;
  /** Worker 请求的取消信号；主线程自己发出的播报不带。 */
  readonly signal?: AbortSignal;
}

/**
 * 复用统一发送与延迟删除边界，删除期限统一为 COMMAND_MESSAGE_AUTO_DELETE_MS；返回成功前，message_id 已被
 * 主线程删除 owner 认领。远端发送失败返回 undefined，删除登记失败则留在发送动作的统一错误边界。
 * @param params 主线程临时群提示发送参数。
 * @returns 发送成功时返回消息 ID 与发送时间戳，失败时返回 undefined。
 */
export async function sendTemporaryMessageOnMain({
  chatId,
  text,
  signal,
  messageThreadId,
  replyToMessageId,
}: SendTemporaryMessageOnMainParams): Promise<TelegramWorkerTemporaryMessageSentResult | undefined> {
  let result: TelegramWorkerTemporaryMessageSentResult | undefined;
  const messageId: number | undefined = await sendMessage({
    chatId,
    text,
    signal,
    messageThreadId,
    replyToMessageId,
    onSent: (sentMessageId: number): void => {
      const sentAt: number = Date.now();
      deleteMessageAfter({
        chatId,
        messageId: sentMessageId,
        delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
      });
      result = { messageId: sentMessageId, sentAt };
    },
  });
  return messageId === undefined ? undefined : result;
}
