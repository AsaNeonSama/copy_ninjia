import { lstatSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { IDENTITY_DATABASE_MIGRATIONS_DIR } from "../../consts/paths";
import { storageDatabaseSchema } from "../schema/storage";
import type {
  StorageDatabase,
  StorageDatabaseMigrationJournalEntry,
} from "../../types/storageDatabase";

/**
 * 创建新库并交给 Drizzle 内建 migrator 建表；目标目录项已存在（含悬空软链接）时拒绝覆盖。
 * @param path 新数据库文件的目标路径。
 */
export function createStorageDatabase(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`${path}: target already exists; refusing to overwrite it.`);
  }
  const client: Database = new Database(path, {
    create: true,
    readwrite: true,
    strict: true,
    safeIntegers: false,
  });
  try {
    const database: StorageDatabase = drizzle({ client, schema: storageDatabaseSchema });
    migrateStorageDatabaseSchema(database);
  } finally {
    client.close(false);
  }
}

/**
 * 给刚建出来的空库应用当前 schema；只有 createStorageDatabase 调用，生产启动不得调用。
 * @param database 刚创建的空共享存储数据库实例。
 */
function migrateStorageDatabaseSchema(database: StorageDatabase): void {
  migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
}

/**
 * 读取并严格校验 Drizzle 迁移谱系；启动据此拒绝未知历史。
 * @param database 共享存储数据库连接。
 * @param source 数据库来源路径标识，用于构造错误消息。
 * @returns 按 `created_at` 升序排列的迁移日志条目列表。
 */
export function readStorageDatabaseMigrationJournal(
  database: StorageDatabase,
  source: string
): readonly StorageDatabaseMigrationJournalEntry[] {
  const rows: StorageDatabaseMigrationJournalEntry[] = database.$client
    .query<StorageDatabaseMigrationJournalEntry, []>(
      "SELECT created_at AS createdAt, hash " +
      "FROM __drizzle_migrations ORDER BY created_at ASC;"
    )
    .all();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.createdAt) ||
      row.createdAt < 1 ||
      !/^[a-f0-9]{64}$/.test(row.hash)
    ) {
      throw new Error(
        `${source}:__drizzle_migrations: expected positive timestamps and SHA-256 hashes.`
      );
    }
  }
  return rows;
}
