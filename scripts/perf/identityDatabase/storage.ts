import { mkdtempSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { IDENTITY_WRITE_BATCH_MAX_ENTRIES } from "../../../packages/consts/identityStorage";
import { clearStorageBusinessTables, seedStorageDatabase } from "../../fixtures/storageDatabase";
import { bootstrapStorageDatabase } from
  "../../../packages/database/interact/initialization";
import { DEFAULT_BOT_TIME_ZONE } from "../../../packages/consts/bot";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { readStoredIdentityPolicies } from
  "../../../packages/database/interact/identityPolicy";
import { prepareStorageDatabaseReader } from "../../../packages/database/interact/reader";
import {
  commitStorageDatabaseChanges,
  prepareStorageDatabaseWriter,
} from "../../../packages/database/interact/transaction";
import type {
  StorageDatabase,
  StorageDatabaseChange,
  StorageDatabaseReader,
  StorageDatabaseWriter,
  StoredIdentityPolicyRow,
} from "../../../packages/types/storageDatabase";
import {
  COLD_READ_BATCH_COUNT,
  COLD_WRITE_TRANSACTION_COUNT,
  DATABASE_FIXTURE_ROOT_PREFIX,
  READ_BATCH_COUNT,
  READ_BATCH_SIZE,
  READ_FIXTURE_SIZE,
  WRITE_TRANSACTION_COUNT,
} from "./constants";
import {
  BLACK_DATA,
  EMPTY_CHAT_QA_CHANGES,
  EMPTY_STORAGE_CHANGES,
  WHITE_DATA,
} from "./fixtures";
import { measuredResult } from "./measurement";
import { assertMockRoot, isBenchmarkMockRoot, removeMainBenchmarkRoot } from "./roots";
import type { ChildResult } from "./types";
import type { PendingTemporaryAdBypassWrite } from
  "../../../packages/types/temporaryAdBypass";

const EMPTY_TEMPORARY_AD_BYPASS_CHANGES: ReadonlyMap<
  number,
  PendingTemporaryAdBypassWrite
> = new Map();

interface DatabaseFixture {
  readonly root: string;
  readonly path: string;
  readonly database: StorageDatabase;
}

/**
 * 在 mock 根下创建并打开一个新的 SQLite 数据库夹具。
 * @param mockRoot 父级临时 mock 根目录路径。
 * @returns 包含夹具目录、数据库文件路径与已打开连接的夹具对象。
 */
function createFixture(mockRoot: string): DatabaseFixture {
  assertMockRoot(mockRoot);
  const root: string = mkdtempSync(join(mockRoot, DATABASE_FIXTURE_ROOT_PREFIX));
  const path: string = join(root, "storage.sqlite");
  bootstrapStorageDatabase(path, DEFAULT_BOT_TIME_ZONE);
  const database: StorageDatabase = openStorageDatabase({ path });
  return { root, path, database };
}

/**
 * 校验路径边界后删除数据库夹具目录。
 * @param fixture 待清理的数据库夹具。
 */
function removeFixture(fixture: DatabaseFixture): void {
  const resolvedRoot: string = resolve(fixture.root);
  const resolvedPath: string = resolve(fixture.path);
  const mockRoot: string = dirname(resolvedRoot);
  if (
    dirname(resolvedPath) !== resolvedRoot ||
    basename(resolvedPath) !== "storage.sqlite" ||
    !basename(resolvedRoot).startsWith(DATABASE_FIXTURE_ROOT_PREFIX) ||
    !isBenchmarkMockRoot(mockRoot)
  ) {
    throw new Error("Identity benchmark refused to remove an unexpected fixture root.");
  }
  removeMainBenchmarkRoot(fixture.root, mockRoot);
}

/**
 * 关闭数据库连接并删除夹具目录。
 * @param fixture 待关闭并清理的数据库夹具。
 */
function closeFixture(fixture: DatabaseFixture): void {
  closeStorageDatabase(fixture.database);
  removeFixture(fixture);
}

/**
 * 构造单批读取使用的连续身份 ID 列表。
 * @returns 长度为 `READ_BATCH_SIZE` 的升序 ID 数组。
 */
function readIds(): readonly number[] {
  const ids: number[] = new Array<number>(READ_BATCH_SIZE);
  for (let index: number = 0; index < READ_BATCH_SIZE; index += 1) {
    ids[index] = index + 1;
  }
  return ids;
}

/**
 * 向数据库夹具写入固定规模的白名单与黑名单初始数据。
 * @param database 已打开的存储数据库连接。
 */
function seedReadFixture(database: StorageDatabase): void {
  const whitelist: StoredIdentityPolicyRow[] = [];
  const blocklist: StoredIdentityPolicyRow[] = [];
  for (let id: number = 1; id <= READ_FIXTURE_SIZE; id += 1) {
    if ((id & 1) === 0) blocklist.push({ id, data: BLACK_DATA });
    else whitelist.push({ id, data: WHITE_DATA });
  }
  seedStorageDatabase(database, {
    whitelist,
    blocklist,
    removals: [],
  });
}

/**
 * 在同一热连接上复用读取器连续执行指定批次的身份策略查询。
 * @param database 已打开的存储数据库连接。
 * @param ids 每批查询的目标身份 ID 列表。
 * @param batches 连续执行的读取批次数。
 * @returns 累计读出的记录条数校验和。
 */
function runReadBatches(
  database: StorageDatabase,
  ids: readonly number[],
  batches: number
): number {
  let checksum: number = 0;
  const reader: StorageDatabaseReader = prepareStorageDatabaseReader(database);
  for (let batch: number = 0; batch < batches; batch += 1) {
    checksum += readStoredIdentityPolicies(reader, "whitelist", ids).length;
    checksum += readStoredIdentityPolicies(reader, "blocklist", ids).length;
  }
  return checksum;
}

/**
 * 每批使用新连接，SQLite 连接页缓存和 Bun 语句缓存从空状态开始。
 * 操作系统页缓存在 fixture 建立后不做全局清理，报告显式标注这一口径。
 * @param path SQLite 数据库文件路径。
 * @param ids 每批查询的目标身份 ID 列表。
 * @param batches 连续执行的冷连接读取批次数。
 * @returns 累计读出的记录条数校验和。
 */
function runColdReadBatches(
  path: string,
  ids: readonly number[],
  batches: number
): number {
  let checksum: number = 0;
  for (let batch: number = 0; batch < batches; batch += 1) {
    const database: StorageDatabase = openStorageDatabase({
      path,
      readonly: true,
    });
    try {
      const reader: StorageDatabaseReader = prepareStorageDatabaseReader(database);
      checksum += readStoredIdentityPolicies(reader, "whitelist", ids).length;
      checksum += readStoredIdentityPolicies(reader, "blocklist", ids).length;
    } finally {
      closeStorageDatabase(database);
    }
  }
  return checksum;
}

/**
 * 构造写入基准使用的全部白名单变更批次。
 * @returns 每个元素对应一个事务批次的变更映射列表。
 */
function createWriteBatches(): readonly ReadonlyMap<
  number,
  StorageDatabaseChange
>[] {
  const batches: ReadonlyMap<number, StorageDatabaseChange>[] = [];
  let id: number = 1;
  for (let batch: number = 0; batch < WRITE_TRANSACTION_COUNT; batch += 1) {
    const changes: Map<number, StorageDatabaseChange> = new Map();
    for (
      let offset: number = 0;
      offset < IDENTITY_WRITE_BATCH_MAX_ENTRIES;
      offset += 1
    ) {
      changes.set(id, { data: WHITE_DATA });
      id += 1;
    }
    batches.push(changes);
  }
  return batches;
}

/**
 * 在同一热连接上依次提交全部写入事务批次。
 * @param database 已打开的存储数据库连接。
 * @param batches 待提交的白名单变更批次列表。
 * @returns 累计写入的条目数校验和。
 */
function runWriteBatches(
  database: StorageDatabase,
  batches: readonly ReadonlyMap<number, StorageDatabaseChange>[]
): number {
  let checksum: number = 0;
  const writer: StorageDatabaseWriter = prepareStorageDatabaseWriter(database);
  for (const whitelist of batches) {
    commitStorageDatabaseChanges(writer, {
      whitelist,
      blocklist: EMPTY_STORAGE_CHANGES,
      temporaryAdBypass: EMPTY_TEMPORARY_AD_BYPASS_CHANGES,
      removals: EMPTY_STORAGE_CHANGES,
      chatStates: new Map(),
      chatQa: EMPTY_CHAT_QA_CHANGES,
      aiContexts: new Map(),
    });
    checksum += whitelist.size;
  }
  return checksum;
}

/**
 * 每个事务都在新连接上提交并关闭，覆盖生产重连后的首写路径。
 * @param path SQLite 数据库文件路径。
 * @param batches 待提交的白名单变更批次列表。
 * @returns 累计写入的条目数校验和。
 */
function runColdWriteBatches(
  path: string,
  batches: readonly ReadonlyMap<number, StorageDatabaseChange>[]
): number {
  let checksum: number = 0;
  for (const whitelist of batches) {
    const database: StorageDatabase = openStorageDatabase({ path });
    try {
      commitStorageDatabaseChanges(prepareStorageDatabaseWriter(database), {
        whitelist,
        blocklist: EMPTY_STORAGE_CHANGES,
        temporaryAdBypass: EMPTY_TEMPORARY_AD_BYPASS_CHANGES,
        removals: EMPTY_STORAGE_CHANGES,
        chatStates: new Map(),
        chatQa: EMPTY_CHAT_QA_CHANGES,
        aiContexts: new Map(),
      });
      checksum += whitelist.size;
    } finally {
      closeStorageDatabase(database);
    }
  }
  return checksum;
}

/**
 * 运行存储层热连接批量读取子进程样本。
 * @param mockRoot 父级临时 mock 根目录路径。
 * @returns 热连接读取算子的单次测量结果。
 */
export function runHotReadChild(mockRoot: string): ChildResult {
  const fixture: DatabaseFixture = createFixture(mockRoot);
  try {
    seedReadFixture(fixture.database);
    const ids: readonly number[] = readIds();
    runReadBatches(fixture.database, ids, 2_000);
    const operations: number = READ_BATCH_COUNT * READ_BATCH_SIZE;
    const result: ChildResult = measuredResult({
      operation: "storage-read-hot-connection",
      operations,
      batches: READ_BATCH_COUNT,
      run: (): number => runReadBatches(fixture.database, ids, READ_BATCH_COUNT),
    });
    if (result.checksum !== operations) {
      throw new Error(`Read benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    closeFixture(fixture);
  }
}

/**
 * 运行存储层冷连接批量读取子进程样本。
 * @param mockRoot 父级临时 mock 根目录路径。
 * @returns 冷连接读取算子的单次测量结果。
 */
export function runColdReadChild(mockRoot: string): ChildResult {
  const fixture: DatabaseFixture = createFixture(mockRoot);
  seedReadFixture(fixture.database);
  closeStorageDatabase(fixture.database);
  try {
    const ids: readonly number[] = readIds();
    runColdReadBatches(fixture.path, ids, 50);
    const operations: number = COLD_READ_BATCH_COUNT * READ_BATCH_SIZE;
    const result: ChildResult = measuredResult({
      operation: "storage-read-cold-connection",
      operations,
      batches: COLD_READ_BATCH_COUNT,
      run: (): number => runColdReadBatches(
        fixture.path,
        ids,
        COLD_READ_BATCH_COUNT
      ),
    });
    if (result.checksum !== operations) {
      throw new Error(`Cold read benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    removeFixture(fixture);
  }
}

/**
 * 运行存储层热连接事务写入子进程样本。
 * @param mockRoot 父级临时 mock 根目录路径。
 * @returns 热连接写入算子的单次测量结果。
 */
export function runHotWriteChild(mockRoot: string): ChildResult {
  const fixture: DatabaseFixture = createFixture(mockRoot);
  try {
    const warmup: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      createWriteBatches().slice(0, 16);
    runWriteBatches(fixture.database, warmup);
    clearStorageBusinessTables(fixture.database);
    const batches: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      createWriteBatches();
    const operations: number = WRITE_TRANSACTION_COUNT *
      IDENTITY_WRITE_BATCH_MAX_ENTRIES;
    const result: ChildResult = measuredResult({
      operation: "storage-write-hot-connection",
      operations,
      batches: WRITE_TRANSACTION_COUNT,
      run: (): number => runWriteBatches(fixture.database, batches),
    });
    if (result.checksum !== operations) {
      throw new Error(`Write benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    closeFixture(fixture);
  }
}

/**
 * 运行存储层冷连接事务写入子进程样本。
 * @param mockRoot 父级临时 mock 根目录路径。
 * @returns 冷连接写入算子的单次测量结果。
 */
export function runColdWriteChild(mockRoot: string): ChildResult {
  const fixture: DatabaseFixture = createFixture(mockRoot);
  closeStorageDatabase(fixture.database);
  try {
    const allBatches: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      createWriteBatches();
    const warmup: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      allBatches.slice(0, 4);
    runColdWriteBatches(fixture.path, warmup);
    const cleanupDatabase: StorageDatabase = openStorageDatabase({
      path: fixture.path,
    });
    try {
      clearStorageBusinessTables(cleanupDatabase);
    } finally {
      closeStorageDatabase(cleanupDatabase);
    }
    const batches: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      allBatches.slice(0, COLD_WRITE_TRANSACTION_COUNT);
    const operations: number = COLD_WRITE_TRANSACTION_COUNT *
      IDENTITY_WRITE_BATCH_MAX_ENTRIES;
    const result: ChildResult = measuredResult({
      operation: "storage-write-cold-connection",
      operations,
      batches: COLD_WRITE_TRANSACTION_COUNT,
      run: (): number => runColdWriteBatches(fixture.path, batches),
    });
    if (result.checksum !== operations) {
      throw new Error(`Cold write benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    removeFixture(fixture);
  }
}
