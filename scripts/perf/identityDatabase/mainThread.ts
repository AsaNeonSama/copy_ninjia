import { basename, dirname, resolve } from "node:path";
import {
  identityPolicyCache,
  resetIdentityStorageCache,
  unacknowledgedWhitelistWrites,
} from "../../../packages/cache/main/identityStorage";
import {
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
import { RUNTIME_DATA_ROOT } from "../../../packages/consts/paths";
import {
  flushDiskIODomain,
  initDiskIO,
  loadPersistedData,
  terminateDiskIO,
} from "../../../packages/infra/diskIO";
import {
  cachedBlocklistEntry,
  cachedWhitelistEntry,
  hydrateIdentityStorageCounts,
  queueIdentityPolicyWrite,
} from "../../../packages/infra/identityStorage";
import { ensureStickerConfig } from "../../../packages/config/stickers";
import { adoptTimeZone } from "../../../packages/config/time";
import { DEFAULT_BOT_TIME_ZONE } from "../../../packages/consts/bot";
import type { LoadedData } from "../../../packages/types/diskIO/replies";
import type { WhitelistEntryData } from
  "../../../packages/types/identityPolicy";
import type { FlushResult } from "../../../packages/types/lifecycle";
import {
  MAIN_BENCHMARK_ROOT_PREFIX,
  MAIN_LRU_READ_BATCH_COUNT,
  MAIN_WRITE_THROUGH_OPERATION_COUNT,
  MAIN_WRITE_THROUGH_WORKING_SET,
  READ_BATCH_SIZE,
  READ_FIXTURE_SIZE,
} from "./constants";
import { BLACK_ENTRY, WHITE_ENTRY } from "./fixtures";
import { measuredResult, measuredResultAsync } from "./measurement";
import { assertMockRoot } from "./roots";
import type { ChildResult } from "./types";

/** 用奇偶交替的白名单与黑名单条目预填充主线程身份策略 LRU 缓存。 */
function seedMainLru(): void {
  resetIdentityStorageCache();
  for (let id: number = 1; id <= READ_FIXTURE_SIZE; id += 1) {
    const blocked: boolean = (id & 1) === 0;
    identityPolicyCache.set(id, {
      whitelist: blocked ? null : WHITE_ENTRY,
      blocklist: blocked ? BLACK_ENTRY : null,
      temporaryAdBypass: undefined,
    });
  }
}

/**
 * 循环按批次读取主线程身份策略 LRU 缓存并累计命中数。
 * @param batches 连续执行的读取批次数。
 * @returns 累计命中的条目计数校验和。
 */
function runMainLruReadBatches(batches: number): number {
  let checksum: number = 0;
  let id: number = 1;
  for (let batch: number = 0; batch < batches; batch += 1) {
    for (let offset: number = 0; offset < READ_BATCH_SIZE; offset += 1) {
      if (cachedWhitelistEntry(id) !== undefined) checksum += 1;
      if (cachedBlocklistEntry(id) !== undefined) checksum += 1;
      id += 1;
      if (id > READ_FIXTURE_SIZE) id = 1;
    }
  }
  return checksum;
}

/** 为写透工作集预填充主线程身份策略空条目缓存。 */
function seedMainWriteThroughCache(): void {
  for (let id: number = 1; id <= MAIN_WRITE_THROUGH_WORKING_SET; id += 1) {
    identityPolicyCache.set(id, { whitelist: null, blocklist: null, temporaryAdBypass: undefined });
  }
}

/**
 * 在写透工作集上循环提交白名单变更并在跨工作集边界时等待刷盘确认。
 * @param operations 待提交的写操作总数。
 * @param startingOperation 起始操作序号，用于计算目标 ID 与写入周期。
 * @returns 成功入队的写操作次数校验和。
 */
async function runMainWriteThroughOperations(
  operations: number,
  startingOperation: number
): Promise<number> {
  let checksum: number = 0;
  for (let offset: number = 0; offset < operations; offset += 1) {
    if (offset > 0 && offset % MAIN_WRITE_THROUGH_WORKING_SET === 0) {
      await flushMainWriteThrough("Working set");
    }
    const operation: number = startingOperation + offset;
    const id: number = operation % MAIN_WRITE_THROUGH_WORKING_SET + 1;
    const cycle: number = Math.floor(operation / MAIN_WRITE_THROUGH_WORKING_SET);
    const value: Readonly<WhitelistEntryData> | null = (cycle & 1) === 0
      ? WHITE_ENTRY
      : null;
    if (!queueIdentityPolicyWrite("whitelist", id, value)) {
      throw new Error(`Main-thread write-through rejected operation ${operation}.`);
    }
    checksum += 1;
  }
  return checksum;
}

/**
 * 运行主线程身份策略 LRU 缓存热读子进程样本。
 * @returns 主线程 LRU 读取算子的单次测量结果。
 */
export function runMainLruReadChild(): ChildResult {
  try {
    seedMainLru();
    runMainLruReadBatches(50_000);
    const operations: number = MAIN_LRU_READ_BATCH_COUNT * READ_BATCH_SIZE;
    const result: ChildResult = measuredResult({
      operation: "main-lru-read",
      operations,
      batches: MAIN_LRU_READ_BATCH_COUNT,
      run: (): number => runMainLruReadBatches(MAIN_LRU_READ_BATCH_COUNT),
    });
    if (result.checksum !== operations) {
      throw new Error(`Main-thread LRU benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    resetIdentityStorageCache();
  }
}

/**
 * 刷空主线程白名单写透领域并断言所有未确认写入均已收到回执。
 * @param context 错误信息中标识当前阶段的上下文标签。
 */
async function flushMainWriteThrough(context: string): Promise<void> {
  const result: FlushResult = (await flushDiskIODomain("whitelist", 120_000)).result;
  if (result !== "flushed") {
    throw new Error(`${context} write-through flush ended as ${result}.`);
  }
  if (unacknowledgedWhitelistWrites.size !== 0) {
    throw new Error(
      `${context} left ${unacknowledgedWhitelistWrites.size} unacknowledged write(s).`
    );
  }
}

/**
 * 运行主线程身份策略写透并等待 Worker 落盘确认的子进程样本。
 * @param mockRoot 父进程创建的隔离 mock 根目录路径。
 * @returns 主线程写透算子的单次测量结果。
 */
export async function runMainWriteThroughChild(
  mockRoot: string
): Promise<ChildResult> {
  assertMockRoot(mockRoot);
  if (
    dirname(RUNTIME_DATA_ROOT) !== resolve(mockRoot) ||
    !basename(RUNTIME_DATA_ROOT).startsWith(MAIN_BENCHMARK_ROOT_PREFIX)
  ) {
    throw new Error(
      "Main-thread write-through benchmark requires its isolated temporary root."
    );
  }
  // 本基准显式采用 config_example 的贴纸清单执行目录对账；其他可选功能
  // 不参与身份写透，配置预热只读取贴纸文件。时区接管与 createMainBenchmarkRoot
  // 建库标记相同的默认时区。
  await ensureStickerConfig();
  adoptTimeZone(DEFAULT_BOT_TIME_ZONE);
  initDiskIO();
  try {
    const loaded: LoadedData = await loadPersistedData(120_000);
    hydrateIdentityStorageCounts(
      loaded.permissionEntryCount,
      loaded.blocklistEntryCount
    );
    seedMainWriteThroughCache();
    const warmupOperations: number = MAIN_WRITE_THROUGH_WORKING_SET * 2;
    const warmupChecksum: number = await runMainWriteThroughOperations(
      warmupOperations,
      0
    );
    if (warmupChecksum !== warmupOperations) {
      throw new Error(
        `Main-thread write-through warmup checksum mismatch: ${warmupChecksum}.`
      );
    }
    await flushMainWriteThrough("Warmup");

    const result: ChildResult = await measuredResultAsync({
      operation: "main-write-through-acked",
      operations: MAIN_WRITE_THROUGH_OPERATION_COUNT,
      batches: MAIN_WRITE_THROUGH_OPERATION_COUNT /
        IDENTITY_WRITE_BATCH_MAX_ENTRIES,
      run: async (): Promise<number> => {
        const checksum: number = await runMainWriteThroughOperations(
          MAIN_WRITE_THROUGH_OPERATION_COUNT,
          warmupOperations
        );
        await flushMainWriteThrough("Measured");
        return checksum;
      },
    });
    if (result.checksum !== MAIN_WRITE_THROUGH_OPERATION_COUNT) {
      throw new Error(
        `Main-thread write-through checksum mismatch: ${result.checksum}.`
      );
    }
    return result;
  } finally {
    await terminateDiskIO();
    resetIdentityStorageCache();
  }
}
