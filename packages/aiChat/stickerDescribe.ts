/**
 * 贴纸对话缓存文本格式化纯函数（不接触缓存，供主线程与 AI Worker 共用）。
 */

import { stickerSentTagTemplate } from "../consts/aiChat/prompts/transcript";

/** describeStickerForContext 读取的贴纸元数据。 */
export interface DescribeStickerForContextParams {
  /** 贴纸的情绪 emoji。 */
  emoji?: string;
  /** 所属贴纸包名。 */
  set_name?: string;
}

/**
 * 将单枚贴纸的画面描述、情绪 emoji 与所属贴纸包名格式化为对话缓存中的单行文本。
 * @param sticker 贴纸的情绪 emoji 与所属包名元数据。
 * @param visualDescription 可选的贴纸画面文本描述。
 * @returns 写入对话记录缓存的贴纸标签文本。
 */
export function describeStickerForContext(sticker: DescribeStickerForContextParams, visualDescription?: string): string {
  const parts: string[] = [];
  if (visualDescription) parts.push(`画面：${visualDescription}`);
  if (sticker.emoji) parts.push(`情绪含义 ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`来自贴纸包「${sticker.set_name}」`);
  return stickerSentTagTemplate(parts.join("，"));
}
