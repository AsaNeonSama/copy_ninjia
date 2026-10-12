/**
 * 生图参考相册缓存的读写边界（状态见 cache/workers/aiChat/imageReferenceAlbums.ts）。
 *
 * mediaIngest.ts 记录媒体时写入相册图片；replyRound.ts 组装工具上下文时按主参考图补齐同一相册的
 * 其余图片。
 */

import { imageReferenceAlbums } from "../../cache/workers/aiChat/imageReferenceAlbums";
import { getAgentDeploymentConfig } from "../../config/agent";
import { IMAGE_GENERATION_MAX_REFERENCE_IMAGES } from "../../consts/aiChat/imageGeneration";
import type { AiRecordMediaMessage, ImageGenerationReference } from "../../types/aiChat/protocol";
import type { ImageReferenceAlbum, ImageReferenceAlbumPhoto } from "../../types/aiChat/imageGeneration";
import type { AgentImageCapabilityConfig } from "../../types/config";
import type { TelegramVisionSource } from "../../types/media";

/**
 * 记录一条相册里的图片；不是图片、不在相册里、相册属于别的群、同一条消息重复到达，或组已满且
 * 这张排在已记的最后一张之后时不记。组内按 messageId 升序插入，超出
 * IMAGE_GENERATION_MAX_REFERENCE_IMAGES 时丢掉 messageId 最大的一张。
 */
export function observeImageReferenceAlbumPhoto(msg: AiRecordMediaMessage): void {
  const mediaGroupId: string | undefined = msg.mediaGroupId;
  if (msg.kind !== "photo" || mediaGroupId === undefined) return;
  const album: ImageReferenceAlbum | undefined = imageReferenceAlbums.get(mediaGroupId);
  if (album === undefined) {
    imageReferenceAlbums.set(mediaGroupId, { chatId: msg.chatId, photos: [albumPhotoOf(msg)] });
    return;
  }
  if (album.chatId !== msg.chatId) return;
  const photos: ImageReferenceAlbumPhoto[] = album.photos;
  let index: number = photos.length;
  for (; index > 0; index--) {
    const previous: ImageReferenceAlbumPhoto | undefined = photos[index - 1];
    if (previous === undefined || previous.messageId < msg.messageId) break;
    if (previous.messageId === msg.messageId) return;
  }
  if (index >= IMAGE_GENERATION_MAX_REFERENCE_IMAGES) return;
  photos.splice(index, 0, albumPhotoOf(msg));
  if (photos.length > IMAGE_GENERATION_MAX_REFERENCE_IMAGES) photos.pop();
}

/** 相册缓存里的一张图：这条媒体记录的视觉源与 message_id。 */
function albumPhotoOf(msg: AiRecordMediaMessage): ImageReferenceAlbumPhoto {
  return {
    fileId: msg.fileId,
    fileUniqueId: msg.fileUniqueId,
    width: msg.width,
    height: msg.height,
    messageId: msg.messageId,
  };
}

/**
 * 本轮交给生图工具的参考图：主参考图排第一，再按相册顺序补上同一相册里的其余图片（按
 * fileUniqueId 跳过主参考图自身），合计至多 `agent.image.max_reference_images` 张。
 * 没有配置生图能力、上限为 1、主参考图不在相册里，或相册缓存里没有属于本群的这一组时，只有主参考图。
 */
export function imageGenerationReferencesFor(
  chatId: number,
  reference: ImageGenerationReference
): readonly TelegramVisionSource[] {
  const image: AgentImageCapabilityConfig | undefined = getAgentDeploymentConfig().image;
  const mediaGroupId: string | undefined = reference.mediaGroupId;
  if (image === undefined || image.maxReferenceImages === 1 || mediaGroupId === undefined) return [reference];
  const album: ImageReferenceAlbum | undefined = imageReferenceAlbums.get(mediaGroupId);
  if (album?.chatId !== chatId) return [reference];
  const references: TelegramVisionSource[] = [reference];
  for (const photo of album.photos) {
    if (references.length >= image.maxReferenceImages) break;
    if (photo.fileUniqueId !== reference.fileUniqueId) references.push(photo);
  }
  return references;
}
