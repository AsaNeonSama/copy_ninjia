/**
 * 群问答直答：消息文本与本群已登记问题精确匹配时直接回复答案，排在 AI 触发之前。
 *
 * - 未登记问答的群在 `chatQaEntries.get(chatId)`（`cache/main/qa.ts`）处直接返回 `undefined`。
 * - 已登记问答的群先用 `message.text` 原串精确查表（登记入库时已完成首尾空白裁剪）；未命中且首个实体为前导 `@<botUsername>`
 *   提及时，剥离该前缀并 `trim` 后再次查表。语义相近但字面不同的提问不在此处命中，交由 AI 工具 `group_qa_answer` 处理。
 */

import type { Message, MessageEntity } from "grammy/types";
import { sendMessage } from "../../infra/telegram";
import { chatQaEntries } from "../../cache/main/qa";
import { renderFencedText } from "../../libs/codeFence";
import type { RichTextMessage } from "../../types/telegram";

/**
 * 首个实体正好是从 0 开始的本机器人 @提及时返回它的长度，否则返回 0。
 *
 * 只认 offset 为 0 的首个实体，句中的提及不剥离。
 * 用户名比对折大小写，口径同 infra/updateGate.ts、auto/message/facts.ts、
 * commands/cjkAction.ts；问题文本不折大小写，仍要求一字不差。
 *
 * @param message Telegram 入站消息
 * @param botUsername 本机器人用户名（不含 `@`）
 * @returns 前导机器人提及实体的字符长度；不匹配时返回 `0`
 */
function leadingBotMentionLength(message: Message, botUsername: string): number {
  const entities: readonly MessageEntity[] | undefined = message.entities;
  const first: MessageEntity | undefined = entities?.[0];
  if (first?.offset !== 0 || first.type !== "mention") return 0;
  const text: string | undefined = message.text;
  if (text === undefined) return 0;
  // mention 实体的正文含前导 @，比对时跳过首字符并按实体完整长度切取。
  if (text.slice(1, first.length).toLowerCase() !== botUsername.toLowerCase()) return 0;
  return first.length;
}

/**
 * 查出这条消息应当直答的答案。
 *
 * @param chatId 群聊 ID
 * @param message Telegram 入站消息
 * @param botUsername 本机器人用户名（不含 `@`）
 * @returns 命中时是答案文本；未命中（含本群没有问答）时是 undefined，调用方
 *   照常继续原有流水线。
 */
export function resolveQaDirectAnswer(
  chatId: number,
  message: Message,
  botUsername: string
): string | undefined {
  const entries: ReadonlyMap<string, string> | undefined = chatQaEntries.get(chatId);
  if (entries === undefined) return undefined;
  const text: string | undefined = message.text;
  if (text === undefined) return undefined;
  const direct: string | undefined = entries.get(text);
  if (direct !== undefined) return direct;
  const mentionLength: number = leadingBotMentionLength(message, botUsername);
  if (mentionLength === 0) return undefined;
  return entries.get(text.slice(mentionLength).trim());
}

/** sendQaDirectAnswer 的入参。 */
export interface SendQaDirectAnswerParams {
  /** 群聊 ID */
  readonly chatId: number;
  /** 提问消息 ID */
  readonly replyToMessageId: number;
  /** 命中的问答答案文本 */
  readonly answer: string;
  /**
   * 提问所在的论坛话题；调用方用 forumTopicThreadId 从原消息取。
   * 发送时同时带 reply_parameters 与该话题（见 SendMessageBaseParams.messageThreadId），
   * 提问被删而降级成普通发送时仍留在话题内。
   */
  readonly messageThreadId: number | undefined;
}

/**
 * 将命中的问答直答发往群聊：
 * - 答案中的 ` ``` ` 围栏经 `libs/codeFence.ts` 解析为 `pre` 代码块实体。
 * - 直答属于群功能性内容，经 `sendMessage` 发送且不挂固定延迟删除。
 *
 * @param params 群问答直答发送上下文（含目标群 `chatId`、提问消息 ID `replyToMessageId`、答案原文 `answer` 与话题 `messageThreadId`）。
 * @returns 已发送消息 ID；发送失败时返回 `undefined`。
 */
export function sendQaDirectAnswer({
  chatId,
  replyToMessageId,
  answer,
  messageThreadId,
}: SendQaDirectAnswerParams): Promise<number | undefined> {
  const rendered: RichTextMessage = renderFencedText(answer);
  return sendMessage({
    chatId,
    text: rendered.text,
    entities: rendered.entities,
    replyToMessageId,
    messageThreadId,
  });
}
