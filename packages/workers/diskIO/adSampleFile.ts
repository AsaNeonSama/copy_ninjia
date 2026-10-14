/**
 * 广告判定命中样本的旁路落盘：按 `FLUSH_MAX_ENTRIES` 或 `FLUSH_INTERVAL_MS` 批量追加到
 * `AD_SAMPLE_FILE_PATH`（支持截断修复），达到 `AD_SAMPLE_FILE_MAX_BYTES` 时按日期轮转归档，
 * 并保留最近 `AD_SAMPLE_ARCHIVE_RETENTION_DAYS` 个自然日的归档文件。
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import type { AdSampleDiskMessage } from "../../types/diskIO/messages";
import type { AppendOnlyFileState } from "../../types/diskIO/storage";
import { AD_SAMPLE_FILE_PATH, AD_SAMPLE_MEMORY_DIR } from "../../consts/paths";
import { removeOrphanedTempFiles } from "../../libs/atomicFile";
import {
  AD_SAMPLE_ARCHIVE_FILENAME_PATTERN,
  AD_SAMPLE_ARCHIVE_RETENTION_DAYS,
  AD_SAMPLE_FILE_MAX_BYTES,
  PERSISTED_FILE_MODE,
} from "../../consts/diskIO/common";
import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../consts/diskIO/appendOnly";
import {
  adSampleArchiveCursor,
  adSampleArchiveSweepDay,
  adSampleBuffer,
  adSampleFileState,
  adSampleTempsSwept,
} from "../../cache/workers/diskIO/adSample";
import { getDateKey, isCanonicalDateKey, shiftDateKey } from "../../libs/time";
import { appendToAppendOnlyFile, openAppendOnlyFile, serializeDayFileEntry } from "./appendOnlyDayFile";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";

/** 广告样本的持久化记录结构。 */
interface AdSampleRecord {
  detectedAt: string;
  chatId: number;
  senderId: number;
  label: string;
  reason: string;
  messages: AdSampleDiskMessage["messages"];
}

interface AdSampleArchiveTarget {
  readonly day: string;
  readonly index: number;
  readonly path: string;
}

export interface AdSampleArchiveEntry {
  name: string;
  isFile: boolean;
}

export interface SweepExpiredAdSampleArchivesParams {
  today: string;
  listEntries?: () => AdSampleArchiveEntry[];
  removeFile?: (path: string) => Promise<void>;
}

/** 构造样本在顶层 JSON 对象中的键：`<chatId>:<首条消息 messageId>`。 */
function sampleKey(msg: AdSampleDiskMessage): string {
  return `${msg.chatId}:${msg.messages[0]?.messageId ?? 0}`;
}

/** 清理样本目录中的孤儿临时文件，每个 Worker 生命周期最多执行一次。 */
async function sweepOrphanedTemps(): Promise<void> {
  if (adSampleTempsSwept.current) return;
  adSampleTempsSwept.current = true;
  try {
    await removeOrphanedTempFiles(
      AD_SAMPLE_MEMORY_DIR,
      readdirSync(AD_SAMPLE_MEMORY_DIR),
      `.${basename(AD_SAMPLE_FILE_PATH)}.`
    );
  } catch (error: unknown) {
    console.error("[diskIOWorker] failed to sweep orphaned ad sample temps:", error);
  }
}

/** 列出样本目录项及其是否为普通文件。 */
function listAdSampleArchiveEntries(): AdSampleArchiveEntry[] {
  return readdirSync(AD_SAMPLE_MEMORY_DIR, { withFileTypes: true }).map(
    (entry: Dirent<string>): AdSampleArchiveEntry => ({
      name: entry.name,
      isFile: entry.isFile(),
    })
  );
}

/** 提取归档文件名中的有效公历日期；不匹配时返回 null。 */
function archiveDayFromName(name: string): string | null {
  const matched: RegExpExecArray | null = AD_SAMPLE_ARCHIVE_FILENAME_PATTERN.exec(name);
  const day: string | undefined = matched?.[1];
  return day !== undefined && isCanonicalDateKey(day) ? day : null;
}

/** 清理超出保留期的样本归档文件并更新当日归档序号游标；同一自然日只执行一次。 */
export async function sweepExpiredAdSampleArchives({
  today,
  listEntries = listAdSampleArchiveEntries,
  removeFile = (path: string): Promise<void> => Bun.file(path).delete(),
}: SweepExpiredAdSampleArchivesParams): Promise<void> {
  const previousDay: string | null = adSampleArchiveSweepDay.current;
  if (previousDay !== null && today <= previousDay) return;
  adSampleArchiveSweepDay.current = today;
  const earliestRetainedDay: string = shiftDateKey(today, 1 - AD_SAMPLE_ARCHIVE_RETENTION_DAYS);
  let entries: AdSampleArchiveEntry[];
  try {
    entries = listEntries();
  } catch (error: unknown) {
    console.error("[diskIOWorker] failed to sweep expired ad sample archives:", error);
    return;
  }
  let occupiedTodayIndexes: Set<number> | null = null;
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const archiveDay: string | null = archiveDayFromName(entry.name);
    if (archiveDay === today) {
      const match: RegExpExecArray | null = AD_SAMPLE_ARCHIVE_FILENAME_PATTERN.exec(entry.name);
      const suffix: string | undefined = match?.[2];
      const index: number = suffix === undefined ? 1 : Number(suffix);
      if (suffix === undefined || (index >= 2 && Number.isSafeInteger(index))) {
        occupiedTodayIndexes ??= new Set<number>();
        occupiedTodayIndexes.add(index);
      }
    }
    if (archiveDay === null || archiveDay >= earliestRetainedDay) continue;
    try {
      await removeFile(join(AD_SAMPLE_MEMORY_DIR, entry.name));
    } catch (error: unknown) {
      console.error(
        `[diskIOWorker] failed to remove expired ad sample archive ${entry.name}:`,
        error
      );
    }
  }
  if (occupiedTodayIndexes === null) {
    adSampleArchiveCursor.current = null;
  } else {
    let nextIndex: number = 1;
    while (occupiedTodayIndexes.has(nextIndex)) nextIndex++;
    adSampleArchiveCursor.current = { day: today, nextIndex };
  }
}

/** 样本目录已存在时清理孤儿临时文件与过期归档。 */
export async function maintainAdSampleFiles(
  today: string = getDateKey()
): Promise<void> {
  if (!existsSync(AD_SAMPLE_MEMORY_DIR)) return;
  await sweepOrphanedTemps();
  await sweepExpiredAdSampleArchives({ today });
}

/** 选择当前自然日下一个未被占用的归档文件路径。 */
function nextArchiveTarget(): AdSampleArchiveTarget {
  const day: string = getDateKey();
  const base: string = join(AD_SAMPLE_MEMORY_DIR, `sample.${day}`);
  let index: number = adSampleArchiveCursor.current?.day === day
    ? adSampleArchiveCursor.current.nextIndex
    : 1;
  while (true) {
    const candidate: string = index === 1
      ? `${base}.json`
      : `${base}.${index}.json`;
    if (!existsSync(candidate)) {
      return { day, index, path: candidate };
    }
    index++;
  }
}

/** 样本文件大小达到 AD_SAMPLE_FILE_MAX_BYTES 时重命名归档并重置追加游标。 */
function rotateIfOversized(state: AppendOnlyFileState): AppendOnlyFileState {
  if (state.size < AD_SAMPLE_FILE_MAX_BYTES) return state;
  const archive: AdSampleArchiveTarget = nextArchiveTarget();
  renameSync(AD_SAMPLE_FILE_PATH, archive.path);
  adSampleArchiveCursor.current = { day: archive.day, nextIndex: archive.index + 1 };
  console.error(
    `[diskIOWorker] ad sample file reached ${state.size} bytes; archived it as ${basename(archive.path)}.`
  );
  return { size: 0, empty: true };
}

/** 将缓冲中的广告样本批量追加到 `AD_SAMPLE_FILE_PATH`；失败时作废游标并丢弃本批。 */
export async function flushAdSampleBuffer(): Promise<void> {
  cancelDiskIOFlushTimer(adSampleBuffer);
  if (adSampleBuffer.chunks.length === 0) return;
  const chunk: string = adSampleBuffer.chunks.join(",\n");
  adSampleBuffer.chunks = [];
  try {
    mkdirSync(AD_SAMPLE_MEMORY_DIR, { recursive: true });
    await sweepOrphanedTemps();
    await sweepExpiredAdSampleArchives({ today: getDateKey() });
    adSampleFileState.current ??= await openAppendOnlyFile(
      AD_SAMPLE_FILE_PATH,
      PERSISTED_FILE_MODE,
      true
    );
    adSampleFileState.current = rotateIfOversized(adSampleFileState.current);
    const state: AppendOnlyFileState = adSampleFileState.current;
    await appendToAppendOnlyFile({
      path: AD_SAMPLE_FILE_PATH,
      state,
      chunk,
      mode: PERSISTED_FILE_MODE,
      repair: true,
    });
  } catch (error: unknown) {
    adSampleFileState.current = null;
    console.error("[diskIOWorker] failed to append ad detection samples:", error);
  }
}

/** 序列化一条命中样本并写入缓冲；达到 FLUSH_MAX_ENTRIES 时立即刷盘，否则启动定时刷盘。 */
export async function handleAdSampleMessage(
  msg: AdSampleDiskMessage
): Promise<void> {
  const record: AdSampleRecord = {
    detectedAt: msg.detectedAt,
    chatId: msg.chatId,
    senderId: msg.senderId,
    label: msg.label,
    reason: msg.reason,
    messages: msg.messages,
  };
  adSampleBuffer.chunks.push(serializeDayFileEntry(sampleKey(msg), record));
  if (adSampleBuffer.chunks.length >= FLUSH_MAX_ENTRIES) {
    await flushAdSampleBuffer();
    return;
  }
  armDiskIOFlushTimer(adSampleBuffer, FLUSH_INTERVAL_MS, flushAdSampleBuffer);
}
