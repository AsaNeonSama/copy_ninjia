/** owner: workers/aiChat。非贴纸目录媒体的临时视觉/语音描述缓存（packages/aiChat/ai/imageDescription.ts）。 */

import type { SharedResult } from "../../../libs/sharedResult";
import { LruCache } from "../../../libs/lruCache";
import { MEDIA_DESCRIPTION_CACHE_MAX } from "../../../consts/aiChat/media";

/**
 * 媒体 file_unique_id 到描述解析 Promise 的 LRU 缓存（白名单贴纸包走常驻目录，不经过本表）：
 * - 填充与清理：首次解析该媒体时写入在途 Promise 供并发调用方复用，解析失败（返回 null）时立即删除以便后续重试；
 * - 容量与淘汰：上限为 MEDIA_DESCRIPTION_CACHE_MAX，满额按 LRU 淘汰最久未命中项，不设 TTL；Worker 重建后从空表开始。
 */
export const transientDescriptionCache: LruCache<string, Promise<string | null>> = new LruCache(MEDIA_DESCRIPTION_CACHE_MAX);

/** 在途描述 Promise 到可取消共享结果（SharedResult）的 WeakMap：创建解析任务时写入，任务结算时删除（全部订阅者取消时中止底层请求）；容量受媒体执行器并发与等待上限约束，Worker 重建后从空表开始。 */
export const transientDescriptionTasks: WeakMap<Promise<string | null>, SharedResult<string | null>> =
  new WeakMap<Promise<string | null>, SharedResult<string | null>>();
