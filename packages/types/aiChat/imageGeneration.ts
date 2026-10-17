import type { Base64PayloadDecodeFailure } from "./payload";
import type { TelegramVisionSource } from "../media";

/** 生图的官方宽高比集合。OAI 兼容侧按显式线协议映射：OpenAI 任意尺寸档逐档
 *  发送 size、标准档收敛到全系通用的标准尺寸，xAI 改传最近 aspect_ratio，见
 *  aiChat/openai/image.ts。 */
export type ImageGenerationAspectRatio =
  | "1:1" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";

/** 已校验签名、大小与 MIME 的聊天图片结果。 */
export interface GeneratedChatImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

/** 生图载荷不可用的具体原因，只用于错误日志定位；上层都按无可用图片处理。 */
export type GeneratedImageDecodeFailure =
  | Base64PayloadDecodeFailure
  | "byte signature matches neither PNG nor JPEG";

/** 按字节签名解码生图载荷的结果；失败一律带上可记日志的原因。 */
export type GeneratedImageDecodeResult =
  | { readonly ok: true; readonly image: GeneratedChatImage }
  | { readonly ok: false; readonly reason: GeneratedImageDecodeFailure };

/** AI Worker 相册缓存里的一张图：视觉源加所在消息的 message_id，相册顺序按它升序。 */
export interface ImageReferenceAlbumPhoto extends TelegramVisionSource {
  readonly messageId: number;
}

/** AI Worker 相册缓存的一项（cache/workers/aiChat/imageReferenceAlbums.ts）：相册所在的群与已见过的图。 */
export interface ImageReferenceAlbum {
  readonly chatId: number;
  /** 按 messageId 升序，按 messageId 去重，至多 IMAGE_GENERATION_MAX_REFERENCE_IMAGES 张。 */
  readonly photos: ImageReferenceAlbumPhoto[];
}
