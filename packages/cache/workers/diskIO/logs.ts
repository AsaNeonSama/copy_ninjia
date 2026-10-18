/** owner: workers/diskIO。按日错误日志文件追加状态（packages/workers/diskIO/logFiles.ts）。 */

import type { BufferedLogEntry, DayFileState } from "../../../types/diskIO/storage";

/** 当前日志日文件追加游标单例：打开或写入成功时填充，追加失败、跨日或 resetLogCache 时置为 null，Worker 重建后由下次写入重新探测。 */
export const loggerFileState: { current: DayFileState | null } = { current: null };

/** 日志文件追加失败后允许重新打开的最早时间戳（初始零值表示无待退避失败，退避窗口为 LOG_REOPEN_RETRY_MS）：追加失败时设置，追加成功或 resetLogCache 时归零；单例标量。 */
export const loggerReopenState: { retryAt: number } = { retryAt: 0 };

/** 当前诊断批次内待刷的日志条目缓冲：handleLogMessage 逐条追加，批次消费末尾由 flushLogBuffer 整批取走清空；容量上限为 DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES，Worker 重建后从空缓冲开始（未确认诊断批由主线程重发）。 */
export const flushBuffer: { entries: BufferedLogEntry[] } = { entries: [] };

/** 清空日志待刷批次并重置文件游标与重开退避时间戳。 */
export function resetLogCache(): void {
  flushBuffer.entries = [];
  loggerFileState.current = null;
  loggerReopenState.retryAt = 0;
}
