import type { Message, PhotoSize, Sticker } from "grammy/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../consts/aiChat/media";
import { AD_DETECT_IMAGE_DOCUMENT_MIME_TYPES } from "../consts/antiRaid/adDetect/limits";
import { RANDOM_IMAGE_DOCUMENT_MIME_TYPES } from "../consts/imageGallery";
import { TELEGRAM_PHOTO_MAX_ASPECT_RATIO, TELEGRAM_PHOTO_MAX_DIMENSION_SUM } from "../consts/telegram";
import type { ImageDimensions, MessageImageCandidate } from "../types/hImage";
import type { TelegramVisionSource } from "../types/media";

/**
 * 取出一条消息里能收进随机图库的那张图：图片取最大尺寸；以文件发送的图片只收
 * RANDOM_IMAGE_DOCUMENT_MIME_TYPES 里的格式。其余消息返回 undefined。纯函数，不接触缓存。
 * @param message 待提取图片候选的 Telegram 消息。
 * @returns 可入库的图片文件标识与大小；不含受支持图片时返回 undefined。
 */
export function messageImageCandidate(message: Message): MessageImageCandidate | undefined {
  const photo: Message["photo"] = message.photo;
  if (photo !== undefined && photo.length > 0) {
    const largest: NonNullable<Message["photo"]>[number] = photo[photo.length - 1]!;
    return { fileId: largest.file_id, fileUniqueId: largest.file_unique_id, fileSize: largest.file_size };
  }
  const document: Message["document"] = message.document;
  if (document?.mime_type !== undefined && RANDOM_IMAGE_DOCUMENT_MIME_TYPES.has(document.mime_type)) {
    return { fileId: document.file_id, fileUniqueId: document.file_unique_id, fileSize: document.file_size };
  }
  return undefined;
}

/**
 * 这张图的尺寸是否过得了 `sendPhoto` 的两道门槛：宽高之和不超过
 * TELEGRAM_PHOTO_MAX_DIMENSION_SUM，长宽比不超过 TELEGRAM_PHOTO_MAX_ASPECT_RATIO（取长边
 * 除以短边）。两道门槛与字节上限相互独立。纯函数，只比较数字；零或负的边长按不合规处理。
 * @param params 图片的像素宽高尺寸。
 * @returns 满足 Telegram `sendPhoto` 尺寸与比例门槛时返回 true，否则返回 false。
 */
export function isSendablePhotoDimensions({ width, height }: ImageDimensions): boolean {
  if (width <= 0 || height <= 0) return false;
  if (width + height > TELEGRAM_PHOTO_MAX_DIMENSION_SUM) return false;
  const ratio: number = width >= height ? width / height : height / width;
  return ratio <= TELEGRAM_PHOTO_MAX_ASPECT_RATIO;
}

/**
 * 从 Telegram 按分辨率升序返回的 photo 档位中挑最大且未声明超限的一档；
 * 全部超限时仍退回最小档，由下载侧的真实字节上限做最终防护。选档规则的唯一实现：
 * pickPhotoFile 与 Worker 发送回执投影（infra/telegram/workerRequests.ts）都经它选档，
 * 只剩选中那一档的单元素数组再选一次仍是同一档。
 * @param sizes 按分辨率升序排列的非空 Telegram PhotoSize 数组。
 * @returns 选中的 PhotoSize 档位。
 */
export function pickPhotoSize(sizes: readonly PhotoSize[]): PhotoSize {
  for (let i: number = sizes.length - 1; i >= 0; i--) {
    const size: PhotoSize = sizes[i]!;
    if (!size.file_size || size.file_size <= MEDIA_MAX_DOWNLOAD_BYTES) return size;
  }
  return sizes[0]!;
}

/**
 * 按 pickPhotoSize 选档并转成视觉源。
 * @param sizes 按分辨率升序排列的非空 Telegram PhotoSize 数组。
 * @returns 选中档位对应的视觉媒体源描述对象。
 */
export function pickPhotoFile(sizes: readonly PhotoSize[]): TelegramVisionSource {
  const size: PhotoSize = pickPhotoSize(sizes);
  return { fileId: size.file_id, fileUniqueId: size.file_unique_id, width: size.width, height: size.height };
}

/**
 * 选择单枚贴纸用于视觉解析的下载素材（静态贴纸取本体，动态或视频贴纸取缩略图），
 * `fileUniqueId` 恒保留贴纸自身的 `file_unique_id`；无可用素材时返回 null。
 * @param sticker Telegram 贴纸对象。
 * @returns 可用于视觉下载的素材标识与尺寸；无可用静态图或缩略图时返回 null。
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

/**
 * 从普通群消息中提取用于广告视觉检测的图片下载素材：
 * - 普通图片消息（`message.photo`）经 `pickPhotoFile` 选档；
 * - 图片文件消息（`message.document`）仅接收 `AD_DETECT_IMAGE_DOCUMENT_MIME_TYPES` 白名单内的 MIME 类型，
 *   文件大小未声明或不超过 `MEDIA_MAX_DOWNLOAD_BYTES` 时取原文件，否则回退取未超限的 `document.thumbnail` 并保留原文件的 `file_unique_id`。
 * @param message 待提取广告视觉图片源的 Telegram 消息。
 * @returns 可用于视觉下载的图片源描述；不含受支持图片或文件与缩略图均不可用时返回 undefined。
 */
export function pickAdImageSource(message: Message): TelegramVisionSource | undefined {
  const photo: Message["photo"] = message.photo;
  if (photo !== undefined && photo.length > 0) {
    return pickPhotoFile(photo);
  }
  const document: Message["document"] = message.document;
  if (document?.mime_type === undefined || !AD_DETECT_IMAGE_DOCUMENT_MIME_TYPES.has(document.mime_type)) {
    return undefined;
  }
  if (document.file_size === undefined || document.file_size <= MEDIA_MAX_DOWNLOAD_BYTES) {
    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      width: document.thumbnail?.width ?? 0,
      height: document.thumbnail?.height ?? 0,
    };
  }
  const thumbnail: PhotoSize | undefined = document.thumbnail;
  if (thumbnail === undefined) return undefined;
  if (thumbnail.file_size !== undefined && thumbnail.file_size > MEDIA_MAX_DOWNLOAD_BYTES) {
    return undefined;
  }
  return {
    fileId: thumbnail.file_id,
    fileUniqueId: document.file_unique_id,
    width: thumbnail.width,
    height: thumbnail.height,
  };
}
