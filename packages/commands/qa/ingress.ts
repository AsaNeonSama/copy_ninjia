/**
 * 收集当前表单发起者投递的问题与回答；字段消息进入删除流程后由本领域认领。
 * 异步等待后复核会话身份，关闭的会话不再接收字段；超长或含可点命令的字段不写进会话。
 * 跨模块约束见 docs/cn/04-invariants.md。
 */

import { qaFormSessions } from "../../cache/main/qa";

import type { Message } from "grammy/types";
import { deleteMessageWithOutcome } from "../../infra/telegram";
import { throwIfUpdateAborted } from "../../infra/updateContext";
import {
  isBotOwnMessage,
  needsBotOwnMessageWait,
  waitForBotOwnMessage,
} from "../../infra/selfSentTracker";
import { visibleSenderId } from "../../users/visibleSender";
import type { QaFieldInput, QaFieldRejection, QaFormIngressResult, QaFormSession } from "../../types/qa";
import { answerRejectionOf, questionRejectionOf } from "./fieldRules";
import { parseQaFieldMessage } from "./rendering";

/**
 * 认领一条表单投递消息并写回会话。
 *
 * 不是本群表单发起者投递的字段时同步返回 null，不分配 Promise；只有字段投递才进入
 * 异步段（频道自发标记等待、删除投递消息、写回会话）。
 * @param message 入站消息对象。
 * @returns 未认领时为 null（同步，或异步段里判定为频道自发帖、会话已换）；进入删除流程后
 *   始终返回认领结果，调用方复核会话后处理回执。
 */
export function claimQaFieldMessage(
  message: Message
): Promise<QaFormIngressResult | null> | null {
  // 无表单时只查一次 Map；频道自发标记等待排在身份与格式检查之后。
  const session: QaFormSession | undefined = qaFormSessions.get(message.chat.id);
  if (session === undefined) return null;
  if (message.message_id === session.formMessageId) return null;
  // 自发消息不参与字段收集。
  if (isBotOwnMessage(message)) return null;
  const actorId: number | undefined = visibleSenderId(message);
  if (actorId === undefined || actorId !== session.openedById) return null;
  const parsed: QaFieldInput | undefined = parseQaFieldMessage(message);
  if (parsed === undefined) return null;
  return claimParsedQaField(message, session, parsed);
}

/**
 * claimQaFieldMessage 的异步段：已确认是发起者投递的字段。
 * @param message 入站消息对象。
 * @param session 当前表单会话。
 * @param parsed 解析出的字段内容。
 * @returns 认领结果，若异步复核发现会话已变或为自发消息则返回 null。
 */
async function claimParsedQaField(
  message: Message,
  session: QaFormSession,
  parsed: QaFieldInput
): Promise<QaFormIngressResult | null> {
  // 频道帖先等待有界的自发标记（waitForBotOwnMessage）。
  if (needsBotOwnMessageWait(message) && await waitForBotOwnMessage(message)) return null;
  throwIfUpdateAborted();
  if (qaFormSessions.get(message.chat.id) !== session) return null;

  // 认领之后立刻删掉这条投递消息，它只是把文本带进表单的载体。
  await deleteMessageWithOutcome(message.chat.id, message.message_id);
  throwIfUpdateAborted();

  const active: boolean = qaFormSessions.get(message.chat.id) === session;
  const questionRejection: QaFieldRejection | null = parsed.q === undefined
    ? null
    : questionRejectionOf(parsed.q);
  const answerRejection: QaFieldRejection | null = parsed.a === undefined
    ? null
    : answerRejectionOf(parsed.a);
  // 被挡下的那一项不写进会话，表单保留。
  const question: string | undefined = active && questionRejection === null ? parsed.q : undefined;
  const answer: string | undefined = active && answerRejection === null ? parsed.a : undefined;
  if (question !== undefined) session.q = question;
  if (answer !== undefined) session.a = answer;
  return {
    session,
    accepted: { q: question, a: answer },
    rejection: questionRejection ?? answerRejection,
  };
}
