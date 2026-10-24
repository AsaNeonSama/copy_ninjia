/**
 * 入群日志容量线的独立进程对照基准。
 *
 * 父进程交替启动 baseline/current 子进程，确保每个样本有独立 JSC 堆与预热；
 * baseline 是固定参照算法：整表复制加排序加整串 JSON（snapshot/capacity），
 * 或按记录调用字节数计算函数（append-accounting）。
 */

import { snapshotHeap } from "./heapSnapshot";
import { cartesianProduct } from "../../packages/libs/cartesianProduct";
import { DAY_FILE_JSON_INDENT } from "../../packages/consts/diskIO/appendOnly";
import { JOIN_LOG_ENTRY_SEPARATOR_BYTES } from "../../packages/consts/diskIO/joinLog";
import {
  joinLogSnapshotChunks,
  joinLogSnapshotEntryBytes,
  serializeJoinLogSnapshotEntry,
  trimJoinLogRecordsToCapacity,
} from "../../packages/workers/diskIO/joinLogRecords";
import { perfChildEnvironment } from "./childEnvironment";
import {
  aggregate,
  CAPACITY_WARMUP_ROUNDS,
  capacityChecksum,
  createAppendFixture,
  createCapacityFixture,
  createRecords,
  OVERFLOW,
  parseOperation,
  parseVariant,
  PROCESS_SAMPLE_COUNT,
  RECORD_COUNT,
  WARMUP_RECORD_COUNT,
  WARMUP_ROUNDS,
} from "./joinLogSupport";
import type {
  AggregateResult,
  AppendFixture,
  BenchmarkReport,
  CapacityFixture,
  ChildResult,
  Operation,
  Variant,
} from "./joinLogSupport";
import type { HeapSnapshot } from "./heapSnapshot";
import type { JoinLogRecord } from "../../packages/types/diskIO/storage";

/**
 * 固定参照快照：values 数组 + 排序 + 投影对象 + 完整 JSON 字符串。
 * @param records 待序列化的入群记录表。
 * @returns 完整快照 JSON 的 UTF-8 字节数。
 */
function baselineSnapshot(records: ReadonlyMap<number, JoinLogRecord>): number {
  const ordered: JoinLogRecord[] = [...records.values()];
  ordered.sort((
    left: JoinLogRecord,
    right: JoinLogRecord
  ): number => left.joinedAt - right.joinedAt || left.userId - right.userId);
  const snapshot: Record<string, JoinLogRecord> = {};
  for (const record of ordered) {
    snapshot[`${record.joinedAt}:${record.userId}`] = record;
  }
  return Buffer.byteLength(
    JSON.stringify(snapshot, null, DAY_FILE_JSON_INDENT)
  );
}

/**
 * 当前快照：直接按生产分块迭代器流式消费；准确字节数由文件缓存增量维护。
 * @param records 待序列化的入群记录表。
 * @returns 流式分块输出累计的 UTF-8 字节数。
 */
function currentSnapshot(records: ReadonlyMap<number, JoinLogRecord>): number {
  let streamedBytes: number = 0;
  for (const chunk of joinLogSnapshotChunks(records)) {
    streamedBytes += Buffer.byteLength(chunk);
  }
  return streamedBytes;
}

/**
 * 固定参照容量路径：复制整张 Map，再展开和排序全部 entry。
 * @param fixture 容量裁剪夹具。
 * @returns 裁剪后记录表的校验和。
 */
function baselineCapacity(fixture: CapacityFixture): number {
  const next: Map<number, JoinLogRecord> = new Map(fixture.records);
  for (const record of fixture.incoming) next.set(record.userId, record);
  const overflow: number = next.size - fixture.capacity;
  const ordered: [number, JoinLogRecord][] = [...next.entries()];
  ordered.sort((
    left: [number, JoinLogRecord],
    right: [number, JoinLogRecord]
  ): number =>
    left[1].joinedAt - right[1].joinedAt || left[0] - right[0]
  );
  for (let index: number = 0; index < overflow; index += 1) {
    next.delete(ordered[index]![0]);
  }
  return capacityChecksum(next, fixture.capacity);
}

/**
 * 当前容量路径：直接更新可重建索引，只分配 overflow 条待淘汰记录引用。
 * @param fixture 容量裁剪夹具。
 * @returns 裁剪后记录表的校验和。
 */
function currentCapacity(fixture: CapacityFixture): number {
  for (const record of fixture.incoming) {
    fixture.records.set(record.userId, record);
  }
  trimJoinLogRecordsToCapacity(fixture.records, fixture.capacity);
  return capacityChecksum(fixture.records, fixture.capacity);
}

/**
 * 固定参照记账：追加落盘后按记录重新序列化并测量 UTF-8 字节数。
 * @param fixture 追加记账夹具。
 * @returns 累计计算的字节数校验和。
 */
function baselineAppendAccounting(fixture: AppendFixture): number {
  let bytes: number = 0;
  for (let batch: number = 0; batch < fixture.batchCount; batch += 1) {
    const texts: string[] = new Array<string>(fixture.batch.length);
    for (let index: number = 0; index < fixture.batch.length; index += 1) {
      texts[index] = serializeJoinLogSnapshotEntry(fixture.batch[index]!);
    }
    bytes += Buffer.byteLength(texts.join(",\n"));
    for (const record of fixture.batch) {
      bytes +=
        JOIN_LOG_ENTRY_SEPARATOR_BYTES +
        Buffer.byteLength(serializeJoinLogSnapshotEntry(record));
    }
  }
  return bytes;
}

/**
 * 当前记账：整批只序列化一次，单条增量字节数直接由整数十进制位数算出。
 * @param fixture 追加记账夹具。
 * @returns 累计计算的字节数校验和。
 */
function currentAppendAccounting(fixture: AppendFixture): number {
  let bytes: number = 0;
  for (let batch: number = 0; batch < fixture.batchCount; batch += 1) {
    const texts: string[] = new Array<string>(fixture.batch.length);
    for (let index: number = 0; index < fixture.batch.length; index += 1) {
      texts[index] = serializeJoinLogSnapshotEntry(fixture.batch[index]!);
    }
    bytes += Buffer.byteLength(texts.join(",\n"));
    for (const record of fixture.batch) {
      bytes +=
        JOIN_LOG_ENTRY_SEPARATOR_BYTES +
        joinLogSnapshotEntryBytes(record);
    }
  }
  return bytes;
}

/**
 * 在正式测量前对目标算子与变体执行小规模预热。
 * @param operation 待测算子类型。
 * @param variant 参照实现或当前实现变体。
 */
function warmUp(operation: Operation, variant: Variant): void {
  const rounds: number =
    operation === "capacity" ? CAPACITY_WARMUP_ROUNDS : WARMUP_ROUNDS;
  for (let iteration: number = 0; iteration < rounds; iteration += 1) {
    if (operation === "snapshot") {
      const records: Map<number, JoinLogRecord> =
        createRecords(WARMUP_RECORD_COUNT);
      if (variant === "baseline") baselineSnapshot(records);
      else currentSnapshot(records);
      continue;
    }
    if (operation === "append-accounting") {
      const warmup: AppendFixture = { batch: createAppendFixture().batch, batchCount: 3 };
      if (variant === "baseline") baselineAppendAccounting(warmup);
      else currentAppendAccounting(warmup);
      continue;
    }
    const fixture: CapacityFixture =
      createCapacityFixture(WARMUP_RECORD_COUNT, OVERFLOW);
    if (variant === "baseline") baselineCapacity(fixture);
    else currentCapacity(fixture);
  }
}

/**
 * 在子进程内完成指定算子与变体的预热、GC、计时与堆快照采集。
 * @param operation 待测算子类型。
 * @param variant 参照实现或当前实现变体。
 * @returns 子进程单次采样结果。
 */
function runChild(operation: Operation, variant: Variant): ChildResult {
  warmUp(operation, variant);
  let input: Map<number, JoinLogRecord> | CapacityFixture | AppendFixture;
  if (operation === "snapshot") input = createRecords(RECORD_COUNT);
  else if (operation === "append-accounting") input = createAppendFixture();
  else input = createCapacityFixture(RECORD_COUNT, OVERFLOW);
  Bun.gc(true);
  const before: HeapSnapshot = snapshotHeap();
  const startedAt: number = performance.now();
  let checksum: number;
  if (operation === "snapshot") {
    checksum = variant === "baseline"
      ? baselineSnapshot(input as Map<number, JoinLogRecord>)
      : currentSnapshot(input as Map<number, JoinLogRecord>);
  } else if (operation === "append-accounting") {
    checksum = variant === "baseline"
      ? baselineAppendAccounting(input as AppendFixture)
      : currentAppendAccounting(input as AppendFixture);
  } else {
    checksum = variant === "baseline"
      ? baselineCapacity(input as CapacityFixture)
      : currentCapacity(input as CapacityFixture);
  }
  const elapsedMs: number = performance.now() - startedAt;
  const beforeGc: HeapSnapshot = snapshotHeap();
  Bun.gc(true);
  const retained: HeapSnapshot = snapshotHeap();
  return {
    operation,
    variant,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    recordCount: RECORD_COUNT,
    overflow: OVERFLOW,
    warmupRecordCount: WARMUP_RECORD_COUNT,
    elapsedMs,
    heapDeltaBeforeGc: beforeGc.heapSize - before.heapSize,
    extraMemoryDeltaBeforeGc:
      beforeGc.extraMemorySize - before.extraMemorySize,
    objectDeltaBeforeGc: beforeGc.objectCount - before.objectCount,
    retainedHeapDelta: retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta:
      retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained.objectCount - before.objectCount,
    checksum,
  };
}

/**
 * 启动独立子进程执行一次指定算子与变体的测量。
 * @param operation 待测算子类型。
 * @param variant 参照实现或当前实现变体。
 * @returns 子进程输出的单次测量结果。
 */
function runIndependentChild(
  operation: Operation,
  variant: Variant
): ChildResult {
  const decoder: TextDecoder = new TextDecoder();
  const result: Bun.ReadableSyncSubprocess = Bun.spawnSync([
    Bun.argv[0]!,
    import.meta.path,
    "--child",
    operation,
    variant,
  ], { env: perfChildEnvironment() });
  if (!result.success) {
    throw new Error(
      `Join log benchmark child failed: ${decoder.decode(result.stderr)}`
    );
  }
  return JSON.parse(decoder.decode(result.stdout)) as ChildResult;
}

/**
 * 交替运行各算子与变体的独立子进程样本，核对校验和并汇总基准报告。
 * @returns 入群日志容量线对照基准报告。
 */
function runParent(): BenchmarkReport {
  const grouped: Map<string, ChildResult[]> = new Map();
  const operations: readonly Operation[] = [
    "snapshot",
    "capacity",
    "append-accounting",
  ];
  const variants: readonly Variant[] = ["baseline", "current"];
  const samples: readonly number[] = Array.from(
    { length: PROCESS_SAMPLE_COUNT },
    (_: unknown, index: number): number => index
  );
  for (const { operation, variant } of cartesianProduct({ sample: samples, operation: operations, variant: variants })) {
    const result: ChildResult =
      runIndependentChild(operation, variant);
    if (
      result.bunVersion !== Bun.version ||
      result.bunRevision !== Bun.revision
    ) {
      throw new Error("All benchmark samples must use the same Bun build.");
    }
    const key: string = `${operation}:${variant}`;
    const values: ChildResult[] = grouped.get(key) ?? [];
    values.push(result);
    grouped.set(key, values);
  }
  for (const operation of operations) {
    const baseline: ChildResult[] = grouped.get(`${operation}:baseline`)!;
    const current: ChildResult[] = grouped.get(`${operation}:current`)!;
    for (let index: number = 0; index < baseline.length; index += 1) {
      if (baseline[index]!.checksum !== current[index]!.checksum) {
        throw new Error(`${operation} variants produced different checksums.`);
      }
    }
  }
  const results: AggregateResult[] = [];
  for (const operation of operations) {
    for (const variant of variants) {
      results.push(aggregate(grouped.get(`${operation}:${variant}`)!));
    }
  }
  return {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    recordCount: RECORD_COUNT,
    overflow: OVERFLOW,
    warmupRecordCount: WARMUP_RECORD_COUNT,
    independentProcessSamples: PROCESS_SAMPLE_COUNT,
    results,
  };
}

if (Bun.argv[2] === "--child") {
  const result: ChildResult = runChild(
    parseOperation(Bun.argv[3]),
    parseVariant(Bun.argv[4])
  );
  await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
} else {
  const report: BenchmarkReport = runParent();
  await Bun.write(Bun.stdout, `${JSON.stringify(report, null, 2)}\n`);
}
