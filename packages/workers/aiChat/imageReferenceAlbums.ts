/** 生图参考相册缓存的读写边界（状态见 cache/workers/aiChat/imageReferenceAlbums.ts）。 */

import { imageReferenceAlbums } from "../../cache/workers/aiChat/imageReferenceAlbums";
import { getAgentDeploymentConfig } from "../../config/agent";
import { IMAGE_GENERATION_MAX_REFERENCE_IMAGES } from "../../consts/aiChat/imageGeneration";
import type { AiRecordMediaMessage, ImageGenerationReference } from "../../types/aiChat/protocol";
import type { ImageReferenceAlbum, ImageReferenceAlbumPhoto } from "../../types/aiChat/imageGeneration";
import type { AgentImageCapabilityConfig } from "../../types/config";
import type { TelegramVisionSource } from "../../types/media";

/**
 * 记录相册中的图片：按 messageId 升序插入对应 mediaGroupId 的相册列表，
 * 超出 IMAGE_GENERATION_MAX_REFERENCE_IMAGES 时移除末尾项。
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

/** 提取相册缓存项所需的视觉源与 message_id。 */
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
 * 组装本轮生图参考图列表：主参考图排首位，再按相册顺序补齐同相册其余图片，
 * 总数不超过 `agent.image.max_reference_images`。
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
