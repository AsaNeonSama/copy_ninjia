/** owner: main。临时广告免检尚未收到 SQLite ACK 的最终值与 revision；热查询结论在
 * cache/main/identityStorage.ts 的 identityPolicyCache（temporaryAdBypass 字段）。 */

import type {
  UnacknowledgedTemporaryAdBypassWrite,
} from "../../types/temporaryAdBypass";

/**
 * SQLite 尚未精确 ACK 的主线程最终值；同一身份原地合并，ACK 后删除。
 * 不淘汰未落盘事实；批量事务（IDENTITY_WRITE_BATCH_MAX_ENTRIES 条或 IDENTITY_WRITE_FLUSH_INTERVAL_MS）
 * 持续收敛，Worker 重建时按 revision 顺序重放，进程全新初始化才整体清空。
 * 新主键在发布前受 STORAGE_PENDING_MAX_ENTRIES / STORAGE_PENDING_MAX_BYTES 限制，超限停止入口；
 * 容量由这两个预算封顶，本表不设淘汰。
 */
export const unacknowledgedTemporaryAdBypassWrites: Map<
  number,
  UnacknowledgedTemporaryAdBypassWrite
> = new Map();

/**
 * 临时广告免检累计写入 revision 发号器；主线程同步自增并在溢出前拒绝写入。
 * Disk I/O Worker 重建不回退，保证重放次序；进程全新初始化时归零。
 */
export const temporaryAdBypassWriteRevision: { current: number } = { current: 0 };

/** 清空未 ACK 最终值与 revision；只由 resetIdentityStorageCache 在测试隔离与基准重置时调用（它同时清空 identityPolicyCache）。 */
export function resetTemporaryAdBypassCache(): void {
  unacknowledgedTemporaryAdBypassWrites.clear();
  temporaryAdBypassWriteRevision.current = 0;
}
