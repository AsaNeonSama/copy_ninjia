/**
 * 语音合成风格说明的拼接：按固定分隔符依次拼接基础风格、可选朗读语言要求与可选本句语气。
 */

import { TTS_LANGUAGE_SEPARATOR, TTS_TONE_SEPARATOR } from "../../../consts/aiChat/voiceMessage";

/**
 * 拼接单句语音合成的风格说明。
 * @param baseStyle 角色基础声线与说话风格描述。
 * @param languageStyle 可选的朗读语种风格补充说明。
 * @param tone 可选的单句语气提示。
 * @returns 拼接后的完整语音合成风格说明。
 */
export function composeSpeechStyle(
  baseStyle: string,
  languageStyle: string | undefined,
  tone: string | undefined
): string {
  const style: string = languageStyle === undefined
    ? baseStyle
    : baseStyle + TTS_LANGUAGE_SEPARATOR + languageStyle;
  return tone === undefined ? style : style + TTS_TONE_SEPARATOR + tone;
}
