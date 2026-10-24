/** owner: main。身份策略 LRU 缓存与未确认落盘写入表（packages/infra/identityStorage/）。 */

import { IDENTITY_READ_CACHE_MAX_ENTRIES } from "../../consts/identityStorage";
import { LruCache } from "../../libs/lruCache";
import type { IdentityPolicyTable } from "../../types/identityPolicy";
import type {
  IdentityPolicyCacheEntry,
  UnacknowledgedIdentityWrite,
  UnacknowledgedRemovalWrite,
} from "../../types/identityStorage";
import { resetTemporaryAdBypassCache } from "./temporaryAdBypass";

/**
 * 身份 ID 到白名单、黑名单与临时广告免检三态结论的 LRU 缓存（条目字段语义见 types/identityStorage.ts 的 IdentityPolicyCacheEntry）：
 * - 填充：prefetchIdentityPolicies / readIdentityPolicyVerdicts 整条写入，或写入路径按字段覆盖；
 * - 读取：cachedWhitelistEntry、cachedBlocklistEntry、hasActiveTemporaryAdBypass(At) 使用 get 刷新 LRU 顺位，其余探测使用 peek；
 * - 清理与容量：容量上限为 IDENTITY_READ_CACHE_MAX_ENTRIES，满额按 LRU 淘汰；启动接管或 resetIdentityStorageCache 时清空，进程重启后从 SQLite 预热重建。
 */
export const identityPolicyCache: LruCache<number, IdentityPolicyCacheEntry> =
  new LruCache(IDENTITY_READ_CACHE_MAX_ENTRIES);

/** 白名单与黑名单当前总条目数：启动时从 SQLite 加载初始化，运行期随本地最终值增删同步增减，resetIdentityStorageCache 时清零。 */
export const identityEntryCounts: {
  whitelist: number;
  blocklist: number;
} = { whitelist: 0, blocklist: 0 };

/**
 * 白名单未确认落盘写入表（主键 ID -> 最新写入状态）：写入时登记或覆盖最新 revision，收到对应 revision 的 durable ACK 时移除；Disk I/O Worker 重建时由 onDiskIORespawn 全表重放。
 * 容量受 STORAGE_PENDING_MAX_ENTRIES 与 unacknowledgedIdentityBytes 预算约束，超限拒绝新写入且不淘汰未确认条目；进程重启后从空表开始。
 */
export const unacknowledgedWhitelistWrites: Map<
  number,
  UnacknowledgedIdentityWrite
> = new Map();

/** 黑名单未确认落盘写入表（主键 ID -> 最新写入状态）：填充、ACK 清理、Worker 重建重放与容量预算同 unacknowledgedWhitelistWrites。 */
export const unacknowledgedBlocklistWrites: Map<
  number,
  UnacknowledgedIdentityWrite
> = new Map();

/** 白名单与黑名单未确认写入的估算字节总数：登记或覆盖写入时按差额更新，收到精确 ACK 时扣减，resetIdentityStorageCache 时清零。 */
export const unacknowledgedIdentityBytes: { current: Record<IdentityPolicyTable, number> } = {
  current: { whitelist: 0, blocklist: 0 },
};

/** 身份策略写入的单调递增 revision 发号器：每次写入自增，进程重启或 resetIdentityStorageCache 时归零。 */
export const identityWriteRevision: { current: number } = { current: 0 };

/**
 * 黑名单待踢 outbox 未确认落盘写入表（removalId -> 最新写入状态）：infra/blocklist/outbox.ts 投递写入时登记，收到匹配 revision 的 ACK 时移除并释放字节预算；Disk I/O Worker 重建时按 revision 顺序重放。
 * 容量受 outbox 条目上限与 unacknowledgedRemovalBytes 预算约束，不淘汰未确认条目；进程重启后从空表开始。
 */
export const unacknowledgedRemovalWrites: Map<number, UnacknowledgedRemovalWrite> = new Map();

/** 待踢 outbox 未确认写入的估算字节总数：登记或覆盖写入时按差额更新，收到精确 ACK 时扣减，resetIdentityStorageCache 时清零。 */
export const unacknowledgedRemovalBytes: { current: number } = { current: 0 };

/** 待踢 outbox 写入的单调递增 revision 发号器：每次写入自增，进程重启或 resetIdentityStorageCache 时归零。 */
export const removalWriteRevision: { current: number } = { current: 0 };

/**
 * 按表名返回对应的未确认身份策略写入 Map。
 *
 * @param table 身份策略表名（`whitelist` 或 `blocklist`）
 * @returns 对应表的未确认写入映射表
 */
export function unacknowledgedIdentityWrites(
  table: IdentityPolicyTable
): Map<number, UnacknowledgedIdentityWrite> {
  return table === "whitelist"
    ? unacknowledgedWhitelistWrites
    : unacknowledgedBlocklistWrites;
}

/** 清空身份策略 LRU、计数与全部未确认写入状态，并重置临时广告免检缓存。 */
export function resetIdentityStorageCache(): void {
  identityPolicyCache.clear();
  identityEntryCounts.whitelist = 0;
  identityEntryCounts.blocklist = 0;
  unacknowledgedWhitelistWrites.clear();
  unacknowledgedBlocklistWrites.clear();
  unacknowledgedIdentityBytes.current.whitelist = 0;
  unacknowledgedIdentityBytes.current.blocklist = 0;
  identityWriteRevision.current = 0;
  unacknowledgedRemovalWrites.clear();
  unacknowledgedRemovalBytes.current = 0;
  removalWriteRevision.current = 0;
  resetTemporaryAdBypassCache();
}
