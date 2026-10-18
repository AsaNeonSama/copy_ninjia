/** owner: main。临时广告免检未确认落盘写入表与发号器（packages/infra/identityPolicy/temporaryAdBypass.ts）。 */

import type {
  UnacknowledgedTemporaryAdBypassWrite,
} from "../../types/temporaryAdBypass";

/**
 * 临时广告免检未确认落盘写入表（身份 ID -> 最新写入状态）：写入时按身份原地合并并更新 revision，收到匹配 revision 的 SQLite ACK 时删除；Disk I/O Worker 重建时按 revision 顺序重放。
 * 容量受 STORAGE_PENDING_MAX_ENTRIES 与 STORAGE_PENDING_MAX_BYTES 预算约束，超限拒绝新主键写入且不淘汰未确认条目；进程重启或 resetTemporaryAdBypassCache 时清空。
 */
export const unacknowledgedTemporaryAdBypassWrites: Map<
  number,
  UnacknowledgedTemporaryAdBypassWrite
> = new Map();

/** 临时广告免检写入的单调递增 revision 发号器：每次写入自增，Disk I/O Worker 重建不重置，进程重启或 resetTemporaryAdBypassCache 时归零。 */
export const temporaryAdBypassWriteRevision: { current: number } = { current: 0 };

/** 清空临时广告免检未确认写入表与 revision 发号器（由 resetIdentityStorageCache 调用）。 */
export function resetTemporaryAdBypassCache(): void {
  unacknowledgedTemporaryAdBypassWrites.clear();
  temporaryAdBypassWriteRevision.current = 0;
}
