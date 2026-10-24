import {
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_TIME_ZONE_KEY,
} from "../../consts/identityStorage";
import { storageMetadata } from "../schema/metadata";
import { closeStorageDatabase, enableStorageDatabaseWal, openStorageDatabase } from "./connection";
import { createStorageDatabase } from "./migration";
import type {
  StorageDatabase,
  StorageTimeZoneMetadata,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";

type StorageDatabaseTransaction = Parameters<
  Parameters<StorageDatabase["transaction"]>[0]
>[0];

/**
 * 构造 `storage_metadata` 表的初始行（当前 schema 版本与绑定时区标记）。
 * @param timeZone 绑定到该数据库的规范化 IANA 时区名称。
 * @returns 待写入 `storage_metadata` 的初始键值对行列表。
 */
export function storageMetadataRows(
  timeZone: string
): readonly StoredStorageMetadataRow[] {
  const marker: StorageTimeZoneMetadata = { timeZone };
  return [
    { key: IDENTITY_DATABASE_SCHEMA_KEY, data: IDENTITY_DATABASE_SCHEMA_DATA },
    { key: IDENTITY_DATABASE_TIME_ZONE_KEY, data: JSON.stringify(marker) },
  ];
}

/**
 * 在单个事务内向 `storage_metadata` 写入初始元数据行。
 * @param database 共享存储数据库连接。
 * @param timeZone 绑定到该数据库的规范化 IANA 时区名称。
 */
export function initializeStorageDatabase(
  database: StorageDatabase,
  timeZone: string
): void {
  const rows: readonly StoredStorageMetadataRow[] = storageMetadataRows(timeZone);
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    transaction.insert(storageMetadata).values([...rows]).run();
  });
}

/**
 * 创建新共享 SQLite 数据库、写入初始元数据并启用 WAL 模式。
 * @param path 新数据库文件的目标路径。
 * @param timeZone 绑定到该数据库的规范化 IANA 时区名称。
 */
export function bootstrapStorageDatabase(path: string, timeZone: string): void {
  createStorageDatabase(path);
  const database: StorageDatabase = openStorageDatabase({ path });
  try {
    initializeStorageDatabase(database, timeZone);
  } finally {
    closeStorageDatabase(database);
  }
  enableStorageDatabaseWal(path);
}
