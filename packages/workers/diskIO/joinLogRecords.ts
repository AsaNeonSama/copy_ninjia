/** 入群日志记录的纯校验、折叠、序列化与容量裁剪算法。 */

import { DAY_FILE_JSON_INDENT } from "../../consts/diskIO/appendOnly";
import {
  JOIN_LOG_EMPTY_SNAPSHOT_BYTES,
  JOIN_LOG_ENTRY_SEPARATOR_BYTES,
  JOIN_LOG_SNAPSHOT_BRACE_BYTES,
  JOIN_LOG_SNAPSHOT_CHUNK_BYTES,
} from "../../consts/diskIO/joinLog";
import type {
  BufferedJoinLogEntry,
  JoinLogRecord,
} from "../../types/diskIO/storage";
import { invalidInput } from "../../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import { shiftDateKey } from "../../libs/time";

/** 条目一级缩进，宽度与 DAY_FILE_JSON_INDENT 一致。 */
const ENTRY_INDENT: string = " ".repeat(DAY_FILE_JSON_INDENT);
/** 字段两级缩进。 */
const FIELD_INDENT: string = " ".repeat(DAY_FILE_JSON_INDENT * 2);

/**
 * 判断候选值是否为合法的入群记录对象。
 * @param value 待校验的候选记录值。
 * @returns 仅包含正安全整数 `userId` 与 `joinedAt` 时返回 true，否则返回 false。
 */
function isJoinLogRecord(value: unknown): value is JoinLogRecord {
  return isPlainRecord(value) &&
    hasExactKeys(value, ["userId", "joinedAt"]) &&
    Number.isSafeInteger(value.userId) &&
    (value.userId as number) > 0 &&
    Number.isSafeInteger(value.joinedAt) &&
    (value.joinedAt as number) > 0;
}

/**
 * 严格校验入群日志文件的领域 schema。
 * @param path 入群日志文件路径（用于构造错误消息）。
 * @param parsed JSON.parse 产出的顶层未知值。
 * @returns 校验通过时断言输入为入群记录字典，否则抛出致命输入错误。
 */
export function assertJoinLogSchema(
  path: string,
  parsed: unknown
): asserts parsed is Record<string, JoinLogRecord> {
  if (!isPlainRecord(parsed)) {
    return invalidInput(path, "$", "a JSON object of join records");
  }
  for (const key in parsed) {
    if (!Object.hasOwn(parsed, key)) continue;
    const value: unknown = parsed[key];
    if (
      !isJoinLogRecord(value) ||
      key !== `${value.joinedAt}:${value.userId}`
    ) {
      return invalidInput(
        path,
        "$.<record>",
        "exactly { userId: positiveSafeInteger, joinedAt: positiveSafeInteger } under its canonical key"
      );
    }
  }
}

/**
 * 由规范日期键生成包含当日在内的前 count 个公历日期集合。
 * @param day 基准 `YYYY-MM-DD` 日期键。
 * @param count 向前覆盖的公历日天数（含 `day` 当日）。
 * @returns 覆盖窗口内的 `YYYY-MM-DD` 日期键只读集合。
 */
export function recentJoinLogDayKeys(
  day: string,
  count: number
): ReadonlySet<string> {
  const days: Set<string> = new Set<string>();
  for (let offset: number = 0; offset < count; offset++) {
    days.add(shiftDateKey(day, -offset));
  }
  return days;
}

/**
 * 判断规范日期键是否落在 anchor 及其之前的 count 个公历日期内。
 * @param candidate 待判定的 `YYYY-MM-DD` 日期键。
 * @param anchor 窗口上界 `YYYY-MM-DD` 日期键。
 * @param count 窗口包含的公历日天数。
 * @returns 落在 `[anchor - (count - 1), anchor]` 闭区间内时返回 true，否则返回 false。
 */
export function isRecentJoinLogDay(
  candidate: string,
  anchor: string,
  count: number
): boolean {
  if (candidate === anchor) return count >= 1;
  if (candidate > anchor || count <= 1) return false;
  return candidate >= shiftDateKey(anchor, 1 - count);
}

/**
 * 将文件中的历史条目折叠为每用户最后一次入群记录。
 * @param parsed 文件中按键名存储的入群记录字典。
 * @returns `userId -> 最新 JoinLogRecord` 的可变映射。
 */
export function latestJoinLogRecords(
  parsed: Readonly<Record<string, JoinLogRecord>>
): Map<number, JoinLogRecord> {
  const latest: Map<number, JoinLogRecord> = new Map();
  for (const key in parsed) {
    if (!Object.hasOwn(parsed, key)) continue;
    const record: JoinLogRecord | undefined = parsed[key];
    if (record === undefined) continue;
    const current: JoinLogRecord | undefined = latest.get(record.userId);
    if (current === undefined || record.joinedAt > current.joinedAt) {
      latest.set(record.userId, record);
    }
  }
  return latest;
}

/**
 * 将待写条目按用户折叠，仅保留比已落盘记录更新的最后一条。
 * @param entries 同一群日的待写缓冲条目列表。
 * @param persisted 当前已落盘的 `userId -> 最新 JoinLogRecord` 映射。
 * @returns 去重且严格新于已落盘记录的待追加条目列表。
 */
export function newestBufferedJoinLogRecords(
  entries: readonly BufferedJoinLogEntry[],
  persisted: ReadonlyMap<number, JoinLogRecord>
): BufferedJoinLogEntry[] {
  const newestByUser: Map<number, BufferedJoinLogEntry> = new Map();
  for (const entry of entries) {
    const candidate: BufferedJoinLogEntry | undefined =
      newestByUser.get(entry.record.userId);
    if (
      candidate === undefined ||
      entry.record.joinedAt > candidate.record.joinedAt
    ) {
      newestByUser.set(entry.record.userId, entry);
    }
  }
  const newest: BufferedJoinLogEntry[] = [];
  for (const entry of newestByUser.values()) {
    const current: JoinLogRecord | undefined =
      persisted.get(entry.record.userId);
    if (current === undefined || entry.record.joinedAt > current.joinedAt) {
      newest.push(entry);
    }
  }
  return newest;
}

/**
 * 将单条入群记录序列化为规范 JSON 属性片段。
 * @param record 待序列化的入群记录。
 * @returns 缩进对齐的 `"<joinedAt>:<userId>": { ... }` 文本片段。
 */
export function serializeJoinLogSnapshotEntry(
  record: JoinLogRecord
): string {
  return (
    `${ENTRY_INDENT}"${record.joinedAt}:${record.userId}": {\n` +
    `${FIELD_INDENT}"userId": ${record.userId},\n` +
    `${FIELD_INDENT}"joinedAt": ${record.joinedAt}\n` +
    `${ENTRY_INDENT}}`
  );
}

/**
 * 单条入群记录序列化片段中除两处 userId 与两处 joinedAt 十进制数字外的固定 ASCII 字节数；
 * 由 serializeJoinLogSnapshotEntry 对两字段均为一位数的记录求长度再减去 4 位数字得出，片段格式只在该函数定义。
 */
const JOIN_LOG_ENTRY_FIXED_BYTES: number =
  serializeJoinLogSnapshotEntry({ userId: 1, joinedAt: 1 }).length - 4;

/**
 * 计算正安全整数的十进制数字位数。
 * @param value 正安全整数。
 * @returns 十进制表示的字符长度。
 */
function positiveSafeIntegerDigits(value: number): number {
  let digits: number = 1;
  let remaining: number = value;
  while (remaining >= 10) {
    remaining = (remaining - (remaining % 10)) / 10;
    digits += 1;
  }
  return digits;
}

/**
 * 计算单条入群记录在快照中的 UTF-8 字节数（不含前置分隔符）。
 * @param record 待测量的入群记录。
 * @returns 序列化成员片段的 UTF-8 字节长度。
 */
export function joinLogSnapshotEntryBytes(record: JoinLogRecord): number {
  return (
    JOIN_LOG_ENTRY_FIXED_BYTES +
    (positiveSafeIntegerDigits(record.joinedAt) +
      positiveSafeIntegerDigits(record.userId)) *
      2
  );
}

/**
 * 计算完整入群日志快照的 UTF-8 字节数。
 * @param latestByUser 当前群日每名用户的最新入群记录映射。
 * @returns 完整格式化 JSON 文档的 UTF-8 字节总数。
 */
export function measureJoinLogSnapshotBytes(
  latestByUser: ReadonlyMap<number, JoinLogRecord>
): number {
  if (latestByUser.size === 0) return JOIN_LOG_EMPTY_SNAPSHOT_BYTES;
  let bytes: number = JOIN_LOG_SNAPSHOT_BRACE_BYTES * 2;
  let index: number = 0;
  for (const record of latestByUser.values()) {
    if (index > 0) bytes += JOIN_LOG_ENTRY_SEPARATOR_BYTES;
    bytes += joinLogSnapshotEntryBytes(record);
    index += 1;
  }
  return bytes;
}

/**
 * 按 Map 迭代顺序分块生成入群日志快照的 JSON 文本。
 * @param latestByUser 当前群日每名用户的最新入群记录映射。
 * @returns 逐块产出的 JSON 文本生成器。
 */
export function* joinLogSnapshotChunks(
  latestByUser: ReadonlyMap<number, JoinLogRecord>
): Generator<string, void, undefined> {
  if (latestByUser.size === 0) {
    yield "{}";
    return;
  }
  let chunk: string = "{\n";
  let chunkBytes: number = JOIN_LOG_SNAPSHOT_BRACE_BYTES;
  let index: number = 0;
  for (const record of latestByUser.values()) {
    const prefix: string = index === 0 ? "" : ",\n";
    const fragment: string =
      prefix + serializeJoinLogSnapshotEntry(record);
    const fragmentBytes: number =
      (index === 0 ? 0 : JOIN_LOG_ENTRY_SEPARATOR_BYTES) +
      joinLogSnapshotEntryBytes(record);
    if (
      chunkBytes > 0 &&
      chunkBytes + fragmentBytes > JOIN_LOG_SNAPSHOT_CHUNK_BYTES
    ) {
      yield chunk;
      chunk = fragment;
      chunkBytes = fragmentBytes;
    } else {
      chunk += fragment;
      chunkBytes += fragmentBytes;
    }
    index += 1;
  }
  yield `${chunk}\n}`;
}

/**
 * 比较两条用户入群记录的新旧顺序（先按 `joinedAt` 升序，相同时按 `userId` 升序）。
 * @param left 左侧入群记录。
 * @param right 右侧入群记录。
 * @returns 左侧更旧时返回负数，右侧更旧时返回正数，完全相同时返回 0。
 */
function compareRecordAge(
  left: JoinLogRecord,
  right: JoinLogRecord
): number {
  return left.joinedAt - right.joinedAt || left.userId - right.userId;
}

/**
 * 在待淘汰最旧记录的最大堆中上浮尾部元素。
 * @param heap 存放待淘汰入群记录的最大堆数组。
 */
function siftOldestSelectionUp(heap: JoinLogRecord[]): void {
  let index: number = heap.length - 1;
  while (index > 0) {
    const parent: number = Math.floor((index - 1) / 2);
    if (compareRecordAge(heap[index]!, heap[parent]!) <= 0) return;
    const value: JoinLogRecord = heap[index]!;
    heap[index] = heap[parent]!;
    heap[parent] = value;
    index = parent;
  }
}

/**
 * 在待淘汰最旧记录的最大堆中下沉堆顶元素。
 * @param heap 存放待淘汰入群记录的最大堆数组。
 */
function siftOldestSelectionDown(heap: JoinLogRecord[]): void {
  let index: number = 0;
  while (true) {
    const left: number = index * 2 + 1;
    if (left >= heap.length) return;
    const right: number = left + 1;
    let newerChild: number = left;
    if (
      right < heap.length &&
      compareRecordAge(heap[right]!, heap[left]!) > 0
    ) {
      newerChild = right;
    }
    if (compareRecordAge(heap[newerChild]!, heap[index]!) <= 0) {
      return;
    }
    const value: JoinLogRecord = heap[index]!;
    heap[index] = heap[newerChild]!;
    heap[newerChild] = value;
    index = newerChild;
  }
}

/**
 * 原地裁剪 records，仅保留 joinedAt 最新的 capacity 个用户记录，返回淘汰条数。
 * @param records 待原地裁剪的 `userId -> JoinLogRecord` 映射。
 * @param capacity 允许保留的最大用户记录数（正安全整数）。
 * @param onEvict 每淘汰一条记录前触发的可选回调。
 * @returns 本次实际移除的最旧用户记录条数。
 */
export function trimJoinLogRecordsToCapacity(
  records: Map<number, JoinLogRecord>,
  capacity: number,
  onEvict?: (record: JoinLogRecord) => void
): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError(
      "Join log record capacity must be a positive safe integer."
    );
  }
  const overflow: number = records.size - capacity;
  if (overflow <= 0) return 0;
  const oldestRecords: JoinLogRecord[] = [];
  for (const record of records.values()) {
    if (oldestRecords.length < overflow) {
      oldestRecords.push(record);
      siftOldestSelectionUp(oldestRecords);
      continue;
    }
    if (compareRecordAge(record, oldestRecords[0]!) >= 0) {
      continue;
    }
    oldestRecords[0] = record;
    siftOldestSelectionDown(oldestRecords);
  }
  for (const record of oldestRecords) {
    onEvict?.(record);
    records.delete(record.userId);
  }
  return overflow;
}
