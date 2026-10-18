/** owner: workers/antiRaid。非匿名管理员邀请豁免缓存（packages/workers/antiRaid/adminCache.ts）。 */

import type { ChatAdminCache } from "../../../types/antiRaid/internal";
import { ADMIN_CACHE_TTL_MS, ANTI_RAID_CHAT_CACHE_MAX } from "../../../consts/antiRaid/cache";
import { sweepExpiredSnapshots } from "../../../libs/boundedMap";
import { FifoMap } from "../../../libs/fifoMap";

/**
 * chatId -> 非匿名管理员 ID 集合快照。
 * 填充：首次判定拉取全群管理员时写入，后续由 adminsChanged 消息增量更新。
 * 清理：读取或 sweepAdminCache 按 ADMIN_CACHE_TTL_MS 淘汰过期项，clearChatAdminCache 按群删除，resetAdminCache 清空。
 * 重建：Worker 崩溃重启后从空表开始，下次判定时重新拉取；无条目表示未知而非非管理员。
 * 容量：FifoMap 限制为 ANTI_RAID_CHAT_CACHE_MAX，满载时淘汰最早写入的群。
 */
export const chatAdmins: FifoMap<number, ChatAdminCache> = new FifoMap(ANTI_RAID_CHAT_CACHE_MAX);

/**
 * chatId -> 在途的全量管理员拉取 Promise（经 libs/keyedTask.ts 的 getOrCreateKeyedTask 去重）。
 * 填充：发起拉取时登记；清理：请求结算、clearChatAdminCache 或 resetAdminCache 时删除；重建：Worker 重启后为空；容量：不超过受管群数。
 */
export const adminFetches: Map<number, Promise<Set<number>>> = new Map();

/**
 * chatId -> (userId -> isInviterExempt)，暂存全量拉取在途期间到达的增量资格变更。
 * 填充：bufferAdminChangeDuringFetch 在拉取在途时写入；清理：takePendingAdminChanges 取走重放、clearChatAdminCache 或 resetAdminCache 时删除；重建：Worker 重启后为空；容量：仅存在于在途拉取的群。
 */
export const pendingAdminChangesDuringFetch: Map<number, Map<number, boolean>> = new Map();

/** 写入指定群的非匿名管理员豁免快照。 */
export function cacheAdminIds(chatId: number, adminIds: Set<number>, fetchedAt: number = Date.now()): void {
  chatAdmins.set(chatId, { adminIds, fetchedAt });
}

/** 在全量拉取在途期间暂存成员的邀请豁免资格增量变更。 */
export function bufferAdminChangeDuringFetch(
  chatId: number,
  userId: number,
  isInviterExempt: boolean
): void {
  if (!adminFetches.has(chatId)) return;
  let pending: Map<number, boolean> | undefined = pendingAdminChangesDuringFetch.get(chatId);
  if (!pending) {
    pending = new Map();
    pendingAdminChangesDuringFetch.set(chatId, pending);
  }
  pending.set(userId, isInviterExempt);
}

/** 取出并删除指定群在全量拉取期间暂存的资格变更。 */
export function takePendingAdminChanges(chatId: number): Map<number, boolean> | undefined {
  const pending: Map<number, boolean> | undefined = pendingAdminChangesDuringFetch.get(chatId);
  pendingAdminChangesDuringFetch.delete(chatId);
  return pending;
}

/** 淘汰已过期的管理员快照，保留仍在拉取中的群快照。 */
export function sweepAdminCache(now: number = Date.now()): number {
  return sweepExpiredSnapshots({
    snapshots: chatAdmins,
    inFlight: adminFetches,
    ttlMs: ADMIN_CACHE_TTL_MS,
    now,
  });
}

/** 清除指定群的管理员快照、在途拉取槽位与暂存增量。 */
export function clearChatAdminCache(chatId: number): void {
  chatAdmins.delete(chatId);
  adminFetches.delete(chatId);
  pendingAdminChangesDuringFetch.delete(chatId);
}

/** 清空全部管理员快照、在途拉取与暂存增量。 */
export function resetAdminCache(): void {
  chatAdmins.clear();
  adminFetches.clear();
  pendingAdminChangesDuringFetch.clear();
}
