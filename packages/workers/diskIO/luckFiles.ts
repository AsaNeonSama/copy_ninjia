/**
 * 每日运势的缓冲、换日切换与落盘调度，跨模块约束见 docs/cn/04-invariants.md。
 */

import {
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_ENTRIES,
  LUCK_APPEND_STALL_ALERT_FAILURES,
  LUCK_DEFERRED_DRAW_MAX,
} from "../../consts/diskIO/appendOnly";
import {
  hydrateLuckCache,
  luckAppendFailures,
  luckAppendStalledNotifier,
  luckDeferredDraws,
  luckFileState,
  luckFlushTimer,
  luckPendingAppends,
  luckWorkerCache,
  markLuckDirty,
  startLuckDay,
} from "../../cache/workers/diskIO/luck";
import {
  appendLuckEntries,
  cleanupStaleLuckFiles,
  recoverLuckDay,
} from "./snapshotFiles";
import type { LuckDrawDiskMessage } from "../../types/diskIO/messages";
import type { DayFileState, LuckDayCache, LuckDrawRecord } from "../../types/diskIO/storage";
import type { LuckDayRecoveryInspection } from "./snapshotFiles";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";
import { errorMessage } from "../../libs/errorMessage";

/** 执行一次运势缓冲落盘，成功后重放跨日滞留抽签。 */
export async function retryLuckFlush(): Promise<void> {
  if (await flushLuckAppends()) await replayDeferredLuckDraws(takeDeferredLuckDraws());
}

/** 将旧日尚未刷出时到达的新日抽签暂存到有界滞留队列，参见 docs/cn/04-invariants.md。 */
function deferLuckDraw(msg: LuckDrawDiskMessage): void {
  if (luckDeferredDraws.length >= LUCK_DEFERRED_DRAW_MAX) {
    const dropped: LuckDrawDiskMessage | undefined = luckDeferredDraws.shift();
    console.error(
      `[diskIOWorker] deferred luck draw buffer is full (${LUCK_DEFERRED_DRAW_MAX}); ` +
      `dropped the oldest entry for ${dropped?.day ?? "?"}/${dropped?.key ?? "?"}`
    );
  }
  luckDeferredDraws.push(msg);
}

/** 取走全部滞留抽签；队列为空时返回 null。 */
function takeDeferredLuckDraws(): LuckDrawDiskMessage[] | null {
  return luckDeferredDraws.length > 0 ? luckDeferredDraws.splice(0, luckDeferredDraws.length) : null;
}

/** 逐条补录已取走的滞留抽签。 */
export async function replayDeferredLuckDraws(
  deferred: readonly LuckDrawDiskMessage[] | null
): Promise<void> {
  if (deferred === null) return;
  for (const pending of deferred) await handleLuckDrawMessage(pending);
}

/**
 * 切换运势日期 owner：先取出滞留抽签，再按 recoverFromDisk 从磁盘恢复或新建空 owner；
 * 磁盘恢复失败时放回滞留抽签并保持原 owner。
 */
export async function switchLuckDay(
  day: string,
  recoverFromDisk: boolean
): Promise<LuckDrawDiskMessage[] | null> {
  const deferred: LuckDrawDiskMessage[] | null = takeDeferredLuckDraws();
  if (!recoverFromDisk) {
    startLuckDay(day);
    return deferred;
  }
  try {
    await hydrateLuckDay(day);
  } catch (error: unknown) {
    if (deferred !== null) luckDeferredDraws.unshift(...deferred);
    throw error;
  }
  return deferred;
}

/**
 * 将运势待写缓冲追加落盘并清理过期日文件；失败时保留缓冲、重置文件状态并重排定时器，
 * 连续失败达 LUCK_APPEND_STALL_ALERT_FAILURES 时发出边沿告警。
 */
export async function flushLuckAppends(): Promise<boolean> {
  cancelDiskIOFlushTimer(luckFlushTimer);
  if (luckPendingAppends.length === 0) return true;
  if (!luckWorkerCache.current) return false;
  const day: string = luckWorkerCache.current.day;
  try {
    await appendLuckEntries(day, luckFileState, luckPendingAppends);
    luckPendingAppends.length = 0;
    luckAppendFailures.consecutive = 0;
    luckAppendFailures.alerted = false;
  } catch (error: unknown) {
    luckFileState.current = null;
    armDiskIOFlushTimer(luckFlushTimer, FLUSH_INTERVAL_MS, retryLuckFlush);
    console.error(`[diskIOWorker] failed to append luck entries for ${day}:`, error);
    luckAppendFailures.consecutive += 1;
    if (
      !luckAppendFailures.alerted &&
      luckAppendFailures.consecutive >= LUCK_APPEND_STALL_ALERT_FAILURES &&
      luckAppendStalledNotifier.current !== null
    ) {
      try {
        luckAppendStalledNotifier.current({
          type: "luckAppendStalled",
          day,
          pendingEntries: luckPendingAppends.length,
          consecutiveFailures: luckAppendFailures.consecutive,
          error: errorMessage(error),
        });
        luckAppendFailures.alerted = true;
      } catch (notifyError: unknown) {
        console.error("[diskIOWorker] failed to report stalled luck appends:", notifyError);
      }
    }
    return false;
  }
  try {
    await cleanupStaleLuckFiles(day);
  } catch (error: unknown) {
    console.error(`[diskIOWorker] failed to clean up stale luck files for ${day}:`, error);
  }
  return true;
}

/** 处理单条运势抽签消息：处理跨日切换与滞留重放，按键值去重后写入缓冲并调度落盘。 */
export async function handleLuckDrawMessage(
  msg: LuckDrawDiskMessage
): Promise<void> {
  const current: LuckDayCache | null = luckWorkerCache.current;
  if (current === null || msg.day > current.day) {
    if (current !== null && !await flushLuckAppends()) {
      deferLuckDraw(msg);
      console.error(
        `[diskIOWorker] refused to switch the luck day from ${current.day} to ${msg.day}: ` +
        `the previous day's confirmed results could not be flushed; ` +
        `deferred ${luckDeferredDraws.length} draw(s) until the flush succeeds`
      );
      return;
    }
    const deferred: LuckDrawDiskMessage[] | null = await switchLuckDay(msg.day, false);
    await replayDeferredLuckDraws(deferred);
  }

  const dayCache: LuckDayCache | null = luckWorkerCache.current;
  if (dayCache?.day !== msg.day) {
    console.error(
      `[diskIOWorker] discarded stale luck draw for ${msg.day}; current luck day is ${dayCache?.day ?? "none"}`
    );
    return;
  }
  const record: LuckDrawRecord = { label: msg.label, fortunePercent: msg.fortunePercent };
  const known: LuckDrawRecord | undefined = dayCache.entries.get(msg.key);
  if (known?.label === record.label && known.fortunePercent === record.fortunePercent) return;
  dayCache.entries.set(msg.key, record);
  const pendingEntries: number = markLuckDirty({ key: msg.key, record });
  if (pendingEntries >= FLUSH_MAX_ENTRIES) {
    await flushLuckAppends();
  } else {
    armDiskIOFlushTimer(luckFlushTimer, FLUSH_INTERVAL_MS, retryLuckFlush);
  }
}

/** 从磁盘严格恢复目标日运势结果并替换内存 owner 与追加游标。 */
export async function hydrateLuckDay(day: string): Promise<void> {
  const recoveredFileState: { current: DayFileState | null } = { current: null };
  const recovered: LuckDayCache | null = await recoverLuckDay(day, recoveredFileState);
  hydrateLuckCache(recovered);
  luckFileState.current = recoveredFileState.current;
}

/** 启动恢复阶段将已校验的运势结果与文件游标发布到 owner 缓存。 */
export function adoptLuckDay(
  inspection: LuckDayRecoveryInspection
): void {
  hydrateLuckCache(inspection.cache);
  luckFileState.current = inspection.fileState;
}

/** 每日维护：刷出旧日与滞留抽签后切换到目标日并清理过期文件。 */
export async function maintainLuckForDay(day: string): Promise<void> {
  const currentDay: string | undefined = luckWorkerCache.current?.day;
  if (currentDay !== undefined && day < currentDay) return;
  if (!await flushLuckAppends()) {
    throw new Error(`Failed to flush luck results before daily maintenance for ${day}.`);
  }
  await replayDeferredLuckDraws(takeDeferredLuckDraws());
  if (!await flushLuckAppends()) {
    throw new Error(`Failed to flush deferred luck results before daily maintenance for ${day}.`);
  }
  if (luckWorkerCache.current?.day !== undefined && luckWorkerCache.current.day > day) return;
  await replayDeferredLuckDraws(await switchLuckDay(day, true));
}
