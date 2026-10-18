/** owner: main。相册图片收图缓存（packages/infra/mediaGroups.ts）。 */

import { MEDIA_GROUP_CACHE_MAX } from "../../consts/hImage";
import { LruCache } from "../../libs/lruCache";
import type { MediaGroupImages } from "../../types/hImage";

/**
 * Telegram media_group_id 到相册图片集合的 LRU 缓存：群消息含相册图片时写入（每组上限 MEDIA_GROUP_ITEMS_MAX 张），供 `/h_image add` 补齐同相册图片。
 * 容量上限为 MEDIA_GROUP_CACHE_MAX，满额按 LRU 淘汰最久未写入的相册；进程重启后从空表开始。
 */
export const mediaGroupImages: LruCache<string, MediaGroupImages> =
  new LruCache<string, MediaGroupImages>(MEDIA_GROUP_CACHE_MAX);
