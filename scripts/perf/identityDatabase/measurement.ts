import { snapshotHeap } from "../heapSnapshot";
import { mean, standardDeviation } from "../statistics";
import type { HeapSnapshot } from "../heapSnapshot";
import type {
  AggregateResult,
  BenchmarkOperation,
  ChildResult,
} from "./types";

/** 同步测量包装器的入参。 */
interface MeasuredResultOptions {
  /** 被测算子名称。 */
  readonly operation: BenchmarkOperation;
  /** 本样本包含的逻辑操作总数。 */
  readonly operations: number;
  /** 本样本包含的批次或事务总数。 */
  readonly batches: number;
  /** 同步执行被测工作并返回校验和的回调。 */
  readonly run: () => number;
}

/** 异步测量包装器的入参。 */
interface AsyncMeasuredResultOptions {
  /** 被测算子名称。 */
  readonly operation: BenchmarkOperation;
  /** 本样本包含的逻辑操作总数。 */
  readonly operations: number;
  /** 本样本包含的批次或事务总数。 */
  readonly batches: number;
  /** 异步执行被测工作并返回校验和的回调。 */
  readonly run: () => Promise<number>;
}

/**
 * 触发一次同步完整 GC 并返回其耗时（毫秒）。
 * @returns 本次强制 GC 的耗时（毫秒）。
 */
function forceGc(): number {
  const startedAt: number = performance.now();
  Bun.gc(true);
  return performance.now() - startedAt;
}

/**
 * 在前后强制 GC 与堆快照边界内测量同步算子回调的吞吐、延迟与留存堆增量。
 * @param options 算子标识、操作规模与同步执行回调。
 * @returns 单次同步样本的完整测量结果。
 */
export function measuredResult({
  operation,
  operations,
  batches,
  run,
}: MeasuredResultOptions): ChildResult {
  const gcBeforeMs: number = forceGc();
  const before: HeapSnapshot = snapshotHeap();
  const startedAt: number = performance.now();
  const checksum: number = run();
  const elapsedMs: number = performance.now() - startedAt;
  const gcAfterMs: number = forceGc();
  const retained: HeapSnapshot = snapshotHeap();
  return {
    operation,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    operations,
    batches,
    elapsedMs,
    throughputPerSecond: operations * 1_000 / elapsedMs,
    meanBatchLatencyMs: elapsedMs / batches,
    retainedHeapDelta: retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta:
      retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained.objectCount - before.objectCount,
    gcBeforeMs,
    gcAfterMs,
    checksum,
  };
}

/**
 * 在前后强制 GC 与堆快照边界内测量异步算子回调的吞吐、延迟与留存堆增量。
 * @param options 算子标识、操作规模与异步执行回调。
 * @returns 单次异步样本的完整测量结果。
 */
export async function measuredResultAsync({
  operation,
  operations,
  batches,
  run,
}: AsyncMeasuredResultOptions): Promise<ChildResult> {
  const gcBeforeMs: number = forceGc();
  const before: HeapSnapshot = snapshotHeap();
  const startedAt: number = performance.now();
  const checksum: number = await run();
  const elapsedMs: number = performance.now() - startedAt;
  const gcAfterMs: number = forceGc();
  const retained: HeapSnapshot = snapshotHeap();
  return {
    operation,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    operations,
    batches,
    elapsedMs,
    throughputPerSecond: operations * 1_000 / elapsedMs,
    meanBatchLatencyMs: elapsedMs / batches,
    retainedHeapDelta: retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta:
      retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained.objectCount - before.objectCount,
    gcBeforeMs,
    gcAfterMs,
    checksum,
  };
}

/**
 * 将同一算子的多次样本汇总为平均吞吐、极值、变异系数与平均堆增量。
 * @param results 同一算子的非空样本列表。
 * @returns 算子跨样本聚合统计结果。
 */
export function aggregate(results: readonly ChildResult[]): AggregateResult {
  const first: ChildResult = results[0]!;
  const throughputs: number[] = results.map(
    (result: ChildResult): number => result.throughputPerSecond
  );
  const averageThroughput: number = mean(throughputs);
  return {
    operation: first.operation,
    samples: results.length,
    operationsPerSample: first.operations,
    batchesPerSample: first.batches,
    averageThroughputPerSecond: averageThroughput,
    minThroughputPerSecond: Math.min(...throughputs),
    maxThroughputPerSecond: Math.max(...throughputs),
    coefficientOfVariationPercent:
      standardDeviation(throughputs, averageThroughput) * 100 / averageThroughput,
    averageBatchLatencyMs: mean(results.map(
      (result: ChildResult): number => result.meanBatchLatencyMs
    )),
    averageRetainedHeapDelta: mean(results.map(
      (result: ChildResult): number => result.retainedHeapDelta
    )),
    averageRetainedExtraMemoryDelta: mean(results.map(
      (result: ChildResult): number => result.retainedExtraMemoryDelta
    )),
    averageRetainedObjectDelta: mean(results.map(
      (result: ChildResult): number => result.retainedObjectDelta
    )),
    averageGcBeforeMs: mean(results.map(
      (result: ChildResult): number => result.gcBeforeMs
    )),
    averageGcAfterMs: mean(results.map(
      (result: ChildResult): number => result.gcAfterMs
    )),
    checksum: results.reduce(
      (sum: number, result: ChildResult): number => sum + result.checksum,
      0
    ),
  };
}
