import { storageDatabaseHandle, storageDatabaseReaders } from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { prepareStorageDatabaseReader } from "../../../database/interact/reader";
import { storageRowSource } from "../../../database/validation/storageRows";
import type { StorageDatabase, StorageDatabaseReader } from "../../../types/storageDatabase";

/** 返回 Disk I/O Worker 独占连接；hydrate 前调用一律视为生命周期错误。 */
export function requireStorageDatabase(): StorageDatabase {
  const database: StorageDatabase | null = storageDatabaseHandle.current;
  if (database === null) {
    throw new Error(`${IDENTITY_DATABASE_PATH}: database must be loaded before use.`);
  }
  return database;
}

/** 取独占连接上的整套预编译读语句；同一连接首次调用时建好挂进连接级缓存，之后复用。 */
export function requireStorageDatabaseReader(): StorageDatabaseReader {
  const database: StorageDatabase = requireStorageDatabase();
  const cached: StorageDatabaseReader | undefined = storageDatabaseReaders.get(database);
  if (cached !== undefined) return cached;
  const reader: StorageDatabaseReader = prepareStorageDatabaseReader(database);
  storageDatabaseReaders.set(database, reader);
  return reader;
}

/** 统一生成当前部署数据库业务行的安全来源路径。 */
export function storageSource(table: string, id: number | string): string {
  return storageRowSource(IDENTITY_DATABASE_PATH, table, id);
}

/** 校验写消息携带的 revision 为正安全整数。 */
export function assertPositiveRevision(revision: number, source: string): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`${source}: revision must be a positive safe integer.`);
  }
}
