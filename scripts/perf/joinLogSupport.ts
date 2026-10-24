/**
 * 入群日志容量线对照基准的夹具构造、样本聚合与命令行参数解析辅助。
 */

import { median } from "./statistics";
import { FLUSH_MAX_ENTRIES } from "../../packages/consts/diskIO/appendOnly";
import {
  JOIN_LOG_MAX_BUFFERED_ENTRIES,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
} from "../../packages/consts/diskIO/joinLog";
import type { JoinLogRecord } from "../../packages/types/diskIO/storage";

/** 基准测试算子类型。 */
export type Operation = "snapshot" | "capacity" | "append-accounting";
/** 基准测试变体类型。 */
export type Variant = "baseline" | "current";

/** 容量裁剪算子夹具。 */
export interface CapacityFixture {
  /** 裁剪保留的目标容量上限。 */
  readonly capacity: number;
  /** 初始满载入群记录表。 */
  readonly records: Map<number, JoinLogRecord>;
  /** 溢出的新增记录批次。 */
  readonly incoming: readonly JoinLogRecord[];
}

/** 一次 flush 的记录批次，按批重复以达到与其它算子同量级的输入规模。 */
export interface AppendFixture {
  /** 单批待刷记录数组。 */
  readonly batch: readonly JoinLogRecord[];
  /** 重复执行的批次数。 */
  readonly batchCount: number;
}

/** 子进程单次采样结果。 */
export interface ChildResult {
  readonly operation: Operation;
  readonly variant: Variant;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly recordCount: number;
  readonly overflow: number;
  readonly warmupRecordCount: number;
  readonly elapsedMs: number;
  readonly heapDeltaBeforeGc: number;
  readonly extraMemoryDeltaBeforeGc: number;
  readonly objectDeltaBeforeGc: number;
  readonly retainedHeapDelta: number;
  readonly retainedExtraMemoryDelta: number;
  readonly retainedObjectDelta: number;
  readonly checksum: number;
}

/** 算子与变体聚合统计结果。 */
export interface AggregateResult {
  readonly operation: Operation;
  readonly variant: Variant;
  readonly samples: number;
  readonly medianElapsedMs: number;
  readonly minElapsedMs: number;
  readonly maxElapsedMs: number;
  readonly medianHeapDeltaBeforeGc: number;
  readonly medianExtraMemoryDeltaBeforeGc: number;
  readonly medianObjectDeltaBeforeGc: number;
  readonly medianRetainedHeapDelta: number;
  readonly medianRetainedExtraMemoryDelta: number;
  readonly medianRetainedObjectDelta: number;
}

/** 入群日志容量线对照基准报告。 */
export interface BenchmarkReport {
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly recordCount: number;
  readonly overflow: number;
  readonly warmupRecordCount: number;
  readonly independentProcessSamples: number;
  readonly results: readonly AggregateResult[];
}

/** 生产容量线；夹具规模取生产常量，输入固定。 */
export const RECORD_COUNT: number = JOIN_LOG_MAX_USERS_PER_CHAT_DAY;
/** 单次正常 flush 最多引入的高基数溢出量。 */
export const OVERFLOW: number = FLUSH_MAX_ENTRIES;
/** 子进程正式采样前的小规模预热输入。 */
export const WARMUP_RECORD_COUNT: number = 10_000;
/** snapshot 与 append-accounting 子进程正式采样前的预热轮数。 */
export const WARMUP_ROUNDS: number = 3;
/** capacity 子进程正式采样前的预热轮数。 */
export const CAPACITY_WARMUP_ROUNDS: number = 12;
/** 每个变体使用的独立进程样本数。 */
export const PROCESS_SAMPLE_COUNT: number = 5;
/** 单批规模取生产的待刷上限，对应一次 flush 能携带的最大事实数。 */
const APPEND_BATCH_SIZE: number = JOIN_LOG_MAX_BUFFERED_ENTRIES;
/** 批次数使总输入与 snapshot/capacity 同量级。 */
const APPEND_BATCH_COUNT: number =
  Math.floor(RECORD_COUNT / APPEND_BATCH_SIZE);

/**
 * 构造含指定用户数的入群记录表。
 * @param count 目标用户记录条数。
 * @returns 按用户 ID 索引的入群记录 Map。
 */
export function createRecords(count: number): Map<number, JoinLogRecord> {
  const records: Map<number, JoinLogRecord> = new Map();
  for (let userId: number = 1; userId <= count; userId += 1) {
    records.set(userId, {
      userId,
      joinedAt: 1_800_000_000_000 + userId,
    });
  }
  return records;
}

/**
 * 构造追加记账算子使用的固定批次夹具。
 * @returns 单批记录数组与重复批次数。
 */
export function createAppendFixture(): AppendFixture {
  const batch: JoinLogRecord[] = new Array<JoinLogRecord>(APPEND_BATCH_SIZE);
  for (let index: number = 0; index < APPEND_BATCH_SIZE; index += 1) {
    const userId: number = index + 1;
    batch[index] = { userId, joinedAt: 1_800_000_000_000 + userId };
  }
  return { batch, batchCount: APPEND_BATCH_COUNT };
}

/**
 * 构造容量裁剪算子使用的满载记录表与溢出新记录批次。
 * @param capacity 裁剪保留的目标容量上限。
 * @param overflow 超出容量的追加记录条数。
 * @returns 容量裁剪夹具。
 */
export function createCapacityFixture(
  capacity: number,
  overflow: number
): CapacityFixture {
  const records: Map<number, JoinLogRecord> = createRecords(capacity);
  const incoming: JoinLogRecord[] = new Array<JoinLogRecord>(overflow);
  for (let index: number = 0; index < overflow; index += 1) {
    const userId: number = capacity + index + 1;
    incoming[index] = {
      userId,
      joinedAt: 1_800_000_000_000 + userId,
    };
  }
  return { capacity, records, incoming };
}

/**
 * 计算容量裁剪后的记录表特征校验和，用于核对参照实现与当前实现结果一致。
 * @param records 裁剪后的入群记录表。
 * @param capacity 目标容量上限。
 * @returns 编码了表大小与边界键存在性的整数校验和。
 */
export function capacityChecksum(
  records: ReadonlyMap<number, JoinLogRecord>,
  capacity: number
): number {
  return records.size +
    (records.has(1) ? 1 : 0) +
    (records.has(OVERFLOW) ? 2 : 0) +
    (records.has(OVERFLOW + 1) ? 4 : 0) +
    (records.has(capacity + OVERFLOW) ? 8 : 0);
}

/**
 * 将同一算子与变体的多次独立子进程样本聚合为中位数与极值摘要。
 * @param results 同一算子与变体的子进程样本列表。
 * @returns 聚合后的耗时与堆增量统计结果。
 */
export function aggregate(results: readonly ChildResult[]): AggregateResult {
  const first: ChildResult = results[0]!;
  const elapsed: number[] = results.map(
    (result: ChildResult): number => result.elapsedMs
  );
  return {
    operation: first.operation,
    variant: first.variant,
    samples: results.length,
    medianElapsedMs: median(elapsed),
    minElapsedMs: Math.min(...elapsed),
    maxElapsedMs: Math.max(...elapsed),
    medianHeapDeltaBeforeGc: median(results.map(
      (result: ChildResult): number => result.heapDeltaBeforeGc
    )),
    medianExtraMemoryDeltaBeforeGc: median(results.map(
      (result: ChildResult): number => result.extraMemoryDeltaBeforeGc
    )),
    medianObjectDeltaBeforeGc: median(results.map(
      (result: ChildResult): number => result.objectDeltaBeforeGc
    )),
    medianRetainedHeapDelta: median(results.map(
      (result: ChildResult): number => result.retainedHeapDelta
    )),
    medianRetainedExtraMemoryDelta: median(results.map(
      (result: ChildResult): number => result.retainedExtraMemoryDelta
    )),
    medianRetainedObjectDelta: median(results.map(
      (result: ChildResult): number => result.retainedObjectDelta
    )),
  };
}

/**
 * 解析并校验子进程算子参数。
 * @param value 命令行传入的算子名称字符串。
 * @returns 合法的算子标识。
 */
export function parseOperation(value: string | undefined): Operation {
  if (
    value === "snapshot" ||
    value === "capacity" ||
    value === "append-accounting"
  ) {
    return value;
  }
  throw new Error(
    "Child operation must be snapshot, capacity or append-accounting."
  );
}

/**
 * 解析并校验子进程变体参数。
 * @param value 命令行传入的变体名称字符串。
 * @returns 合法的变体标识。
 */
export function parseVariant(value: string | undefined): Variant {
  if (value === "baseline" || value === "current") return value;
  throw new Error("Child variant must be baseline or current.");
}
