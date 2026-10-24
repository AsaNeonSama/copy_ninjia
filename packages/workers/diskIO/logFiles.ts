/**
 * 日志文件落盘与保留期清理：将诊断批中的日志消息缓冲后按配置时区日期追加写入
 * `LOGS_DIR/<YYYY-MM-DD>.json`（支持截断修复），并保留最近 `RETENTION_DAYS` 天的日志文件。
 */

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEnvelope } from "../../types/diskIO/messages";
import type { DayFileState, BufferedLogEntry } from "../../types/diskIO/storage";
import { LOGS_DIR } from "../../consts/paths";
import {
  DAY_FILE_PATTERN,
  LOG_REOPEN_RETRY_MS,
  RETENTION_DAYS,
} from "../../consts/diskIO/appendOnly";
import { flushBuffer, loggerFileState, loggerReopenState, resetLogCache } from "../../cache/workers/diskIO/logs";
import { formatLogTimestamp, getDateKey, shiftDateKey } from "../../libs/time";
import { isPendingWithin } from "../../libs/clockWindow";
import { isPlainRecord } from "../../libs/record";
import { atomicWriteTextSync, removeOrphanedTempFiles } from "../../libs/atomicFile";
import { bestEffortUnlink, listOptionalDirectory } from "../../libs/fileAccess";
import {
  AppendOnlyFileFormatError,
  appendToDayFile,
  inspectRepairableAppendOnlyFile,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";
import type { RepairableAppendOnlyInspection } from "./appendOnlyDayFile";

/** 单条持久化日志记录结构。 */
interface LogRecord {
  /** 日志级别标识（如 `INFO`、`WARN`、`ERROR`）。 */
  level: string;
  /** 格式化后的主日志消息文本。 */
  message: string;
  /**
   * 原始参数列表。存在非字符串参数（展开后的 Error 对象等结构化数据）时为完整
   * 参数列表，否则为 undefined；undefined 不写入日志文件。
   */
  args: unknown[] | undefined;
}

/**
 * 校验日志文件的顶层对象与各条日志记录的字段类型。
 * @param path 日志文件路径（用于构造错误消息）。
 * @param parsed JSON.parse 产出的顶层候选值。
 */
function assertLogFileSchema(path: string, parsed: unknown): void {
  if (!isPlainRecord(parsed)) {
    throw new AppendOnlyFileFormatError(path, "must contain a top-level JSON object.");
  }
  for (const [index, value] of Object.values(parsed).entries()) {
    if (
      !isPlainRecord(value) ||
      typeof value.level !== "string" ||
      typeof value.message !== "string" ||
      (value.args !== undefined && !Array.isArray(value.args))
    ) {
      throw new AppendOnlyFileFormatError(path, `entry[${index}] must be a log record with string level and message and optional array args.`);
    }
  }
}

/** 某日日志文件的只读探测结果：追加游标、路径与需要原子发布的规范化文本（无需重写时为 null）。 */
interface LogDayInspection {
  /** 当日日志文件的追加游标状态。 */
  readonly state: DayFileState;
  /** 当日日志文件绝对路径。 */
  readonly path: string;
  /** 需要原子重写发布的尾部修复或规范化文本；无需重写时为 `null`。 */
  readonly rewriteContent: string | null;
}

/**
 * 接管某日日志前校验领域 schema。可解析的错误结构在通用格式化发生前就拒绝，
 * 保证原字节不变；截断内容先经 repairTruncatedAppendOnlyContent 在内存里修复，再校验
 * 修复结果。整份日文件只读一遍，只发生在启动、跨日打开，以及追加失败后按
 * LOG_REOPEN_RETRY_MS 退避的那次重试上；追加热路径不调用本函数。
 * @param day 目标日志日期键（`YYYY-MM-DD`）。
 * @returns 包含路径、待重写文本与追加游标的只读探测结果。
 */
async function inspectLogDay(day: string): Promise<LogDayInspection> {
  const path: string = join(LOGS_DIR, `${day}.json`);
  const inspection: RepairableAppendOnlyInspection<void> | null = await inspectRepairableAppendOnlyFile(
    path,
    (parsed: unknown): void => assertLogFileSchema(path, parsed)
  );
  if (inspection === null) {
    return {
      path,
      rewriteContent: null,
      state: { day, size: 0, empty: true },
    };
  }
  return {
    path,
    rewriteContent: inspection.rewriteContent,
    state: { day, size: inspection.state.size, empty: inspection.state.empty },
  };
}

/**
 * 发布探测阶段预计算的修复文本并返回日文件追加游标。
 * @param inspection 单日日志文件的只读探测结果。
 * @returns 可直接用于追加写入的日文件游标。
 */
function adoptLogDay(inspection: LogDayInspection): DayFileState {
  if (inspection.rewriteContent !== null) {
    atomicWriteTextSync(inspection.path, inspection.rewriteContent);
  }
  return inspection.state;
}

/**
 * 清理 `LOGS_DIR` 下原子写入遗留的 `*.tmp` 孤儿临时文件。
 * @param names 日志目录下的文件名列表；缺省时直接读取 `LOGS_DIR`。
 */
function cleanupStaleTmpFiles(names: readonly string[] = readdirSync(LOGS_DIR)): Promise<void> {
  return removeOrphanedTempFiles(LOGS_DIR, names);
}

/**
 * 删除超出保留期的日志文件（保留今天在内的最近 RETENTION_DAYS 天）。
 * @param names 日志目录下的文件名列表；缺省时直接读取 `LOGS_DIR`。
 */
async function cleanupOldLogs(names: readonly string[] = readdirSync(LOGS_DIR)): Promise<void> {
  const oldestKept: string = shiftDateKey(getDateKey(), 1 - RETENTION_DAYS);
  for (const name of names) {
    const match: RegExpExecArray | null = DAY_FILE_PATTERN.exec(name);
    // 删除失败不影响写入，下次跨天再试。
    if (match && match[1]! < oldestKept) await bestEffortUnlink(join(LOGS_DIR, name));
  }
}

/**
 * 将归属同一自然日的多条已序列化日志成员一次性追加写入对应日文件。
 * @param day 目标日志日期键（`YYYY-MM-DD`）。
 * @param texts 已序列化的顶层对象成员文本列表。
 * @returns 列表为空或全部追加成功时返回 true，处于退避窗口或写盘失败时返回 false。
 */
async function writeDay(day: string, texts: string[]): Promise<boolean> {
  if (texts.length === 0) return true;
  const now: number = Date.now();
  // 上一次追加失败后还在退避窗口（LOG_REOPEN_RETRY_MS）内：直接丢这一批，不重跑日文件探测与接管。
  // 系统时钟回拨超过窗口时按窗口已结束处理（libs/clockWindow.ts）。
  if (loggerFileState.current === null && isPendingWithin(loggerReopenState.retryAt, now, LOG_REOPEN_RETRY_MS)) return false;
  try {
    if (loggerFileState.current?.day !== day) {
      loggerFileState.current = adoptLogDay(await inspectLogDay(day));
      await cleanupOldLogs();
    }
    await appendToDayFile({
      dir: LOGS_DIR,
      state: loggerFileState.current,
      chunk: texts.join(",\n"),
      repair: true,
    });
    loggerReopenState.retryAt = 0;
    return true;
  } catch (err: unknown) {
    // 本批写入失败就丢弃，并重置状态让下次 flush 重新校验文件。
    loggerFileState.current = null;
    loggerReopenState.retryAt = now + LOG_REOPEN_RETRY_MS;
    console.error("[diskIOWorker] flush to disk failed:", err);
    return false;
  }
}

/** 日志目录与当日日志文件的启动只读探测结果。 */
export interface LogFilesInspection {
  /** 日志目录下的全部文件名列表。 */
  readonly names: readonly string[];
  /** 当日日志文件的只读探测结果。 */
  readonly day: LogDayInspection;
}

/**
 * 跨域启动第一阶段：只读校验当前日志，并预计算必要的规范化内容。
 * @returns 包含日志目录文件名列表与当日日志探测结果的快照。
 */
export async function inspectLogFiles(): Promise<LogFilesInspection> {
  const names: string[] = listOptionalDirectory(LOGS_DIR);
  return { names, day: await inspectLogDay(getDateKey()) };
}

/**
 * 全域 inspect 成功后接管日志游标；可修复尾部只在这一阶段原子发布。
 * @param inspection 启动只读探测阶段产出的日志状态。
 */
export function adoptLogFiles(inspection: LogFilesInspection): void {
  resetLogCache();
  mkdirSync(LOGS_DIR, { recursive: true });
  loggerFileState.current = adoptLogDay(inspection.day);
}

/**
 * 启动成功后清理日志临时文件与过期日。
 * @param inspection 启动只读探测阶段产出的日志状态。
 */
export async function maintainLogFiles(inspection: LogFilesInspection): Promise<void> {
  await cleanupStaleTmpFiles(inspection.names);
  await cleanupOldLogs(inspection.names);
}

/** 每日维护先提交内存日志，再清理孤儿临时文件与过期日文件。 */
export async function maintainLogRetention(): Promise<void> {
  if (!await flushLogBuffer()) {
    throw new Error("Failed to flush logs before daily retention maintenance.");
  }
  await cleanupStaleTmpFiles();
  await cleanupOldLogs();
}

/**
 * 立即把内存 buffer 落盘（诊断批尾、每日维护或统一 flush 指令触发时调用）。
 * @returns 缓冲为空或全部日期分组均落盘成功时返回 true，任一分组失败时返回 false。
 */
export async function flushLogBuffer(): Promise<boolean> {
  if (flushBuffer.entries.length === 0) return true;
  const entries: BufferedLogEntry[] = flushBuffer.entries;
  flushBuffer.entries = [];
  // 按天分组落盘（保持顺序），只有跨天瞬间的那批会拆成两组。
  let day: string = entries[0]!.day;
  let texts: string[] = [];
  let clean: boolean = true;
  for (const entry of entries) {
    if (entry.day !== day) {
      clean = await writeDay(day, texts) && clean;
      day = entry.day;
      texts = [];
    }
    texts.push(entry.text);
  }
  return await writeDay(day, texts) && clean;
}

/**
 * 处理一条日志消息：只入内存 buffer。调用方（diskIOWorker.ts 的诊断批）消费完整批后
 * 必定调用 flushLogBuffer，因此 buffer 不跨批累积，也不需要阈值或定时落盘。
 * @param msg 单条日志消息信封。
 */
export function handleLogMessage(msg: LogEnvelope): void {
  // message 只拼字符串参数；存在非字符串参数（展开后的 Error 对象等）时，完整
  // 参数列表只写进 args。全是字符串参数时 args 为 undefined，落盘时省略。
  const stringArgs: string[] = [];
  let hasStructuredArgs: boolean = false;
  for (const arg of msg.args) {
    if (typeof arg === "string") stringArgs.push(arg);
    else hasStructuredArgs = true;
  }
  const record: LogRecord = {
    level: msg.level,
    message: stringArgs.join(" "),
    args: hasStructuredArgs ? msg.args : undefined,
  };
  // key 以配置时区的日期时间为前缀，主线程入队时生成的 id 区分重复本地时间与同一
  // 毫秒内的日志，整批重投时保持不变；由诊断批尾的 flushLogBuffer 落盘。
  flushBuffer.entries.push({
    day: getDateKey(msg.timestamp),
    text: serializeDayFileEntry(`${formatLogTimestamp(msg.timestamp)}_${msg.id}`, record),
  });
}
