import { storageDatabaseHandle, storageDatabaseReaders } from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { prepareStorageDatabaseReader } from "../../../database/interact/reader";
import { storageRowSource } from "../../../database/validation/storageRows";
import type { StorageDatabase, StorageDatabaseReader } from "../../../types/storageDatabase";

/**
 * 返回 Disk I/O Worker 独占连接；hydrate 前调用一律视为生命周期错误。
 * @returns 已打开的共享 SQLite 数据库连接。
 */
export function requireStorageDatabase(): StorageDatabase {
  const database: StorageDatabase | null = storageDatabaseHandle.current;
  if (database === null) {
    throw new Error(`${IDENTITY_DATABASE_PATH}: database must be loaded before use.`);
  }
  return database;
}

/**
 * 按当前独占连接读取或构建连接级预编译语句缓存；同一连接首次调用时由 prepare 构造并写入 WeakMap，之后直接复用。
 * @param cache 以数据库连接为键的连接级 WeakMap 缓存。
 * @param prepare 首次访问当前连接时的预编译语句构造方法。
 * @returns 当前数据库连接对应的预编译语句集合。
 */
export function perConnection<T>(
  cache: WeakMap<StorageDatabase, T>,
  prepare: (database: StorageDatabase) => T
): T {
  const database: StorageDatabase = requireStorageDatabase();
  const cached: T | undefined = cache.get(database);
  if (cached !== undefined) return cached;
  const prepared: T = prepare(database);
  cache.set(database, prepared);
  return prepared;
}

/**
 * 取独占连接上的整套预编译读语句；同一连接首次调用时建好挂进连接级缓存，之后复用。
 * @returns 当前连接的预编译读取语句集合。
 */
export function requireStorageDatabaseReader(): StorageDatabaseReader {
  return perConnection(storageDatabaseReaders, prepareStorageDatabaseReader);
}

/**
 * 统一生成当前部署数据库业务行的安全来源路径。
 * @param table 业务表名。
 * @param id 行主键值。
 * @returns 用于错误报告的 `<dbPath>:<table>[<id>]` 来源标识。
 */
export function storageSource(table: string, id: number | string): string {
  return storageRowSource(IDENTITY_DATABASE_PATH, table, id);
}

/**
 * 校验写消息携带的 revision 为正安全整数。
 * @param revision 待校验的版本号。
 * @param source 错误报告使用的行来源路径。
 */
export function assertPositiveRevision(revision: number, source: string): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`${source}: revision must be a positive safe integer.`);
  }
}
