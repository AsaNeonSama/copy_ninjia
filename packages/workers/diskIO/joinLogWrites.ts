/**
 * 入群日志的文件接管、追加写入与快照压缩，参见 docs/cn/04-invariants.md。
 */

import {
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { BigIntStats } from "node:fs";
import {
  joinLogFileCaches,
  joinLogRetryAt,
} from "../../cache/workers/diskIO/joinLog";
import {
  JOIN_LOG_COMPACT_CHECK_BYTES,
  JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES,
  JOIN_LOG_COMPACT_REDUNDANT_ENTRIES,
  JOIN_LOG_ENTRY_SEPARATOR_BYTES,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
  JOIN_LOG_REOPEN_RETRY_MS,
} from "../../consts/diskIO/joinLog";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { JOIN_LOG_MEMORY_DIR } from "../../consts/paths";
import { atomicWriteTextChunksSync, syncDirectorySync } from "../../libs/atomicFile";
import { isPendingWithin } from "../../libs/clockWindow";
import { invalidInput } from "../../libs/inputValidation";
import type {
  AppendOnlyFileState,
  BufferedJoinLogEntry,
  JoinLogFileCache,
  JoinLogRecord,
} from "../../types/diskIO/storage";
import {
  appendToAppendOnlyFile,
  openAppendOnlyFile,
  openValidatedAppendOnlyFile,
} from "./appendOnlyDayFile";
import {
  joinLogSnapshotEntryBytes,
  joinLogSnapshotChunks,
  latestJoinLogRecords,
  measureJoinLogSnapshotBytes,
  newestBufferedJoinLogRecords,
  serializeJoinLogSnapshotEntry,
  trimJoinLogRecordsToCapacity,
} from "./joinLogRecords";
import { readValidatedJoinLogFile } from "./joinLogRecovery";
import type { ValidatedJoinLogFile } from "./joinLogRecovery";

/**
 * 构造群日入群日志文件的绝对路径。
 * @param chatId 目标群 ID。
 * @param day `YYYY-MM-DD` 日期键。
 * @returns `<JOIN_LOG_MEMORY_DIR>/<chatId>.<day>.json` 路径。
 */
export function joinLogPath(chatId: number, day: string): string {
  return join(JOIN_LOG_MEMORY_DIR, `${chatId}.${day}.json`);
}

/**
 * 构造群日入群日志在内存缓存与退避表中的复合键。
 * @param chatId 目标群 ID。
 * @param day `YYYY-MM-DD` 日期键。
 * @returns `<chatId>:<day>` 复合键字符串。
 */
export function fileKey(chatId: number, day: string): string {
  return `${chatId}:${day}`;
}

/**
 * 提取 fileKey 中的日期段。
 * @param key `<chatId>:<day>` 格式的复合键。
 * @returns 冒号后的 `YYYY-MM-DD` 日期键。
 */
export function dayOfFileKey(key: string): string {
  return key.slice(key.lastIndexOf(":") + 1);
}

/**
 * 将缓存中的去重快照原子重写到目标入群日志文件并重置压缩计数器。
 * @param path 目标入群日志文件路径。
 * @param cache 持有最新用户记录与预期字节数的群日缓存。
 */
function rewriteJoinLogFile(path: string, cache: JoinLogFileCache): void {
  const size: number = atomicWriteTextChunksSync(
    path,
    joinLogSnapshotChunks(cache.latestByUser),
    PERSISTED_FILE_MODE
  );
  if (size !== cache.snapshotBytes) {
    throw new Error(
      `Join log snapshot size mismatch: expected ${cache.snapshotBytes}, wrote ${size}.`
    );
  }
  cache.state = {
    size,
    empty: cache.latestByUser.size === 0,
  };
  cache.appendedBytesSinceCompaction = 0;
  cache.redundantEntries = 0;
}

/**
 * 读取目标路径当前文件元数据；不存在时返回 undefined。
 * @param path 目标入群日志文件路径。
 * @returns BigInt 文件元数据；文件不存在时返回 undefined。
 */
function statJoinLogFile(path: string): BigIntStats | undefined {
  return statSync(path, { bigint: true, throwIfNoEntry: false });
}

/**
 * 判断重写失败后目标路径是否已替换为新文件（stat 失败按已替换处理）。
 * @param path 目标入群日志文件路径。
 * @param before 重写前采样的文件元数据。
 * @returns 目标路径对应的底层 inode 已变更或无法再次 stat 时返回 true，否则返回 false。
 */
function joinLogFileReplaced(path: string, before: BigIntStats | undefined): boolean {
  let after: BigIntStats | undefined;
  try {
    after = statJoinLogFile(path);
  } catch {
    return true;
  }
  if (before === undefined || after === undefined) return before !== after;
  return before.ino !== after.ino || before.dev !== after.dev;
}

/**
 * 按累计计数与可回收字节数评估并执行快照重写压缩。
 * @param path 目标入群日志文件路径。
 * @param cache 当前群日入群日志的内存缓存。
 * @returns cache 是否仍与磁盘文件一致；为 false 时调用方须丢弃缓存重新接管。
 */
function maybeCompactJoinLogFile(
  path: string,
  cache: JoinLogFileCache
): boolean {
  if (
    cache.redundantEntries < JOIN_LOG_COMPACT_REDUNDANT_ENTRIES &&
    cache.appendedBytesSinceCompaction < JOIN_LOG_COMPACT_CHECK_BYTES
  ) {
    return true;
  }
  const reclaimableBytes: number =
    cache.state.size - cache.snapshotBytes;
  if (reclaimableBytes < JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES) {
    cache.appendedBytesSinceCompaction = 0;
    cache.redundantEntries = 0;
    return true;
  }
  let sampled: boolean = false;
  let before: BigIntStats | undefined;
  try {
    before = statJoinLogFile(path);
    sampled = true;
    rewriteJoinLogFile(path, cache);
    return true;
  } catch (error: unknown) {
    cache.appendedBytesSinceCompaction = 0;
    cache.redundantEntries = 0;
    const replaced: boolean = sampled && joinLogFileReplaced(path, before);
    if (replaced) syncDirectorySync(path);
    console.error(
      `[diskIOWorker] failed to compact join log ${path}; ` +
      (replaced
        ? "the snapshot was already published, so the file will be reopened:"
        : "keeping the current file and re-evaluating after more appends:"),
      error
    );
    return !replaced;
  }
}

/**
 * 严格校验文件格式与容量上限并构建 JoinLogFileCache。
 * @param path 目标入群日志文件路径。
 * @returns 初始化完成的群日入群日志缓存。
 */
async function takeOverJoinLogFile(path: string): Promise<JoinLogFileCache> {
  const existing: ValidatedJoinLogFile | null = await Bun.file(path).exists()
    ? await readValidatedJoinLogFile(path)
    : null;
  if (existing !== null) syncDirectorySync(path);
  const parsed: Record<string, JoinLogRecord> = existing === null
    ? {}
    : existing.parsed;
  const state: AppendOnlyFileState = existing === null
    ? await openAppendOnlyFile(path, PERSISTED_FILE_MODE)
    : openValidatedAppendOnlyFile({
      path,
      content: existing.content,
      empty: Object.keys(parsed).length === 0,
    });
  const latestByUser: Map<number, JoinLogRecord> =
    latestJoinLogRecords(parsed);
  if (latestByUser.size > JOIN_LOG_MAX_USERS_PER_CHAT_DAY) {
    return invalidInput(
      path,
      "$",
      `at most ${JOIN_LOG_MAX_USERS_PER_CHAT_DAY} distinct users per chat day`
    );
  }
  const cache: JoinLogFileCache = {
    state,
    latestByUser,
    snapshotBytes: measureJoinLogSnapshotBytes(latestByUser),
    appendedBytesSinceCompaction:
      state.size >= JOIN_LOG_COMPACT_CHECK_BYTES
        ? JOIN_LOG_COMPACT_CHECK_BYTES
        : 0,
    redundantEntries: 0,
    capacityWarningEmitted: false,
  };
  return cache;
}

/**
 * 首次接管群日入群日志文件并按当前大小评估一次压缩。
 * @param chatId 目标群 ID。
 * @param day `YYYY-MM-DD` 日期键。
 * @returns 与磁盘文件一致的群日入群日志缓存。
 */
async function openJoinLogFile(
  chatId: number,
  day: string
): Promise<JoinLogFileCache> {
  const path: string = joinLogPath(chatId, day);
  const cache: JoinLogFileCache = await takeOverJoinLogFile(path);
  if (maybeCompactJoinLogFile(path, cache)) return cache;
  return takeOverJoinLogFile(path);
}

/**
 * 获取或从磁盘重建指定群日的接管缓存。
 * @param chatId 目标群 ID。
 * @param day `YYYY-MM-DD` 日期键。
 * @returns 命中 LRU 或新接管的群日入群日志缓存。
 */
export async function getJoinLogFileCache(
  chatId: number,
  day: string
): Promise<JoinLogFileCache> {
  const key: string = fileKey(chatId, day);
  const cached: JoinLogFileCache | undefined = joinLogFileCaches.get(key);
  if (cached !== undefined) return cached;
  const cache: JoinLogFileCache = await openJoinLogFile(chatId, day);
  joinLogFileCaches.set(key, cache);
  return cache;
}

/**
 * 将单个 `chatId:day` 分组的待写条目写入目标文件，返回是否落盘成功。
 * @param chatId 目标群 ID。
 * @param day `YYYY-MM-DD` 日期键。
 * @param entries 待写入该群日文件的缓冲条目列表。
 * @returns 条目为空或落盘成功时返回 true，处于退避窗口或写盘失败时返回 false。
 */
export async function writeFileEntries(
  chatId: number,
  day: string,
  entries: readonly BufferedJoinLogEntry[]
): Promise<boolean> {
  if (entries.length === 0) return true;
  const key: string = fileKey(chatId, day);
  const path: string = joinLogPath(chatId, day);
  const now: number = Date.now();
  if (!joinLogFileCaches.has(key) && isPendingWithin(joinLogRetryAt.get(key) ?? 0, now, JOIN_LOG_REOPEN_RETRY_MS)) {
    return false;
  }
  try {
    mkdirSync(JOIN_LOG_MEMORY_DIR, { recursive: true });
    const cache: JoinLogFileCache = await getJoinLogFileCache(chatId, day);
    const newest: BufferedJoinLogEntry[] =
      newestBufferedJoinLogRecords(entries, cache.latestByUser);
    if (newest.length === 0) {
      joinLogRetryAt.delete(key);
      return true;
    }

    let newUsers: number = 0;
    for (const entry of newest) {
      if (!cache.latestByUser.has(entry.record.userId)) newUsers++;
    }
    if (
      cache.latestByUser.size + newUsers >
      JOIN_LOG_MAX_USERS_PER_CHAT_DAY
    ) {
      for (const entry of newest) {
        const current: JoinLogRecord | undefined =
          cache.latestByUser.get(entry.record.userId);
        const nextBytes: number =
          joinLogSnapshotEntryBytes(entry.record);
        cache.snapshotBytes += current === undefined
          ? JOIN_LOG_ENTRY_SEPARATOR_BYTES + nextBytes
          : nextBytes - joinLogSnapshotEntryBytes(current);
        cache.latestByUser.set(entry.record.userId, entry.record);
      }
      const evicted: number = trimJoinLogRecordsToCapacity(
        cache.latestByUser,
        JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
        (record: JoinLogRecord): void => {
          cache.snapshotBytes -=
            JOIN_LOG_ENTRY_SEPARATOR_BYTES + joinLogSnapshotEntryBytes(record);
        }
      );
      rewriteJoinLogFile(path, cache);
      if (!cache.capacityWarningEmitted) {
        cache.capacityWarningEmitted = true;
        console.error(
          `[diskIOWorker] join log for chat ${chatId} on ${day} exceeded ` +
          `${JOIN_LOG_MAX_USERS_PER_CHAT_DAY} users; retained the newest records and evicted ${evicted}.`
        );
      }
      joinLogRetryAt.delete(key);
      return true;
    }

    const texts: string[] = [];
    for (const entry of newest) {
      texts.push(serializeJoinLogSnapshotEntry(entry.record));
    }
    const chunk: string = texts.join(",\n");
    await appendToAppendOnlyFile({
      path,
      state: cache.state,
      chunk,
      mode: PERSISTED_FILE_MODE,
    });
    cache.appendedBytesSinceCompaction += Buffer.byteLength(chunk);
    for (const entry of newest) {
      const record: JoinLogRecord = entry.record;
      const current: JoinLogRecord | undefined =
        cache.latestByUser.get(record.userId);
      const nextBytes: number = joinLogSnapshotEntryBytes(record);
      if (current !== undefined) {
        cache.redundantEntries++;
        cache.snapshotBytes +=
          nextBytes - joinLogSnapshotEntryBytes(current);
      } else {
        cache.snapshotBytes += JOIN_LOG_ENTRY_SEPARATOR_BYTES + nextBytes;
      }
      cache.latestByUser.set(record.userId, record);
    }
    if (!maybeCompactJoinLogFile(path, cache)) joinLogFileCaches.delete(key);
    joinLogRetryAt.delete(key);
    return true;
  } catch (error: unknown) {
    joinLogFileCaches.delete(key);
    joinLogRetryAt.set(key, now + JOIN_LOG_REOPEN_RETRY_MS);
    console.error("[diskIOWorker] failed to persist join log:", error);
    return false;
  }
}
