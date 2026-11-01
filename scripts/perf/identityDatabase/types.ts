/** SQLite 与主线程身份策略缓存基准支持的操作类型。 */
export type BenchmarkOperation =
  | "storage-read-hot-connection"
  | "storage-read-cold-connection"
  | "storage-write-hot-connection"
  | "storage-write-cold-connection"
  | "main-lru-read"
  | "main-write-through-acked";

/** 单个独立基准子进程返回的单轮测量结果。 */
export interface ChildResult {
  readonly operation: BenchmarkOperation;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly operations: number;
  readonly batches: number;
  readonly elapsedMs: number;
  readonly throughputPerSecond: number;
  readonly meanBatchLatencyMs: number;
  readonly retainedHeapDelta: number;
  readonly retainedExtraMemoryDelta: number;
  readonly retainedObjectDelta: number;
  readonly gcBeforeMs: number;
  readonly gcAfterMs: number;
  readonly checksum: number;
}

/** 同一操作跨多轮独立样本聚合后的统计指标。 */
export interface AggregateResult {
  readonly operation: BenchmarkOperation;
  readonly samples: number;
  readonly operationsPerSample: number;
  readonly batchesPerSample: number;
  readonly averageThroughputPerSecond: number;
  readonly minThroughputPerSecond: number;
  readonly maxThroughputPerSecond: number;
  readonly coefficientOfVariationPercent: number;
  readonly averageBatchLatencyMs: number;
  readonly averageRetainedHeapDelta: number;
  readonly averageRetainedExtraMemoryDelta: number;
  readonly averageRetainedObjectDelta: number;
  readonly averageGcBeforeMs: number;
  readonly averageGcAfterMs: number;
  readonly checksum: number;
}

/** SQLite 与主线程身份策略缓存基准的完整报告。 */
export interface BenchmarkReport {
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly samplingMode: "independent-processes" | "single-process";
  readonly samplesPerOperation: number;
  readonly mockDataRoot: "isolated-os-temporary-directory";
  readonly sqliteColdDefinition: "new-connection-per-batch";
  readonly operatingSystemPageCache: "not-evicted-after-fixture-setup";
  readonly storageReadBatchSize: number;
  readonly storageWriteTransactionSize: number;
  readonly mainLruCapacity: number;
  readonly mainWriteThroughWorkingSet: number;
  readonly results: readonly AggregateResult[];
}
