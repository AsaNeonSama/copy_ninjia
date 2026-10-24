/** owner: workers/diskIO。每日运势文件落盘状态（packages/workers/diskIO/luckFiles.ts）。 */

import type { LuckDrawDiskMessage } from "../../../types/diskIO/messages";
import type { LuckAppendStalledReply } from "../../../types/diskIO/replies";
import type { DayFileState, LuckDayCache, LuckPendingEntry } from "../../../types/diskIO/storage";

/** 当日已落盘与待追加运势结果集合单例：hydrateLuckCache 或 startLuckDay 整体替换，运行期随抽签确认写入；容量受 DAILY_LUCK_CACHE_MAX 约束，Worker 重建后从磁盘文件与主线程重放恢复。 */
export const luckWorkerCache: { current: LuckDayCache | null } = { current: null };
/** 尚未追加到当日运势文件的抽签记录列表：markLuckDirty 追加，flushLuckAppends 写入成功或 hydrateLuckCache 时清空；容量受 DAILY_LUCK_CACHE_MAX 约束，Worker 重建后由主线程重放恢复。 */
export const luckPendingAppends: LuckPendingEntry[] = [];
/**
 * 因旧日刷盘失败而暂缓切换日期的新日抽签消息队列：handleLuckDrawMessage 在旧日刷盘失败时写入，日期切换或旧日重试成功后由 luckFiles.ts 整批取走补录（hydrateLuckCache 时清空）。
 * 容量上限为 LUCK_DEFERRED_DRAW_MAX，满额按 FIFO 淘汰最旧条目；Worker 重建后由主线程 onDiskIORespawn 重放 dailyLuckCache 恢复。
 */
export const luckDeferredDraws: LuckDrawDiskMessage[] = [];
/** 当日运势文件追加游标单例：打开或写入成功时填充，追加失败、hydrateLuckCache 或跨日时置为 null；Worker 重建后从 null 开始。 */
export const luckFileState: { current: DayFileState | null } = { current: null };
/** 运势增量批量刷盘定时器单例：首次待刷记录进入时创建，刷盘执行或 hydrateLuckCache 时清除；Worker 重建后从 null 开始。 */
export const luckFlushTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/** 运势文件追加连续失败次数与告警边沿标记（告警阈值 LUCK_APPEND_STALL_ALERT_FAILURES）：flushLuckAppends 失败时递增，追加成功或 hydrateLuckCache 时归零；Worker 重建后从初始值开始。 */
export const luckAppendFailures: { consecutive: number; alerted: boolean } =
  { consecutive: 0, alerted: false };

/** 运势追加停摆告警回执发送回调单例：startDiskIOWorker 启动时安装，isolate 销毁时释放；单例函数（null 表示未安装）。 */
export const luckAppendStalledNotifier: {
  current: ((reply: LuckAppendStalledReply) => void) | null;
} = { current: null };

/**
 * 整体替换当日运势缓存，并清空待刷批次、暂缓队列、文件游标、刷盘定时器与失败计数。
 *
 * @param day 当日运势缓存对象；无当日缓存时为 `null`
 */
export function hydrateLuckCache(day: LuckDayCache | null): void {
  if (luckFlushTimer.timer !== null) clearTimeout(luckFlushTimer.timer);
  luckFlushTimer.timer = null;
  luckWorkerCache.current = day;
  luckPendingAppends.length = 0;
  luckDeferredDraws.length = 0;
  luckFileState.current = null;
  luckAppendFailures.consecutive = 0;
  luckAppendFailures.alerted = false;
}

/**
 * 创建并切换到指定配置时区自然日的空运势缓存，同时清除旧日期运行态。
 *
 * @param day 配置时区自然日字符串（`YYYY-MM-DD`）
 * @returns 新创建的当日空运势缓存
 */
export function startLuckDay(day: string): LuckDayCache {
  const next: LuckDayCache = { day, entries: new Map() };
  hydrateLuckCache(next);
  return next;
}

/**
 * 追加一条待刷运势记录并返回当前待刷列表长度。
 *
 * @param entry 待追加落盘的运势记录
 * @returns 追加后的待刷列表长度
 */
export function markLuckDirty(entry: LuckPendingEntry): number {
  luckPendingAppends.push(entry);
  return luckPendingAppends.length;
}
