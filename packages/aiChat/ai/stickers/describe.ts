import type { Sticker, PhotoSize } from "grammy/types";
import { stickerSentTagTemplate } from "../../../consts/aiChat/prompts/transcript";
import type { TelegramVisionSource } from "../../../types/media";

/**
 * 贴纸视觉解析素材选择与对话缓存文本格式化纯函数（不接触缓存，供主线程与 AI Worker 共用）。
 */

/**
 * 选择单枚贴纸用于视觉解析的下载素材（静态贴纸取本体，动态或视频贴纸取缩略图），
 * fileUniqueId 恒保留贴纸自身的 file_unique_id；无可用素材时返回 null。
 */
export function pickStickerVisionSource(sticker: Sticker): TelegramVisionSource | null {
  const source: PhotoSize | undefined = !sticker.is_animated && !sticker.is_video ? sticker : sticker.thumbnail;
  if (!source) return null;
  return {
    fileId: source.file_id,
    fileUniqueId: sticker.file_unique_id,
    width: source.width,
    height: source.height,
  };
}

/** describeStickerForContext 读取的贴纸元数据。 */
export interface DescribeStickerForContextParams {
  /** 贴纸的情绪 emoji。 */
  emoji?: string;
  /** 所属贴纸包名。 */
  set_name?: string;
}

/**
 * 将单枚贴纸的画面描述、情绪 emoji 与所属贴纸包名格式化为对话缓存中的单行文本。
 */
export function describeStickerForContext(sticker: DescribeStickerForContextParams, visualDescription?: string): string {
  const parts: string[] = [];
  if (visualDescription) parts.push(`画面：${visualDescription}`);
  if (sticker.emoji) parts.push(`情绪含义 ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`来自贴纸包「${sticker.set_name}」`);
  return stickerSentTagTemplate(parts.join("，"));
}
