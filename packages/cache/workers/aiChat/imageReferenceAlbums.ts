/** owner: workers/aiChat。生图参考图相册 LRU 缓存（packages/workers/aiChat/imageReferenceAlbums.ts）。 */

import { IMAGE_REFERENCE_ALBUM_CACHE_MAX } from "../../../consts/aiChat/imageGeneration";
import { LruCache } from "../../../libs/lruCache";
import type { ImageReferenceAlbum } from "../../../types/aiChat/imageGeneration";

/**
 * Telegram media_group_id 到相册前IMAGE_GENERATION_MAX_REFERENCE_IMAGES张图片元信息的 LRU 缓存：mediaIngest.ts 摄入相册图片时写入，replyRound.ts 组装生图参考图时按 chatId 校验读取。
 * 容量上限为 IMAGE_REFERENCE_ALBUM_CACHE_MAX，满额按 LRU 淘汰最久未使用的相册；Worker 重建或 resetImageReferenceAlbumCache 时清空。
 */
export const imageReferenceAlbums: LruCache<string, ImageReferenceAlbum> =
  new LruCache<string, ImageReferenceAlbum>(IMAGE_REFERENCE_ALBUM_CACHE_MAX);

/** 清空生图参考图相册缓存。 */
export function resetImageReferenceAlbumCache(): void {
  imageReferenceAlbums.clear();
}
