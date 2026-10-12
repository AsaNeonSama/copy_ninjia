/** owner: workers/aiChat。生图参考图的相册缓存；读写边界在 workers/aiChat/imageReferenceAlbums.ts。 */

import { IMAGE_REFERENCE_ALBUM_CACHE_MAX } from "../../../consts/aiChat/imageGeneration";
import { LruCache } from "../../../libs/lruCache";
import type { ImageReferenceAlbum } from "../../../types/aiChat/imageGeneration";

/**
 * 最近见过的相册里排在最前的几张图片，键是 Telegram 的 media_group_id。
 *
 * 填充：workers/aiChat/mediaIngest.ts 记录每条带 media_group_id 的图片时写入（按 chatId 核对归属，
 * 每组只留 messageId 最小的 IMAGE_GENERATION_MAX_REFERENCE_IMAGES 张）。
 * 读取：workers/aiChat/replyRound.ts 组装回复轮工具上下文时补齐主参考图所在相册的其余图片。
 * 清理：容量 IMAGE_REFERENCE_ALBUM_CACHE_MAX 组，满额淘汰最久未使用的一组；不随群失效清理，
 * 读取时按 chatId 核对归属。测试经 resetImageReferenceAlbumCache 清空。
 * Worker 崩溃重建或进程重启后为空，此时回复轮只用触发对应的那一张。不落盘、不跨线程。
 */
export const imageReferenceAlbums: LruCache<string, ImageReferenceAlbum> =
  new LruCache<string, ImageReferenceAlbum>(IMAGE_REFERENCE_ALBUM_CACHE_MAX);

/** 测试隔离用的全量清理。 */
export function resetImageReferenceAlbumCache(): void {
  imageReferenceAlbums.clear();
}
