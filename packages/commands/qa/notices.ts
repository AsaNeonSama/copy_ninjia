/**
 * 表单发送、编辑和删除的唯一 Telegram 边界。
 * 表单由结算、TTL、重开或 teardown 清理，不挂固定延迟删除；见 docs/cn/04-invariants.md。
 */

import {
  deleteMessageWithOutcome,
  editMessageText,
  sendMessage,
} from "../../infra/telegram";
import type { QaFormSession } from "../../types/qa";

/** 发送问答表单提示消息的入参。 */
export interface SendQaFormParams {
  /** 目标群 ID。 */
  readonly chatId: number;
  /** 表单提示消息文本。 */
  readonly text: string;
  /** 回复的目标消息 ID。 */
  readonly replyToMessageId?: number;
  /**
   * `/qa set` 所在的论坛话题。
   *
   * 表单不挂固定延迟清理（见文件头注），留到填齐、TTL 到期或群 teardown，
   * 自己带话题（见 SendMessageBaseParams.messageThreadId）。
   */
  readonly messageThreadId: number | undefined;
  /** 远端返回 id 后同步登记，已关闭会话的迟到消息交回状态机清理。 */
  readonly onSent: (messageId: number) => void;
}

/**
 * 发送表单提示消息。
 * @param params 表单提示发送参数（含目标群 `chatId`、提示正文 `text`、回复消息 ID `replyToMessageId`、话题 `messageThreadId` 与消息 ID 同步登记回调 `onSent`）。
 * @returns 发送成功时返回消息 ID，失败时返回 undefined。
 */
export function sendQaForm({
  chatId,
  text,
  replyToMessageId,
  messageThreadId,
  onSent,
}: SendQaFormParams): Promise<number | undefined> {
  return sendMessage({
    chatId,
    text,
    replyToMessageId,
    messageThreadId,
    onSent,
  });
}

/**
 * 就地更新当前表单；等待请求完成以纳入 update 排空，失败由 Telegram 边界记录。
 * @param session 当前表单会话。
 * @param text 更新后的表单提示文本。
 */
export async function editQaForm(session: QaFormSession, text: string): Promise<void> {
  const messageId: number | undefined = session.formMessageId;
  if (messageId === undefined) return;
  await editMessageText({ chatId: session.chatId, messageId, text });
}

/**
 * 交出消息 id 的唯一删除责任；id 尚未登记时由迟到发送回调继续清理。
 * @param session 待删除表单提示消息的会话。
 */
export async function deleteQaForm(session: QaFormSession): Promise<void> {
  const messageId: number | undefined = session.formMessageId;
  if (messageId === undefined) return;
  session.formMessageId = undefined;
  await deleteMessageWithOutcome(session.chatId, messageId);
}
