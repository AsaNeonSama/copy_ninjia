import type { AtmosphereTexts } from "../types/atmosphere";
import type { CopyMode } from "../types/chatState";
import { NYA_SUFFIX } from "../consts/copyModes";
import { splitGraphemes } from "../libs/text";

/**
 * 按 Unicode 扩展字形簇（grapheme cluster）反转字符串，保持 emoji、代理对与组合字符完整。
 * @param text 待反转的文本。
 * @returns 按字形簇反转后的字符串。
 */
function reverseText(text: string): string {
  return splitGraphemes(text).reverse().join("");
}

/**
 * 为尚未以 `NYA_SUFFIX` 结尾的文本追加空格与 `NYA_SUFFIX`。
 * 可渲染命令拦截由调用方（`auto/message/echo.ts`）负责；返回值按纯文本字符串发出（不带实体、不设 `parse_mode`）。
 * @param text 待追加后缀的文本。
 * @returns 追加后缀后的文本。
 */
function appendNyaSuffix(text: string): string {
  return text.endsWith(NYA_SUFFIX) ? text : text + " " + NYA_SUFFIX;
}

/**
 * 对复读的文字（正文或图注）应用当前激活的 copy mode 文本变换；没有模式时原样返回。
 * @param text 待变换的文字。
 * @param mode 当前激活的 copy mode（如果有）。
 * @returns 变换后的复读文本。
 */
export function applyCopyModeTransform(text: string, mode: CopyMode | undefined): string {
  switch (mode) {
    case "reverse":
      return reverseText(text);
    case "nya":
      return appendNyaSuffix(text);
    default:
      return text;
  }
}

/**
 * 返回 `/copy` 启动提示语中对应 copy mode 的效果说明片段；没有模式时返回空串。
 * @param mode 即将启动的 copy mode。
 * @param atmosphere 当前群聊氛围文案表。
 * @returns 复读模式效果说明片段。
 */
export function describeCopyModeEffect(mode: CopyMode | undefined, atmosphere: AtmosphereTexts): string {
  switch (mode) {
    case "reverse":
      return atmosphere.NOTICE_TEXTS.copyReverseEffect;
    case "nya":
      return atmosphere.NOTICE_TEXTS.copyNyaEffect;
    default:
      return "";
  }
}
