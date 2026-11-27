/**
 * 群问答直答：消息文本与本群已登记问题精确匹配时直接回复答案，排在 AI 触发之前。
 *
 * - 未登记问答的群在 `chatQaEntries.get(chatId)`（`cache/main/qa.ts`）处直接返回 `undefined`。
 * - 已登记问答的群先用 `message.text` 原串精确查表（登记入库时已完成首尾空白裁剪）；未命中且存在起始于偏移 `0` 的
 *   `@<botUsername>` 提及实体时（兼容外层加粗、剧透等样式包裹），剥离该前缀并 `trim` 后再次查表。
 *   语义相近但字面不同的提问不在此处命中，交由 AI 工具 `group_qa_answer` 处理。
 */

import type { Message, MessageEntity } from "grammy/types";
import { sendMessage } from "../../infra/telegram";
import { chatQaEntries } from "../../cache/main/qa";
import { renderFencedText } from "../../libs/codeFence";
import type { RichTextMessage } from "../../types/telegram";

/**
 * 按 ASCII 大小写无关（`A-Z` / `a-z`）逐码元比对 `text` 从 `offset` 起的子串与 `target`。
 * 调用方保证 `offset + target.length <= text.length`。
 *
 * @param text 原始消息文本
 * @param offset `text` 中起始比对下标
 * @param target 目标 ASCII 字符串
 * @returns 逐码元相等（忽略 ASCII 大小写）时返回 `true`，否则返回 `false`
 */
function matchesAsciiIgnoreCase(
  text: string,
  offset: number,
  target: string
): boolean {
  for (let index: number = 0; index < target.length; index += 1) {
    const left: number = text.charCodeAt(offset + index);
    const right: number = target.charCodeAt(index);
    if (left === right) continue;
    const lowerLeft: number = left >= 0x41 && left <= 0x5a ? left + 0x20 : left;
    const lowerRight: number = right >= 0x41 && right <= 0x5a ? right + 0x20 : right;
    if (lowerLeft !== lowerRight) return false;
  }
  return true;
}

/**
 * 扫描全部起始于偏移 0 的实体，命中本机器人 `@` 提及时返回其长度，否则返回 0。
 *
 * 只认 `offset === 0` 的实体（兼容外层加粗、剧透等样式实体排在 `mention` 之前的情形），句中的提及不剥离。
 * 先以 `botUsername.length + 1` 做长度预检，再按 ASCII 大小写无关（`A-Z` / `a-z`）逐码元比对用户名
 * （Telegram `mention` 实体仅包含 ASCII 字母、数字与下划线）；问题文本区分大小写，仍要求一字不差。
 *
 * @param message Telegram 入站消息
 * @param botUsername 本机器人用户名（不含 `@`）
 * @returns 前导机器人提及实体的字符长度；不匹配时返回 `0`
 */
function leadingBotMentionLength(message: Message, botUsername: string): number {
  const entities: readonly MessageEntity[] | undefined = message.entities;
  if (entities === undefined) return 0;
  const text: string | undefined = message.text;
  if (text === undefined) return 0;
  const expectedLength: number = botUsername.length + 1;
  if (text.length < expectedLength) return 0;
  for (const entity of entities) {
    if (entity.offset !== 0 || entity.type !== "mention" || entity.length !== expectedLength) {
      continue;
    }
    // mention 实体的正文含前导 @，跳过首字符并按 ASCII 大小写无关逐码元比对。
    if (matchesAsciiIgnoreCase(text, 1, botUsername)) {
      return entity.length;
    }
  }
  return 0;
}

/**
 * 查出这条消息应当直答的答案。
 *
 * @param chatId 群聊 ID
 * @param message Telegram 入站消息
 * @param botUsername 本机器人用户名（不含 `@`）；缺失或空串时仅做原文精确匹配，不剥离前导 `@` 提及
 * @returns 命中时是答案文本；未命中（含本群没有问答）时是 undefined，调用方
 *   照常继续原有流水线。
 */
export function resolveQaDirectAnswer(
  chatId: number,
  message: Message,
  botUsername: string | undefined
): string | undefined {
  const entries: ReadonlyMap<string, string> | undefined = chatQaEntries.get(chatId);
  if (entries === undefined) return undefined;
  const text: string | undefined = message.text;
  if (text === undefined) return undefined;
  const direct: string | undefined = entries.get(text);
  if (direct !== undefined) return direct;
  if (botUsername === undefined || botUsername.length === 0) return undefined;
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
