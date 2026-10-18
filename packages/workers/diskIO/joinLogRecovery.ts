import { durableUnlinkSync } from "../../libs/atomicFile";
import { bestEffortUnlink, listOptionalDirectory } from "../../libs/fileAccess";
import {
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  joinLogCleanupDay,
  joinLogDeletions,
  joinLogFileCaches,
  joinLogRetryAt,
} from "../../cache/workers/diskIO/joinLog";
import {
  JOIN_LOG_FILE_PATTERN,
  JOIN_LOG_FILE_RETENTION_DAYS,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
} from "../../consts/diskIO/joinLog";
import { JOIN_LOG_MEMORY_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import { DAY_MS } from "../../consts/time";
import { getTimeZone } from "../../config/time";
import { invalidInput, readUtf8TextInput } from "../../libs/inputValidation";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import {
  getDateKey,
  isCanonicalDateKey,
} from "../../libs/time";
import type { JoinLogRecord } from "../../types/diskIO/storage";
import { openValidatedAppendOnlyFile } from "./appendOnlyDayFile";
import {
  assertJoinLogSchema,
  latestJoinLogRecords,
  recentJoinLogDayKeys,
} from "./joinLogRecords";

/** 一份已通过领域 schema 校验的入群日志文件：原始字节与解析结果。 */
export interface ValidatedJoinLogFile {
  readonly content: string;
  readonly parsed: Record<string, JoinLogRecord>;
}

/** 计算入群日志保留的公历日期集合（至少覆盖 `JOIN_LOG_FILE_RETENTION_DAYS` 个日期及前一日零点起向前 `DAY_MS` 的窗口）。 */
export function retainedJoinLogDayKeys(today: string): ReadonlySet<string> {
  const current: Temporal.PlainDate = Temporal.PlainDate.from(today);
  const previousStart: number = current.subtract({ days: 1 })
    .toZonedDateTime(getTimeZone()).epochMilliseconds;
  const oldest: Temporal.PlainDate = Temporal.PlainDate.from(getDateKey(previousStart - DAY_MS));
  return recentJoinLogDayKeys(today, Math.max(
    JOIN_LOG_FILE_RETENTION_DAYS,
    oldest.until(current).days + 1
  ));
}

/** 读取并严格校验一份已存在的入群日志文件。 */
export async function readValidatedJoinLogFile(
  path: string
): Promise<ValidatedJoinLogFile> {
  let content: string;
  let candidate: unknown;
  try {
    content = await readUtf8TextInput(path);
    candidate = JSON.parse(content) as unknown;
  } catch {
    return invalidInput(path, "$", "a readable valid JSON document");
  }
  assertJoinLogSchema(path, candidate);
  return { content, parsed: candidate };
}

/** 按文件名清理保留窗口外的入群日志文件与遗留临时文件。 */
export async function cleanupExpiredJoinLogDays(
  today: string,
  knownNames?: readonly string[]
): Promise<void> {
  mkdirSync(JOIN_LOG_MEMORY_DIR, { recursive: true });
  const names: readonly string[] = knownNames ?? readdirSync(JOIN_LOG_MEMORY_DIR);
  const retainedDays: ReadonlySet<string> =
    retainedJoinLogDayKeys(today);
  for (const name of names) {
    const path: string = join(JOIN_LOG_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      await bestEffortUnlink(path);
      continue;
    }
    const match: RegExpExecArray | null = JOIN_LOG_FILE_PATTERN.exec(name);
    if (match === null || retainedDays.has(match[2]!) || match[2]! > today) continue;
    if (!await bestEffortUnlink(path)) continue;
    const key: string = `${Number(match[1]!)}:${match[2]!}`;
    joinLogFileCaches.delete(key);
    joinLogRetryAt.delete(key);
  }
  joinLogCleanupDay.current = today;
}

/** 删除指定群的全部入群日志文件并清除对应缓存与退避状态；全部删除成功后摘除 `joinLogDeletions` 标记。 */
export function purgeChatJoinLogFiles(chatId: number): void {
  let names: readonly string[];
  try {
    mkdirSync(JOIN_LOG_MEMORY_DIR, { recursive: true });
    names = readdirSync(JOIN_LOG_MEMORY_DIR);
  } catch (error: unknown) {
    console.error(`[diskIOWorker] failed to list join logs while purging chat ${chatId}:`, error);
    return;
  }
  let purged: boolean = true;
  for (const name of names) {
    const match: RegExpExecArray | null = JOIN_LOG_FILE_PATTERN.exec(name);
    if (match === null || Number(match[1]!) !== chatId) continue;
    try {
      durableUnlinkSync(join(JOIN_LOG_MEMORY_DIR, name));
    } catch (error: unknown) {
      console.error(`[diskIOWorker] failed to delete join log ${name}:`, error);
      purged = false;
      continue;
    }
    const key: string = `${chatId}:${match[2]!}`;
    joinLogFileCaches.delete(key);
    joinLogRetryAt.delete(key);
  }
  if (purged) joinLogDeletions.delete(chatId);
}

/** 逐群重试 `joinLogDeletions` 中尚未删净的群日志，返回是否已全部删净。 */
export function purgeJoinLogDeletions(): boolean {
  if (joinLogDeletions.size === 0) return true;
  for (const chatId of [...joinLogDeletions]) purgeChatJoinLogFiles(chatId);
  return joinLogDeletions.size === 0;
}

export interface JoinLogRecoveryInspection {
  readonly today: string;
  readonly names: readonly string[];
}

/** 启动第一阶段：只读扫描保留窗口，不填充常驻 LRU 或删除文件。 */
export async function inspectJoinLogFiles(
  today: string = getDateKey()
): Promise<JoinLogRecoveryInspection> {
  const retainedDays: ReadonlySet<string> =
    retainedJoinLogDayKeys(today);
  const names: string[] = listOptionalDirectory(JOIN_LOG_MEMORY_DIR);
  for (const name of names) {
    if (name.endsWith(TMP_FILE_SUFFIX)) continue;
    const path: string = join(JOIN_LOG_MEMORY_DIR, name);
    const match: RegExpExecArray | null = JOIN_LOG_FILE_PATTERN.exec(name);
    if (match === null) {
      if (name.endsWith(".json")) {
        return invalidInput(path, "$filename", "the canonical <chatId>.<YYYY-MM-DD>.json form");
      }
      continue;
    }
    const chatIdText: string = match[1]!;
    const chatId: number = Number(chatIdText);
    const day: string = match[2]!;
    if (!isTelegramGroupChatId(chatId) || String(chatId) !== chatIdText) {
      return invalidInput(
        path,
        "$filename",
        "a canonical negative safe-integer Telegram group or channel ID"
      );
    }
    if (!isCanonicalDateKey(day)) {
      return invalidInput(path, "$filename", "a canonical calendar date");
    }
    if (day > today) {
      return invalidInput(path, "$filename", "a date no later than the current configured local day");
    }
    if (!retainedDays.has(day)) continue;
    const { content, parsed }: ValidatedJoinLogFile =
      await readValidatedJoinLogFile(path);
    const latest: Map<number, JoinLogRecord> = latestJoinLogRecords(parsed);
    if (latest.size > JOIN_LOG_MAX_USERS_PER_CHAT_DAY) {
      return invalidInput(
        path,
        "$",
        `at most ${JOIN_LOG_MAX_USERS_PER_CHAT_DAY} distinct users per chat day`
      );
    }
    openValidatedAppendOnlyFile({
      path,
      content,
      empty: Object.keys(parsed).length === 0,
    });
  }
  return { today, names };
}

/** 全域启动成功后清理过期日与临时文件。 */
export async function maintainJoinLogFiles(
  inspection: JoinLogRecoveryInspection
): Promise<void> {
  await cleanupExpiredJoinLogDays(inspection.today, inspection.names);
}
