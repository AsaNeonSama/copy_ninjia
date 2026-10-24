/**
 * Telegram MarkdownV2 的转义与拼装（纯函数）。
 *
 * 凡是拼进 `parse_mode: "MarkdownV2"` 正文的文字——昵称、模型输出、配置值与固定
 * 文案——都只经本模块生成（见 docs/cn/04-invariants.md）。各上下文的转义集合互不相同，
 * 不得混用：
 * - 正文：Bot API 列出的保留字符与 `\`；
 * - `code` / `pre` 内部：只有反引号与 `\`；
 * - 内联链接 `(...)` 内部：只有 `)` 与 `\`。
 *
 * 拼装函数的内容为空时直接抛错。
 */

import {
  MARKDOWN_V2_CODE_ESCAPE_PATTERN,
  MARKDOWN_V2_ESCAPE_REPLACEMENT,
  MARKDOWN_V2_TEXT_ESCAPE_PATTERN,
  MARKDOWN_V2_URL_ESCAPE_PATTERN,
} from "../consts/telegramMarkdown";
import { CODE_FENCE } from "../consts/telegram";

/**
 * 拼装函数的非空断言；`kind` 只用于错误信息。
 * @param text 待校验非空的原始文本。
 * @param kind 出现在报错消息中的语法片段类型名。
 */
function assertNonEmpty(text: string, kind: string): void {
  if (text.length === 0) throw new Error(`MarkdownV2 ${kind} must not be empty`);
}

/**
 * 正文转义：保留字符与 `\` 前各加一个 `\`，其余字符（含 emoji 与 CJK）原样保留。
 * @param text 待转义的普通正文字符串。
 * @returns 可直接拼入 MarkdownV2 正文的安全字符串。
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_TEXT_ESCAPE_PATTERN, MARKDOWN_V2_ESCAPE_REPLACEMENT);
}

/**
 * `code` / `pre` 内部转义：只转义反引号与 `\`。
 * @param text 代码块或行内代码内部的原始文本。
 * @returns 转义反引号与反斜杠后的代码正文字符串。
 */
export function escapeMarkdownV2Code(text: string): string {
  return text.replace(MARKDOWN_V2_CODE_ESCAPE_PATTERN, MARKDOWN_V2_ESCAPE_REPLACEMENT);
}

/**
 * 内联链接 `(...)` 内部转义：只转义 `)` 与 `\`；URL 形态由调用方先行校验。
 * @param url 链接圆括号内的目标 URL 字符串。
 * @returns 转义右括号与反斜杠后的 URL 字符串。
 */
export function escapeMarkdownV2Url(url: string): string {
  return url.replace(MARKDOWN_V2_URL_ESCAPE_PATTERN, MARKDOWN_V2_ESCAPE_REPLACEMENT);
}

/**
 * 粗体 `*text*`。
 * @param text 非空原始文本。
 * @returns MarkdownV2 粗体片段。
 */
export function markdownV2Bold(text: string): string {
  assertNonEmpty(text, "bold text");
  return `*${escapeMarkdownV2(text)}*`;
}

/**
 * 粗斜体 `*_text_*`。
 * @param text 非空原始文本。
 * @returns MarkdownV2 粗斜体片段。
 */
export function markdownV2BoldItalic(text: string): string {
  assertNonEmpty(text, "bold italic text");
  return `*_${escapeMarkdownV2(text)}_*`;
}

/**
 * 内联链接 `[text](url)`；文字按正文转义，URL 按链接上下文转义。
 * @param text 非空链接显示文字。
 * @param url 非空目标 URL。
 * @returns MarkdownV2 内联链接片段。
 */
export function markdownV2Link(text: string, url: string): string {
  assertNonEmpty(text, "link text");
  assertNonEmpty(url, "link url");
  return `[${escapeMarkdownV2(text)}](${escapeMarkdownV2Url(url)})`;
}

/**
 * 内联代码 `` `text` ``。
 * @param text 非空行内代码文本。
 * @returns MarkdownV2 行内代码片段。
 */
export function markdownV2InlineCode(text: string): string {
  assertNonEmpty(text, "inline code");
  return `\`${escapeMarkdownV2Code(text)}\``;
}

/**
 * 带语言标注的代码块。
 *
 * 开栏后的第一个换行由 Telegram 吞掉；闭栏紧贴正文，不再补换行——块内正文与
 * `code` 完全一致，块后的换行由调用方按正文写出。
 * @param code 非空代码正文。
 * @param language 非空代码语言标记。
 * @returns MarkdownV2 围栏代码块片段。
 */
export function markdownV2Pre(code: string, language: string): string {
  assertNonEmpty(code, "pre code");
  assertNonEmpty(language, "pre language");
  return `${CODE_FENCE}${language}\n${escapeMarkdownV2Code(code)}${CODE_FENCE}`;
}

/**
 * 单行引用 `>text`；必须位于行首，由调用方保证前面是正文开头或换行。
 * 引用正文不得含换行：多行引用的每一行都要自带 `>`，本模块不提供。
 * @param text 不含换行符的非空单行引用正文。
 * @returns MarkdownV2 单行引用片段。
 */
export function markdownV2Quote(text: string): string {
  assertNonEmpty(text, "quote text");
  if (text.includes("\n")) throw new Error("MarkdownV2 quote text must be a single line");
  return `>${escapeMarkdownV2(text)}`;
}
