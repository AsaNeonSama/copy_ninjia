/**
 * AI 缓存用量统计落盘：按 `FLUSH_MAX_ENTRIES` 或 `FLUSH_INTERVAL_MS` 将逐条记录追加到
 * `AI_CACHE_FILE_PATH`（支持截断修复），并在启动与每日维护时将历史记录汇总为首位的 `summary`。
 */

import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import {
  aiCacheBuffer,
  aiCacheFileState,
  aiCacheReopenState,
  resetAiCacheState,
} from "../../cache/workers/diskIO/aiCache";
import { AI_CACHE_SUMMARY_KEY } from "../../consts/diskIO/aiCache";
import {
  DAY_FILE_JSON_INDENT,
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_ENTRIES,
  LOG_REOPEN_RETRY_MS,
} from "../../consts/diskIO/appendOnly";
import { AI_CACHE_FILE_PATH, AI_CACHE_MEMORY_DIR } from "../../consts/paths";
import { atomicWriteTextSync, removeOrphanedTempFiles } from "../../libs/atomicFile";
import { isPendingWithin } from "../../libs/clockWindow";
import { listOptionalDirectory } from "../../libs/fileAccess";
import { formatLogTimestamp, getDateKey } from "../../libs/time";
import type { AiCacheDocument, AiCacheRow, AiCacheSummary } from "../../types/aiCache";
import type { AiCacheUsageDiskMessage } from "../../types/diskIO/messages";
import type { AppendOnlyFileState } from "../../types/diskIO/storage";
import {
  appendToAppendOnlyFile,
  inspectRepairableAppendOnlyFile,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";
import type { RepairableAppendOnlyInspection } from "./appendOnlyDayFile";
import { buildAiCacheSummary, decodeAiCacheDocument } from "./aiCacheDocument";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";

/** 一次只读探测的结果：解码内容、需要原子发布的规范化文本与追加游标。 */
export interface AiCacheInspection {
  readonly document: AiCacheDocument;
  readonly rewriteContent: string | null;
  readonly state: AppendOnlyFileState;
}

/** 只读探测统计文件：裁掉撕裂尾部并严格解码，不写盘。 */
export async function inspectAiCacheFile(): Promise<AiCacheInspection> {
  const inspection: RepairableAppendOnlyInspection<AiCacheDocument> | null =
    await inspectRepairableAppendOnlyFile(AI_CACHE_FILE_PATH, (parsed: unknown): AiCacheDocument => decodeAiCacheDocument(AI_CACHE_FILE_PATH, parsed));
  if (inspection === null) {
    return {
      document: { summary: null, rows: new Map() },
      rewriteContent: null,
      state: { size: 0, empty: true },
    };
  }
  return {
    document: inspection.decoded,
    rewriteContent: inspection.rewriteContent,
    state: inspection.state,
  };
}

/** 发布探测时预计算的规范化内容，并返回可追加的游标。 */
function publishInspection(inspection: AiCacheInspection): AppendOnlyFileState {
  if (inspection.rewriteContent !== null) atomicWriteTextSync(AI_CACHE_FILE_PATH, inspection.rewriteContent);
  return { size: inspection.state.size, empty: inspection.state.empty };
}

/** 跨域启动 inspect 全部成功后接管统计文件。 */
export function adoptAiCacheFile(inspection: AiCacheInspection): void {
  resetAiCacheState();
  mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
  aiCacheFileState.current = publishInspection(inspection);
}

/** 启动成功后清掉原子重写留下的孤儿临时文件，并补做错过的每日汇总。 */
export async function maintainAiCacheFile(): Promise<void> {
  await removeOrphanedTempFiles(
    AI_CACHE_MEMORY_DIR,
    listOptionalDirectory(AI_CACHE_MEMORY_DIR),
    `.${basename(AI_CACHE_FILE_PATH)}.`
  );
  await summarizeAiCache();
}

/** 收下一条用量：序列化进缓冲，达到阈值立即刷盘，否则按需排定时刷盘。 */
export async function handleAiCacheUsageMessage(message: AiCacheUsageDiskMessage): Promise<void> {
  let row: AiCacheRow;
  switch (message.kind) {
    case "cost":
      row = {
        capability: message.capability,
        provider: message.provider,
        model: message.model,
        costInUsdTicks: message.costInUsdTicks,
      };
      break;
    case "search":
      row = {
        capability: message.capability,
        provider: message.provider,
        model: message.model,
        searchCalls: message.searchCalls,
      };
      break;
    case "tokens":
      row = {
        capability: message.capability,
        provider: message.provider,
        model: message.model,
        inputTokens: message.inputTokens,
        cachedInputTokens: message.cachedInputTokens,
        cacheWriteInputTokens: message.cacheWriteInputTokens,
        outputTokens: message.outputTokens,
        searchCalls: message.searchCalls,
      };
      break;
  }
  aiCacheBuffer.texts.push(serializeDayFileEntry(
    `${formatLogTimestamp(message.timestamp)}_${crypto.randomUUID()}`,
    row
  ));
  if (aiCacheBuffer.texts.length >= FLUSH_MAX_ENTRIES) await flushAiCacheBuffer();
  else armDiskIOFlushTimer(aiCacheBuffer, FLUSH_INTERVAL_MS, flushAiCacheBuffer);
}

/**
 * 把缓冲里的记录一次追加到文件末尾。游标失效时先重新探测；上一次失败仍在退避窗口内
 * （按 libs/clockWindow.ts 的 isPendingWithin，时钟回拨超过窗口即视为结束）或本次失败时
 * 丢弃这一批并返回 false。
 */
export async function flushAiCacheBuffer(): Promise<boolean> {
  cancelDiskIOFlushTimer(aiCacheBuffer);
  if (aiCacheBuffer.texts.length === 0) return true;
  const texts: string[] = aiCacheBuffer.texts;
  aiCacheBuffer.texts = [];
  const now: number = Date.now();
  if (aiCacheFileState.current === null && isPendingWithin(aiCacheReopenState.retryAt, now, LOG_REOPEN_RETRY_MS)) return false;
  try {
    if (aiCacheFileState.current === null) {
      mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
      aiCacheFileState.current = publishInspection(await inspectAiCacheFile());
    }
    await appendToAppendOnlyFile({
      path: AI_CACHE_FILE_PATH,
      state: aiCacheFileState.current,
      chunk: texts.join(",\n"),
      repair: true,
    });
    aiCacheReopenState.retryAt = 0;
    return true;
  } catch (error: unknown) {
    aiCacheFileState.current = null;
    aiCacheReopenState.retryAt = now + LOG_REOPEN_RETRY_MS;
    console.error("[diskIOWorker] AI cache usage flush failed:", error);
    return false;
  }
}

/**
 * 每日汇总：先刷缓冲，再把 today 之前的记录汇总成其中最近一天的 summary（与同日已有汇总
 * 相加），核验新汇总的数值与分组一致性后删掉这些记录与更早的汇总，整份原子重写。
 * 没有 today 之前的记录时不写盘；新汇总非法时保留已经刷出的逐条记录。
 * @param today 配置时区的日期；缺省为当前时刻。
 */
export async function summarizeAiCache(today: string = getDateKey()): Promise<void> {
  await flushAiCacheBuffer();
  const inspection: AiCacheInspection = await inspectAiCacheFile();
  const kept: Record<string, AiCacheRow> = {};
  const pastRows: Map<string, AiCacheRow[]> = new Map();
  let latestDay: string = "";
  for (const [key, row] of inspection.document.rows) {
    const day: string = key.slice(0, 10);
    if (day >= today) {
      kept[key] = row;
      continue;
    }
    let rows: AiCacheRow[] | undefined = pastRows.get(day);
    if (rows === undefined) {
      rows = [];
      pastRows.set(day, rows);
    }
    rows.push(row);
    if (day > latestDay) latestDay = day;
  }
  if (latestDay === "") {
    if (inspection.rewriteContent !== null) aiCacheFileState.current = publishInspection(inspection);
    return;
  }
  const previous: AiCacheSummary | null = inspection.document.summary;
  const summary: AiCacheSummary = previous !== null && previous.day > latestDay
    ? previous
    : buildAiCacheSummary(latestDay, pastRows.get(latestDay)!, previous?.day === latestDay ? previous : null);
  decodeAiCacheDocument(AI_CACHE_FILE_PATH, { [AI_CACHE_SUMMARY_KEY]: summary });
  const content: string = JSON.stringify({ [AI_CACHE_SUMMARY_KEY]: summary, ...kept }, null, DAY_FILE_JSON_INDENT);
  mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
  atomicWriteTextSync(AI_CACHE_FILE_PATH, content);
  aiCacheFileState.current = { size: Buffer.byteLength(content), empty: false };
}
