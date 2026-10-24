import type {
  InlineQueryResult,
  InputMessageContent,
} from "grammy/types";
import { inlineResultSources } from "../cache/main/inlineResultSources";
import type { InlineResultSource } from "../types/telegram";

/**
 * 本 bot 的 inline 应答结果正文到用户输入源文本的映射登记表：
 * 应答成功后按发言身份登记，结果消息落群后按发送者 ID 与结果正文取回源文本供广告检测送检。
 */

/**
 * 提取单条 inline 结果中的 `message_text`；无文本内容时返回 `undefined`。
 * @param result 单条 Telegram inline 查询结果项。
 * @returns 结果携带的消息正文文本；不含文本内容时返回 `undefined`。
 */
function inlineResultText(result: InlineQueryResult): string | undefined {
  if (!("input_message_content" in result)) return undefined;
  const content: InputMessageContent | undefined = result.input_message_content;
  if (content === undefined || !("message_text" in content)) return undefined;
  return content.message_text;
}

/**
 * 登记一次已送达的 inline 应答（覆盖该发言身份上一次的记录）；
 * 源文本或可提取结果正文为空时不登记。
 * @param speakerId 触发 inline 查询的发言者 ID。
 * @param sourceText 用户输入的原始源文本。
 * @param results 已送达的 inline 查询结果列表。
 */
export function recordInlineResultSources(
  speakerId: number,
  sourceText: string,
  results: readonly InlineQueryResult[]
): void {
  if (sourceText.length === 0 || results.length === 0) return;
  const resultTexts: string[] = [];
  for (const result of results) {
    const text: string | undefined = inlineResultText(result);
    if (text !== undefined && text.length > 0) resultTexts.push(text);
  }
  if (resultTexts.length === 0) return;
  // 重新登记的发言身份回到 LRU 最新顺位。
  inlineResultSources.set(speakerId, { sourceText, resultTexts });
}

/**
 * 只在发送者自己的登记里按落群的结果正文取回源文本；没登记过或对不上返回
 * undefined，不查其它身份的登记。结果正文逐字相同才返回源文本。
 * @param speakerId 落群消息的发送者 ID。
 * @param resultText 落群消息的正文文本。
 * @returns 匹配的输入源文本；未命中时返回 `undefined`。
 */
export function inlineResultSourceOf(
  speakerId: number,
  resultText: string
): string | undefined {
  if (resultText.length === 0) return undefined;
  const source: InlineResultSource | undefined = inlineResultSources.peek(speakerId);
  return source?.resultTexts.includes(resultText) === true ? source.sourceText : undefined;
}
