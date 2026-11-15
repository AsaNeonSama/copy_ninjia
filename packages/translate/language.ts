import {
  TRANSLATE_CHINESE_EVIDENCE,
  TRANSLATE_CHINESE_TEXT,
  TRANSLATE_ENGLISH_EVIDENCE,
  TRANSLATE_ENGLISH_TEXT,
  TRANSLATE_JAPANESE_EVIDENCE,
  TRANSLATE_JAPANESE_TEXT,
  TRANSLATE_NEUTRAL_TEXT,
  TRANSLATE_UKRAINIAN_EVIDENCE,
  TRANSLATE_UKRAINIAN_TEXT,
  TRANSLATE_RUSSIAN_EVIDENCE,
  TRANSLATE_RUSSIAN_TEXT,
  TRANSLATE_LANGUAGE_LABELS,
} from "../consts/translate";
import type { TranslateLanguage } from "../types/translate";
import { TRANSLATE_TRADITIONAL_HAN } from "../consts/translateHan";

/**
 * 判断输入字符串是否为受支持的翻译语言方向代码（`TRANSLATE_LANGUAGE_LABELS` 的键）。
 * @param code 待校验的语言代码字符串。
 * @returns 属于受支持的翻译方向时返回 `true`，否则返回 `false`。
 */
export function isTranslateLanguage(code: string): code is TranslateLanguage {
  return Object.hasOwn(TRANSLATE_LANGUAGE_LABELS, code);
}

/**
 * 按字形正则启发式判断文本是否已符合目标语言文字形态或仅含中性字符（命中时调用方整条跳过翻译）。
 * 共用汉字词、无重音拉丁短句与共用西里尔字母短句仍可能存在语种歧义。
 * @param text 待判定的原文字符串。
 * @param language 目标翻译语言方向。
 * @returns 文本无需翻译时返回 `true`，需要翻译时返回 `false`。
 */
export function needsNoTranslation(text: string, language: TranslateLanguage): boolean {
  if (TRANSLATE_NEUTRAL_TEXT.test(text)) return true;
  switch (language) {
    case "ja":
      return TRANSLATE_JAPANESE_EVIDENCE.test(text) && TRANSLATE_JAPANESE_TEXT.test(text);
    case "cn":
      return TRANSLATE_CHINESE_EVIDENCE.test(text) &&
        TRANSLATE_CHINESE_TEXT.test(text) && !TRANSLATE_TRADITIONAL_HAN.test(text);
    case "en":
      return TRANSLATE_ENGLISH_EVIDENCE.test(text) && TRANSLATE_ENGLISH_TEXT.test(text);
    case "uk":
      return TRANSLATE_UKRAINIAN_EVIDENCE.test(text) && TRANSLATE_UKRAINIAN_TEXT.test(text);
    case "ru":
      return TRANSLATE_RUSSIAN_EVIDENCE.test(text) && TRANSLATE_RUSSIAN_TEXT.test(text);
  }
}
