/** owner: main。身份策略 LRU 与未 ACK 写入；跨线程只通过 Disk I/O 消息同步。 */

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
 * 身份 id -> 白名单、黑名单、临时广告免检三项热查询结论（条目语义见 types/identityStorage.ts 的
 * IdentityPolicyCacheEntry：undefined 未加载、null 确证不存在）。容量 IDENTITY_READ_CACHE_MAX_ENTRIES，
 * 三项随条目一起按 LRU 淘汰。
 * 填充：prefetchIdentityPolicies / readIdentityPolicyVerdicts 每个 id 一次整条写入；写入路径
 * （infra/identityStorage/write.ts、infra/identityPolicy/temporaryAdBypass.ts）按字段覆盖，条目不存在
 * 时先建三字段齐全的条目，其余字段为 undefined。
 * 读取：cachedWhitelistEntry、cachedBlocklistEntry、hasActiveTemporaryAdBypass(At) 用 `get`
 * 刷新热度；同一条消息的后续读取命中最新端，不再移动节点。isIdentityPolicyCached、写入前校验与
 * recordTemporaryAdBypassActivity 用 `peek`，不刷新热度。
 * 清理：启动接管计数时整表清空；进程重启归零，由预热重新填充。Disk I/O Worker 重建期间本表继续
 * 提供同步最终值，冷缺失在新 Worker 激活后重新预读。
 */
export const identityPolicyCache: LruCache<number, IdentityPolicyCacheEntry> =
  new LruCache(IDENTITY_READ_CACHE_MAX_ENTRIES);

/** 启动时从 SQLite 取得的两表计数；之后随已预热主键的本地最终值变化增减。 */
export const identityEntryCounts: {
  whitelist: number;
  blocklist: number;
} = { whitelist: 0, blocklist: 0 };

/**
 * 白名单未 ACK 最终值；同一主键反复修改只保留最新 revision。
 * 清理：收到该 revision 的 durable ACK 时按主键删除；Disk I/O Worker 重建时
 * 不清空，整表由 onDiskIORespawn 重放，ACK 到达才移出。
 * 容量：未 ACK 字节总数由 unacknowledgedIdentityBytes 记账并受写预算约束，
 * 超限拒收新事实，不淘汰已登记的最终值。
 */
export const unacknowledgedWhitelistWrites: Map<
  number,
  UnacknowledgedIdentityWrite
> = new Map();

/**
 * 黑名单未 ACK 最终值；同一主键反复修改只保留最新 revision。
 * 清理、重放与容量策略同 unacknowledgedWhitelistWrites。
 */
export const unacknowledgedBlocklistWrites: Map<
  number,
  UnacknowledgedIdentityWrite
> = new Map();

/**
 * 两表各一项未 ACK 字节总数；发布最终值时按差额更新，精确 ACK 释放，reset 清零。
 * Disk I/O Worker 重建时与主线程未 ACK 表一起保留，重放不重复记账。
 */
export const unacknowledgedIdentityBytes: { current: Record<IdentityPolicyTable, number> } = {
  current: { whitelist: 0, blocklist: 0 },
};

/** 身份策略写入 revision 发号器；只在主线程同步自增。 */
export const identityWriteRevision: { current: number } = { current: 0 };

/**
 * 待踢 outbox 已发出、尚未收到精确事务 ACK 的行 -> 最近一次写入（revision 与投递结果）。
 * 填充：infra/blocklist/outbox.ts 每次改动一行都发一条 blocklistRemovalWrite 并登记。
 * 清理：收到 (removalId, revision) 精确 ACK 时删除；迟到的旧 ACK 不删更新的写。Disk I/O Worker
 * 重建时不清空，按 revision 顺序重放（正文从 pendingBlockedRemovals 现编码，行已不在即删除）。
 * 容量：行数受 outbox 硬顶 BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES 与在途删除约束，ACK 后回落。
 */
export const unacknowledgedRemovalWrites: Map<number, UnacknowledgedRemovalWrite> = new Map();

/** 待踢任务行写入 revision 发号器；只在主线程同步自增，Worker 重建不回退。 */
export const removalWriteRevision: { current: number } = { current: 0 };

/** 按表取得未 ACK Map，供迟到读覆盖与 Worker 重建重放。 */
export function unacknowledgedIdentityWrites(
  table: IdentityPolicyTable
): Map<number, UnacknowledgedIdentityWrite> {
  return table === "whitelist"
    ? unacknowledgedWhitelistWrites
    : unacknowledgedBlocklistWrites;
}

/** 测试隔离与基准重置时清空有界缓存与一致性水位；生产进程从模块初始值开始。 */
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
  removalWriteRevision.current = 0;
  resetTemporaryAdBypassCache();
}
