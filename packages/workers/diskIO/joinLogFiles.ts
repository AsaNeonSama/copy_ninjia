/**
 * 入群事实的路由与调度层：缓冲、按 `chatId:day` 分组落盘、`joinLogPersisted` 处置回执、
 * 跨日清理准备与按需窗口读取。
 */

import {
  joinLogBuffer,
  joinLogCleanupDay,
  joinLogDeletions,
  joinLogPersistedNotifier,
  markJoinLogDirty,
} from "../../cache/workers/diskIO/joinLog";
import {
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_ENTRIES,
} from "../../consts/diskIO/appendOnly";
import {
  JOIN_LOG_ACCEPTED_EVENT_DAYS,
  JOIN_LOG_REOPEN_RETRY_MS,
} from "../../consts/diskIO/joinLog";
import { DAY_MS } from "../../consts/time";
import { getDateKey, shiftDateKey } from "../../libs/time";
import type {
  JoinLogDeleteDiskMessage,
  JoinLogDiskMessage,
  ReadJoinLogRequest,
} from "../../types/diskIO/messages";
import type {
  BufferedJoinLogEntry,
  JoinLogFileCache,
  JoinLogRecord,
} from "../../types/diskIO/storage";
import {
  isRecentJoinLogDay,
} from "./joinLogRecords";
import {
  cleanupExpiredJoinLogDays,
  purgeChatJoinLogFiles,
  retainedJoinLogDayKeys,
} from "./joinLogRecovery";
import {
  dayOfFileKey,
  fileKey,
  getJoinLogFileCache,
  joinLogPath,
  writeFileEntries,
} from "./joinLogWrites";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";

/**
 * 确保当日入群日志清理已完成；跨日时先刷出待写缓冲并在无保留期内失败键时清理过期日文件。
 * @param today 当前配置时区的 `YYYY-MM-DD` 日期键。
 */
async function ensureCurrentDayPrepared(today: string): Promise<void> {
  if (joinLogCleanupDay.current === today) return;
  const failedKeys: ReadonlySet<string> = await flushJoinLogEntries();
  if (failedKeys.size > 0) {
    const retainedDays: ReadonlySet<string> =
      retainedJoinLogDayKeys(today);
    for (const key of failedKeys) {
      if (!retainedDays.has(dayOfFileKey(key))) return;
    }
  }
  await cleanupExpiredJoinLogDays(today);
}

/**
 * 每日维护：刷出缓冲中待过期的入群事实后清理保留窗口外的文件。
 * @param today 当前配置时区的 `YYYY-MM-DD` 日期键；缺省为当前时刻。
 */
export async function maintainJoinLogRetention(
  today: string = getDateKey()
): Promise<void> {
  await ensureCurrentDayPrepared(today);
  if (joinLogCleanupDay.current !== today) {
    throw new Error("Failed to flush expiring join logs before daily retention maintenance.");
  }
}

/** 当已接收的最大序号或待写缓冲条数变化时，发出 `joinLogPersisted` 回执。 */
function publishJoinLogPersisted(): void {
  const through: number = joinLogBuffer.receivedThrough;
  const pendingCount: number = joinLogBuffer.entries.length;
  if (
    through === joinLogBuffer.acknowledgedThrough &&
    pendingCount === joinLogBuffer.acknowledgedPending
  ) return;
  const pending: number[] = [];
  for (const entry of joinLogBuffer.entries) pending.push(entry.sequence);
  joinLogBuffer.acknowledgedThrough = through;
  joinLogBuffer.acknowledgedPending = pendingCount;
  joinLogPersistedNotifier.current({ type: "joinLogPersisted", through, pending });
}

/**
 * 按 `chatId:day` 分组刷出缓冲中的入群事实；日期晚于当前自然日的条目与写失败分组留回缓冲重排，
 * 并发送 `joinLogPersisted` 回执。
 * @returns 本次写盘失败的 `chatId:day` 键集合。
 */
async function flushJoinLogEntries(): Promise<ReadonlySet<string>> {
  cancelDiskIOFlushTimer(joinLogBuffer);
  if (joinLogBuffer.entries.length === 0) {
    publishJoinLogPersisted();
    return new Set<string>();
  }
  const today: string = getDateKey();
  const entries: BufferedJoinLogEntry[] = joinLogBuffer.entries;
  joinLogBuffer.entries = [];
  let aheadEntries: BufferedJoinLogEntry[] | null = null;
  const groups: Map<string, {
    chatId: number;
    day: string;
    entries: BufferedJoinLogEntry[];
  }> = new Map();
  for (const entry of entries) {
    if (entry.day > today) {
      aheadEntries ??= [];
      aheadEntries.push(entry);
      continue;
    }
    const key: string = fileKey(entry.chatId, entry.day);
    let group: {
      chatId: number;
      day: string;
      entries: BufferedJoinLogEntry[];
    } | undefined = groups.get(key);
    if (group === undefined) {
      group = {
        chatId: entry.chatId,
        day: entry.day,
        entries: [],
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }

  const failedEntries: BufferedJoinLogEntry[] = [];
  const failedKeys: Set<string> = new Set<string>();
  for (const [key, group] of groups) {
    if (!await writeFileEntries(group.chatId, group.day, group.entries)) {
      failedEntries.push(...group.entries);
      failedKeys.add(key);
    }
  }
  if (failedEntries.length > 0 || aheadEntries !== null) {
    joinLogBuffer.entries = aheadEntries === null
      ? failedEntries.concat(joinLogBuffer.entries)
      : failedEntries.concat(aheadEntries, joinLogBuffer.entries);
    armDiskIOFlushTimer(
      joinLogBuffer,
      aheadEntries === null ? JOIN_LOG_REOPEN_RETRY_MS : FLUSH_INTERVAL_MS,
      flushJoinLogBuffer
    );
  }
  publishJoinLogPersisted();
  return failedKeys;
}

/**
 * 刷出缓冲并返回是否已清空全部待写与超前日期条目。
 * @returns 缓冲已全部落盘清空时返回 true，仍有失败或超前日期条目滞留时返回 false。
 */
export async function flushJoinLogBuffer(): Promise<boolean> {
  await flushJoinLogEntries();
  return joinLogBuffer.entries.length === 0;
}

/**
 * 丢弃目标群在缓冲中的待写条目，登记待删标记并立即清理该群全部入群日志文件。
 * @param msg 群入群日志删除请求消息。
 */
export function handleJoinLogDeleteMessage(msg: JoinLogDeleteDiskMessage): void {
  joinLogBuffer.entries = joinLogBuffer.entries.filter(
    (entry: BufferedJoinLogEntry): boolean => entry.chatId !== msg.chatId
  );
  joinLogDeletions.add(msg.chatId);
  purgeChatJoinLogFiles(msg.chatId);
  publishJoinLogPersisted();
}

/**
 * 接收一条入群事实：早于入群事实接收窗口（`JOIN_LOG_ACCEPTED_EVENT_DAYS`）且早于过去 24 小时滚动窗口的旧事件直接确认丢弃，其余写入缓冲并按阈值或定时器触发落盘。
 * @param msg 单条入群事实落盘消息。
 */
export async function handleJoinLogMessage(
  msg: JoinLogDiskMessage
): Promise<void> {
  const now: number = Date.now();
  const today: string = getDateKey(now);
  if (
    msg.day <= today &&
    !isRecentJoinLogDay(msg.day, today, JOIN_LOG_ACCEPTED_EVENT_DAYS) &&
    msg.day < getDateKey(now - DAY_MS)
  ) {
    joinLogBuffer.receivedThrough = msg.sequence;
    if (joinLogBuffer.entries.length === 0) publishJoinLogPersisted();
    return;
  }
  try {
    await ensureCurrentDayPrepared(today);
  } catch (error: unknown) {
    console.error("[diskIOWorker] failed to prepare the join log day:", error);
  }
  const length: number = markJoinLogDirty({
    sequence: msg.sequence,
    chatId: msg.chatId,
    day: msg.day,
    record: {
      userId: msg.userId,
      joinedAt: msg.joinedAt,
    },
  });
  joinLogBuffer.receivedThrough = msg.sequence;
  if (length >= FLUSH_MAX_ENTRIES) {
    await flushJoinLogBuffer();
    return;
  }
  armDiskIOFlushTimer(joinLogBuffer, FLUSH_INTERVAL_MS, flushJoinLogBuffer);
}

/**
 * 刷出待写缓冲后，读取指定群在 `[since, now]` 滚动窗口（跨度不超过 `DAY_MS`）内每名用户的最新入群记录并按入群时间升序返回。
 * @param request 包含目标群 ID 与滚动时间窗口边界的读取请求。
 * @returns 窗口内按 `joinedAt` 升序排列的去重入群记录列表。
 */
export async function readJoinLog(
  request: ReadJoinLogRequest
): Promise<readonly JoinLogRecord[]> {
  if (
    !Number.isSafeInteger(request.since) ||
    !Number.isSafeInteger(request.now) ||
    request.since < 0 ||
    request.now < request.since ||
    request.now - request.since > DAY_MS
  ) {
    throw new RangeError("Join log read window must be a safe rolling interval of at most 24 hours.");
  }
  const today: string = getDateKey();
  await ensureCurrentDayPrepared(today);
  const failedKeys: ReadonlySet<string> = await flushJoinLogEntries();

  const lastDay: string = getDateKey(request.now);
  const requestedDays: string[] = [];
  for (
    let day: string = getDateKey(request.since);
    day <= lastDay;
    day = shiftDateKey(day, 1)
  ) requestedDays.push(day);
  // 只认本群、本窗口文件的落盘结果。
  for (const day of requestedDays) {
    if (failedKeys.has(fileKey(request.chatId, day))) {
      throw new Error(
        `Failed to flush pending join logs for chat ${request.chatId} on ${day} before reading.`
      );
    }
  }
  const latestByUser: Map<number, JoinLogRecord> = new Map();
  const retainedDays: ReadonlySet<string> = retainedJoinLogDayKeys(today);
  for (const day of requestedDays) {
    if (!retainedDays.has(day)) {
      continue;
    }
    const path: string = joinLogPath(request.chatId, day);
    if (!await Bun.file(path).exists()) continue;
    const cache: JoinLogFileCache =
      await getJoinLogFileCache(request.chatId, day);
    for (const record of cache.latestByUser.values()) {
      if (record.joinedAt < request.since || record.joinedAt > request.now) {
        continue;
      }
      const current: JoinLogRecord | undefined =
        latestByUser.get(record.userId);
      if (current === undefined || record.joinedAt > current.joinedAt) {
        latestByUser.set(record.userId, record);
      }
    }
  }
  const records: JoinLogRecord[] = [...latestByUser.values()];
  records.sort((
    left: JoinLogRecord,
    right: JoinLogRecord
  ): number => left.joinedAt - right.joinedAt);
  return records;
}
