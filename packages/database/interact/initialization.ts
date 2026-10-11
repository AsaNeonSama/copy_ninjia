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
 * 当前格式 storage_metadata 的全部行：schema 版本与数据根绑定的时区标记。
 *
 * timeZone 必须是 config/timeZoneInput.ts 规范化后的配置时区；建库与测试夹具共用这一份
 * 行构造，启动按同一形态严格比对。
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

/** 为迁移刚创建的空库在一个事务内写入当前 schema 版本与配置时区标记。 */
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
 * 建立新的共享 SQLite 库：createStorageDatabase 建表（目标已存在时拒绝），一个事务内写入当前 schema 版本与
 * timeZone 时区标记，关闭连接后启用 WAL。安装器、发行包自检与性能夹具共用；生产启动不调用。
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
