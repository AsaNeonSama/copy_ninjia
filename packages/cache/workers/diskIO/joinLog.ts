/** owner: workers/diskIO。入群日志落盘游标、退避与待刷缓冲状态（packages/workers/diskIO/joinLogFiles.ts、packages/workers/diskIO/joinLogWrites.ts）。 */

import {
  JOIN_LOG_MAX_CACHED_FILES,
  JOIN_LOG_MAX_RETRY_FILES,
} from "../../../consts/diskIO/joinLog";
import { LruCache } from "../../../libs/lruCache";
import type { JoinLogPersistedReply } from "../../../types/diskIO/replies";
import type {
  BufferedJoinLogEntry,
  JoinLogFileCache,
} from "../../../types/diskIO/storage";

/** 群日文件键到追加游标与按用户最新记录索引的 LRU 缓存：读写群日文件时填充，整群删除或 resetJoinLogCache 时清除；容量上限为 JOIN_LOG_MAX_CACHED_FILES，满额按 LRU 淘汰，Worker 重建后从磁盘按需重建。 */
export const joinLogFileCaches: LruCache<string, JoinLogFileCache> =
  new LruCache<string, JoinLogFileCache>(JOIN_LOG_MAX_CACHED_FILES);

/** 追加失败的群日文件键到允许重开最早时间戳的 LRU 缓存：追加失败时写入，重开成功或到期覆盖，resetJoinLogCache 时清空；容量上限为 JOIN_LOG_MAX_RETRY_FILES，满额按 LRU 淘汰，Worker 重建后从空表开始（无条目表示不退避）。 */
export const joinLogRetryAt: LruCache<string, number> =
  new LruCache<string, number>(JOIN_LOG_MAX_RETRY_FILES);

/** 最近一次完成跨日过期文件清理的配置时区自然日：清理完成后更新，Worker 重建或 resetJoinLogCache 时恢复为 null；单例字符串。 */
export const joinLogCleanupDay: { current: string | null } = { current: null };

/** 已收到 deleteJoinLog 但尚未删净对应群日文件的群 ID 集合：收到整群删除时登记，该群日文件全部 unlink 成功后摘除（失败保留至下次统一 flush 重试）；容量与受管群数上限同阶，Worker 重建后由主线程重投未确认删除。 */
export const joinLogDeletions: Set<number> = new Set();

/**
 * 待刷入群事实缓冲、定时刷盘 timer 与处置回执水位状态：
 * - entries 由 handleJoinLogMessage 填充，满 FLUSH_MAX_ENTRIES 条、FLUSH_INTERVAL_MS 到期或显式 flush 时按群日分组追写并移除已写成项（写失败或超前日期项保留重试）；容量受主线程未确认镜像上限 JOIN_LOG_MAX_BUFFERED_ENTRIES 约束。
 * - receivedThrough 记录已接收的最大序号，acknowledgedThrough 与 acknowledgedPending 记录最近一次已发送回执的水位。
 * - Worker 重建后从空缓冲开始，由主线程按未确认镜像原序重放。
 */
export const joinLogBuffer: {
  entries: BufferedJoinLogEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  receivedThrough: number;
  acknowledgedThrough: number;
  acknowledgedPending: number;
} = {
  entries: [],
  timer: null,
  receivedThrough: 0,
  acknowledgedThrough: 0,
  acknowledgedPending: 0,
};

/** joinLogPersisted 回执发送回调单例：Disk I/O Worker 启动时安装，isolate 销毁时释放；单例函数。 */
export const joinLogPersistedNotifier: { current: (reply: JoinLogPersistedReply) => void } = {
  current: (): void => { /* 独立 owner 测试未安装 Worker 回执出口。 */ },
};

/**
 * 向待刷入群日志缓冲追加一条记录并返回当前缓冲长度。
 *
 * @param entry 待刷盘的入群日志缓冲条目
 * @returns 追加后的待刷缓冲条目总数
 */
export function markJoinLogDirty(entry: BufferedJoinLogEntry): number {
  joinLogBuffer.entries.push(entry);
  return joinLogBuffer.entries.length;
}

/** 取消定时刷盘 timer 并清空入群日志游标、退避缓存、待删集合与待刷缓冲。 */
export function resetJoinLogCache(): void {
  if (joinLogBuffer.timer !== null) clearTimeout(joinLogBuffer.timer);
  joinLogBuffer.entries = [];
  joinLogBuffer.timer = null;
  joinLogBuffer.receivedThrough = 0;
  joinLogBuffer.acknowledgedThrough = 0;
  joinLogBuffer.acknowledgedPending = 0;
  joinLogFileCaches.clear();
  joinLogRetryAt.clear();
  joinLogCleanupDay.current = null;
  joinLogDeletions.clear();
}
