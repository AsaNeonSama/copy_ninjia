/** owner: workers/diskIO。入群验证按日追加文件落盘状态（packages/workers/diskIO/verificationWrites.ts）。 */

import type { VerificationSnapshot } from
  "../../../types/antiRaid/verification";
import type { VerificationFileChange } from "../../../types/diskIO/messages";
import type { DayFileState, VerificationFlushTarget } from "../../../types/diskIO/storage";

/**
 * 待验证记录的活跃镜像表（`"chatId:userId"` -> VerificationSnapshot）：
 * - 填充：Worker 启动时由 inspectVerificationDay 与 adoptVerificationDay 从当天及最新旧日文件合并灌入，运行期由 handleVerificationUpsert 增量更新；
 * - 清理与容量：handleVerificationDelete 单条删除，跨日轮换按最新旧日重建，resetVerificationPersistenceCache 时清空；容量上限为 VERIFICATION_RECORD_CAPACITY（满额拒收新记录且不淘汰现有记录），Worker 重建后从磁盘文件重建。
 */
export const verificationWorkerCache: Map<string, VerificationSnapshot> = new Map();
/** 待刷盘的验证记录增量变更表（`"chatId:userId"` -> VerificationFileChange）：合并窗口（FLUSH_INTERVAL_MS 或满 FLUSH_MAX_ENTRIES 键）内按成员合并最新变更，flush 完成后按 revision 删除；容量上限为 VERIFICATION_RECORD_CAPACITY，Worker 重建后由主线程重投未确认 revision。 */
export const verificationPendingChanges: Map<string, VerificationFileChange> = new Map();
/** 当日验证追加文件游标与已追加条数/字节计数：打开或追加时更新，收敛重写、跨日、恢复或 resetVerificationPersistenceCache 时重置；Worker 重建后从初始值开始。 */
export const verificationFileState: {
  current: DayFileState | null;
  appendedEntries: number;
  appendedBytes: number;
} = {
  current: null,
  appendedEntries: 0,
  appendedBytes: 0,
};
/** 普通验证增量变更的合并刷盘 timer 单例：首次待刷变更进入时启动，flush 或 resetVerificationPersistenceCache 时清除；Worker 重建后从 null 开始。 */
export const verificationFlushTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
/** 单次 operationBatch 内关键验证写入的合并刷盘状态（withVerificationBatchFlush）：批次开始时置 active 为 true 并累积 target，批次结束回执前统一 flush 并复位；单例固定字段，Worker 重建后从初始值开始。 */
export const verificationBatchFlush: { active: boolean; target: VerificationFlushTarget | null } = {
  active: false,
  target: null,
};
/** 午夜跨日轮换失败后的重试 timer 单例：轮换失败时设置，重试成功、重新维护或 resetVerificationPersistenceCache 时清除；Worker 重建后从 null 开始。 */
export const verificationRolloverRetryTimer: {
  timer: ReturnType<typeof setTimeout> | null;
} = { timer: null };

/** 跨日整理或收敛时最新旧日文件的连续解码失败路径与次数：同一文件连续失败时递增、切换文件时重置为单次计数，解码成功、隔离改名或 resetVerificationPersistenceCache 时清零；单例固定字段，Worker 重建后从初始值开始。 */
export const verificationPriorDayDecodeFailures: { path: string | null; count: number } = {
  path: null,
  count: 0,
};

const verificationWriteRejected: { current: boolean } = { current: false };

/** 记录本轮发生过待验证写入拒收。 */
export function noteVerificationWriteRejected(): void {
  verificationWriteRejected.current = true;
}

/**
 * 取走并清除待验证写入拒收标记。
 *
 * @returns 本轮是否发生过待验证写入拒收
 */
export function takeVerificationWriteRejection(): boolean {
  const rejected: boolean = verificationWriteRejected.current;
  verificationWriteRejected.current = false;
  return rejected;
}

/** 取消验证刷盘与轮换重试 timer，并清空活跃镜像、待刷增量、文件游标、解码失败计数与批内合并状态。 */
export function resetVerificationPersistenceCache(): void {
  if (verificationFlushTimer.timer !== null) clearTimeout(verificationFlushTimer.timer);
  if (verificationRolloverRetryTimer.timer !== null) {
    clearTimeout(verificationRolloverRetryTimer.timer);
  }
  verificationFlushTimer.timer = null;
  verificationRolloverRetryTimer.timer = null;
  verificationWorkerCache.clear();
  verificationPendingChanges.clear();
  verificationFileState.current = null;
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
  verificationPriorDayDecodeFailures.path = null;
  verificationPriorDayDecodeFailures.count = 0;
  verificationWriteRejected.current = false;
  verificationBatchFlush.active = false;
  verificationBatchFlush.target = null;
}
