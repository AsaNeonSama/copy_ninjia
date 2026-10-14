import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { storageDatabaseSchema } from "../schema/storage";
import type { StorageDatabase } from "../../types/storageDatabase";
import {
  assertDirectoryReadableWritable,
  assertFileReadableWritable,
} from "../../libs/fileAccess";

export interface OpenStorageDatabaseOptions {
  readonly path: string;
  readonly readonly?: boolean;
  readonly requireWritableAccess?: boolean;
}

/** 打开既有共享存储数据库；生产 owner 可同时要求文件和父目录具备写权限。 */
export function openStorageDatabase({
  path,
  readonly: isReadonly = false,
  requireWritableAccess = false,
}: OpenStorageDatabaseOptions): StorageDatabase {
  if (!existsSync(path)) {
    throw new Error(`${path}: database file is missing; initialize current storage first.`);
  }
  if (requireWritableAccess) {
    assertFileReadableWritable(path);
    assertDirectoryReadableWritable(dirname(path));
  }
  const client: Database = new Database(path, {
    create: false,
    ...(isReadonly ? { readonly: true } : { readwrite: true }),
    strict: true,
    safeIntegers: false,
  });
  return drizzle({ client, schema: storageDatabaseSchema });
}

/** 关闭共享存储数据库连接并释放关联的预编译语句。 */
export function closeStorageDatabase(database: StorageDatabase): void {
  database.$client.close(true);
}

/** 打开指定路径的共享存储数据库，设置 WAL 模式后关闭连接。 */
export function enableStorageDatabaseWal(path: string): void {
  const database: StorageDatabase = openStorageDatabase({ path });
  try {
    database.$client.run("PRAGMA journal_mode = WAL;");
  } finally {
    closeStorageDatabase(database);
  }
}
