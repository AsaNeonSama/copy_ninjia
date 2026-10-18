import { KEYCAP_SEQUENCE, EMOJI_ATTACHMENT, REGIONAL_INDICATOR } from "../../../consts/aiChat/replyText";
import { truncateInline } from "../../../libs/text";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../../consts/telegram";

/**
 * 判断首尾方向性引号是否为包裹整段文本的同一对引号。
 */
function isWrappedPair(text: string, open: string, close: string): boolean {
  let depth: number = 1;
  for (let index: number = 1; index < text.length - 1; index++) {
    const char: string = text[index]!;
    if (char === open) depth++;
    else if (char === close) depth--;
    if (depth === 0) return false;
  }
  return true;
}

/**
 * 判断整段文本是否被同一对引号完整包裹。
 */
function isQuoteWrapped(text: string): boolean {
  const first: string = text[0]!;
  const last: string = text[text.length - 1]!;
  if (first === '"' && last === '"') return text.indexOf('"', 1) === text.length - 1;
  if (first === "「" && last === "」") return isWrappedPair(text, "「", "」");
  if (first === "“" && last === "”") return isWrappedPair(text, "“", "”");
  return false;
}

/**
 * 清洗模型输出的消息文本：剥离联网搜索行内引用标记、首尾空白、外层代码块围栏与外层成对引号，
 * 并按 TELEGRAM_MESSAGE_MAX_CHARS 截断；清洗后为空时返回 null。
 */
export function cleanReply(raw: string): string | null {
  let text: string = raw.replace(/\[\[\d+\]\]\((?:[^\s()]|\([^\s()]*\))+\)/g, "").trim();
  if (!text) return null;

  const fenceMatch: RegExpExecArray | null = /^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenceMatch?.[1] !== undefined) {
    text = fenceMatch[1].trim();
  }

  if (text.length >= 2 && isQuoteWrapped(text)) {
    text = text.slice(1, -1).trim();
  }

  if (!text) return null;
  return truncateInline(text, TELEGRAM_MESSAGE_MAX_CHARS);
}

/** 匹配单个图形 emoji 本体或区域指示符。 */
const GRAPHIC_EMOJI: RegExp = new RegExp(`[\\p{Extended_Pictographic}${REGIONAL_INDICATOR}]`, "u");

/** 匹配仅由 emoji 本体、区域指示符、附属码点与空白组成的文本。 */
const EMOJI_ONLY_BODY: RegExp = new RegExp(
  `^[\\p{Extended_Pictographic}${REGIONAL_INDICATOR}${EMOJI_ATTACHMENT}\\s]+$`,
  "u"
);

/**
 * 判断文本是否为纯 emoji 消息（至少含一个图形 emoji 或 keycap 序列，且不含其它非空白字符）。
 */
export function isEmojiOnly(text: string): boolean {
  const withoutKeycaps: string = text.replace(KEYCAP_SEQUENCE, "");
  const hasKeycap: boolean = withoutKeycaps.length !== text.length;
  if (!hasKeycap && !GRAPHIC_EMOJI.test(text)) return false;
  if (withoutKeycaps.trim().length === 0) return hasKeycap;
  return EMOJI_ONLY_BODY.test(withoutKeycaps);
}
