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

function isJoinLogRecord(value: unknown): value is JoinLogRecord {
  return isPlainRecord(value) &&
    hasExactKeys(value, ["userId", "joinedAt"]) &&
    Number.isSafeInteger(value.userId) &&
    (value.userId as number) > 0 &&
    Number.isSafeInteger(value.joinedAt) &&
    (value.joinedAt as number) > 0;
}

/** 严格校验入群日志文件的领域 schema。 */
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

/** 由规范日期键生成包含当日在内的前 count 个公历日期集合。 */
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

/** 判断规范日期键是否落在 anchor 及其之前的 count 个公历日期内。 */
export function isRecentJoinLogDay(
  candidate: string,
  anchor: string,
  count: number
): boolean {
  if (candidate === anchor) return count >= 1;
  if (candidate > anchor || count <= 1) return false;
  return candidate >= shiftDateKey(anchor, 1 - count);
}

/** 将文件中的历史条目折叠为每用户最后一次入群记录。 */
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

/** 将待写条目按用户折叠，仅保留比已落盘记录更新的最后一条。 */
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

/** 将单条入群记录序列化为规范 JSON 属性片段。 */
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

/** 计算单条入群记录在快照中的 UTF-8 字节数（不含前置分隔符）。 */
export function joinLogSnapshotEntryBytes(record: JoinLogRecord): number {
  return Buffer.byteLength(serializeJoinLogSnapshotEntry(record));
}

/** 计算完整入群日志快照的 UTF-8 字节数。 */
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

/** 按 Map 迭代顺序分块生成入群日志快照的 JSON 文本。 */
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
    const fragmentBytes: number = Buffer.byteLength(fragment);
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

function compareRecordAge(
  records: ReadonlyMap<number, JoinLogRecord>,
  leftUserId: number,
  rightUserId: number
): number {
  const left: JoinLogRecord = records.get(leftUserId)!;
  const right: JoinLogRecord = records.get(rightUserId)!;
  return left.joinedAt - right.joinedAt || leftUserId - rightUserId;
}

/** 在待淘汰最旧记录的最大堆中上浮尾部元素。 */
function siftOldestSelectionUp(
  heap: number[],
  records: ReadonlyMap<number, JoinLogRecord>
): void {
  let index: number = heap.length - 1;
  while (index > 0) {
    const parent: number = Math.floor((index - 1) / 2);
    if (compareRecordAge(records, heap[index]!, heap[parent]!) <= 0) return;
    const value: number = heap[index]!;
    heap[index] = heap[parent]!;
    heap[parent] = value;
    index = parent;
  }
}

/** 在待淘汰最旧记录的最大堆中下沉堆顶元素。 */
function siftOldestSelectionDown(
  heap: number[],
  records: ReadonlyMap<number, JoinLogRecord>
): void {
  let index: number = 0;
  while (true) {
    const left: number = index * 2 + 1;
    if (left >= heap.length) return;
    const right: number = left + 1;
    let newerChild: number = left;
    if (
      right < heap.length &&
      compareRecordAge(records, heap[right]!, heap[left]!) > 0
    ) {
      newerChild = right;
    }
    if (
      compareRecordAge(records, heap[newerChild]!, heap[index]!) <= 0
    ) {
      return;
    }
    const value: number = heap[index]!;
    heap[index] = heap[newerChild]!;
    heap[newerChild] = value;
    index = newerChild;
  }
}

/** 原地裁剪 records，仅保留 joinedAt 最新的 capacity 个用户记录，返回淘汰条数。 */
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
  const oldestUserIds: number[] = [];
  for (const userId of records.keys()) {
    if (oldestUserIds.length < overflow) {
      oldestUserIds.push(userId);
      siftOldestSelectionUp(oldestUserIds, records);
      continue;
    }
    if (compareRecordAge(records, userId, oldestUserIds[0]!) >= 0) {
      continue;
    }
    oldestUserIds[0] = userId;
    siftOldestSelectionDown(oldestUserIds, records);
  }
  for (const userId of oldestUserIds) {
    const record: JoinLogRecord = records.get(userId)!;
    onEvict?.(record);
    records.delete(userId);
  }
  return overflow;
}
