import { TYPO_QUICK_CORRECTION_PROBABILITY } from "../../../consts/aiChat/tools";
import { splitGraphemes } from "../../../libs/text";
import { isEmojiOnly } from "./replyText";
import type {
  CharacterTypo,
  TypoCorrectionMode,
} from "../../../types/aiChat/typo";

/**
 * 按 TYPO_QUICK_CORRECTION_PROBABILITY 采样错字修正方式（补发单字修正或忽略）。
 * @returns 采样得到的错字修正模式（`"quick"` 或 `"ignore"`）。
 */
export function pickTypoCorrectionMode(): TypoCorrectionMode {
  const roll: number = Math.random();
  if (roll < TYPO_QUICK_CORRECTION_PROBABILITY) return "quick";
  return "ignore";
}

/**
 * 将 originalChar 在 text 中的首次出现位置替换为 replacementChar；
 * 原字或错字非单字素、彼此相同、为空白、为 emoji 或未出现在 text 中时返回 null。
 * @param text 待注入错字的原消息文本。
 * @param originalChar 原消息中将被替换的单字素字符。
 * @param replacementChar 替换进去的单字素错字。
 * @returns 包含错字文本、原字与错字的替换结果；校验不通过或未命中时返回 null。
 */
export function buildCharacterTypo(text: string, originalChar: string, replacementChar: string): CharacterTypo | null {
  const originalChars: string[] = splitGraphemes(originalChar);
  const replacementChars: string[] = splitGraphemes(replacementChar);
  if (originalChars.length !== 1 || replacementChars.length !== 1) return null;

  const expected: string = originalChars[0]!;
  const typo: string = replacementChars[0]!;
  if (expected === typo) return null;
  if (!expected.trim() || !typo.trim()) return null;
  if (isEmojiOnly(expected) || isEmojiOnly(typo)) return null;

  const textChars: string[] = splitGraphemes(text);
  const index: number = textChars.indexOf(expected);
  if (index === -1) return null;

  textChars[index] = typo;
  return { typoText: textChars.join(""), expected, typo };
}
