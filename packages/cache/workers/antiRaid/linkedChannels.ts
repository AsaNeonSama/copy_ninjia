/** owner: workers/antiRaid。关联频道按需查询缓存（packages/workers/antiRaid/linkedChannel.ts）。 */

import type { LinkedChannelCache } from "../../../types/antiRaid/internal";
import { ANTI_RAID_CHAT_CACHE_MAX, LINKED_CHANNEL_TTL_MS } from "../../../consts/antiRaid/cache";
import { sweepExpiredSnapshots } from "../../../libs/boundedMap";
import { FifoMap } from "../../../libs/fifoMap";

/**
 * chatId -> 是否存在关联频道的 TTL 缓存。
 * 填充：cacheLinkedChannel 在查询结算后写入。
 * 清理：sweepLinkedChannelCache 按 LINKED_CHANNEL_TTL_MS 淘汰过期项（保留仍在拉取中的旧快照），resetLinkedChannelCache 清空。
 * 重建：Worker 崩溃重启后从空表按需重查。
 * 容量：FifoMap 限制为 ANTI_RAID_CHAT_CACHE_MAX，满载时淘汰最早写入的群。
 */
export const linkedChannels: FifoMap<number, LinkedChannelCache> = new FifoMap(ANTI_RAID_CHAT_CACHE_MAX);

/**
 * chatId -> 在途的关联频道查询 Promise（经 libs/keyedTask.ts 的 getOrCreateKeyedTask 去重）。
 * 填充：发起查询时登记；清理：查询结算或 resetLinkedChannelCache 时删除；重建：Worker 重启后为空；容量：不超过受管群数。
 */
export const linkedChannelFetches: Map<number, Promise<void>> = new Map();

/**
 * 关联频道缓存世代号，resetLinkedChannelCache 时递增以阻止旧在途查询写回。
 * 重建：Worker 崩溃重启后从零开始；容量：固定为单个数值 holder。
 */
export const linkedChannelCacheGeneration: { current: number } = { current: 0 };

/** 写入指定群的关联频道缓存快照。 */
export function cacheLinkedChannel(chatId: number, hasLinked: boolean, fetchedAt: number = Date.now()): void {
  linkedChannels.set(chatId, { hasLinked, fetchedAt });
}

/** 淘汰已过期的关联频道快照，保留仍在拉取中的群快照。 */
export function sweepLinkedChannelCache(now: number = Date.now()): number {
  return sweepExpiredSnapshots({
    snapshots: linkedChannels,
    inFlight: linkedChannelFetches,
    ttlMs: LINKED_CHANNEL_TTL_MS,
    now,
  });
}

/** 清空关联频道缓存与在途查询，并递增缓存世代号。 */
export function resetLinkedChannelCache(): void {
  linkedChannels.clear();
  linkedChannelFetches.clear();
  linkedChannelCacheGeneration.current++;
}
