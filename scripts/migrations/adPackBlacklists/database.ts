/** `migrate:ad-pack-blacklists` 的 SQLite 源库校验、v13 → v14 升级、黑名单导入与全量复验。 */
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { adoptTimeZone, getTimeZone } from "../../../packages/config/time";
import { parseTimeZone } from "../../../packages/config/timeZoneInput";
import {
  IDENTITY_DATABASE_TIME_ZONE_KEY,
  STORAGE_MIGRATION_LINEAGE,
} from "../../../packages/consts/identityStorage";
import { IDENTITY_DATABASE_MIGRATIONS_DIR } from "../../../packages/consts/paths";
import {
  assertStorageDatabaseIntegrity,
  assertStorageDatabaseJsonbStorage,
  assertStorageDatabaseStartupJsonbStorage,
  readStorageDatabaseSchemaMetadata,
} from "../../../packages/database/interact/inspection";
import { readStorageDatabaseMigrationJournal } from "../../../packages/database/interact/migration";
import { validateStorageDatabase } from "../../../packages/database/interact/validation";
import { adPackBlacklists } from "../../../packages/database/schema/adPackBlacklist";
import {
  assertStorageTimeZone,
  readStorageSchemaVersion,
  storageRowSource,
} from "../../../packages/database/validation/storageRows";
import { invalidInput, parseJsonInput } from "../../../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../../packages/libs/record";
import type {
  StorageDatabase,
  StorageDatabaseMigrationJournalEntry,
  StoredAdPackBlacklistRow,
  StoredStorageMetadataRow,
} from "../../../packages/types/storageDatabase";

/** 本次直接冷迁移唯一接受的源数据库 schema 版本；目标版本为 `IDENTITY_DATABASE_SCHEMA_VERSION`。 */
export const AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION: number = 13;

/** `StorageDatabase.transaction` 回调接收的同步事务上下文类型。 */
type StorageDatabaseTransaction = Parameters<
  Parameters<StorageDatabase["transaction"]>[0]
>[0];

/** `PRAGMA wal_checkpoint(TRUNCATE)` 的单行返回结构。 */
interface WalCheckpointRow {
  /** 非零表示存在阻塞导致未完整截断 WAL。 */
  readonly busy: number;
  /** WAL 日志总帧数（非 WAL 模式下为 -1）。 */
  readonly log: number;
  /** 已成功写回主库文件的帧数（非 WAL 模式下为 -1）。 */
  readonly checkpointed: number;
}

/** `applyAdPackBlacklistsDatabaseMigration` 执行 v13 → v14 升级与导入的参数。 */
export interface ApplyAdPackBlacklistsDatabaseOptions {
  /** 已完成源库前置校验的产物副本数据库连接。 */
  readonly database: StorageDatabase;
  /** 用于报错定位的数据库路径标识。 */
  readonly source: string;
  /** 从源库 `storage_metadata['time-zone']` 读取并已校验的规范化 IANA 时区名称。 */
  readonly timeZone: string;
  /** 待写入 `ad_pack_blacklists`（`kind = 'sticker'`）的贴纸包名列表。 */
  readonly stickerBlackList: readonly string[];
  /** 待写入 `ad_pack_blacklists`（`kind = 'emoji'`）的自定义表情包名列表。 */
  readonly emojiBlackList: readonly string[];
}

/** 数据库冷迁移完成后的计数汇总。 */
export interface AdPackBlacklistsDatabaseCounts {
  /** 迁入 `ad_pack_blacklists` 的贴纸包黑名单条数。 */
  readonly migratedStickerPacks: number;
  /** 迁入 `ad_pack_blacklists` 的自定义表情包黑名单条数。 */
  readonly migratedEmojiPacks: number;
}

/**
 * 比较两段迁移谱系是否逐行一致（长度、每行 `createdAt` 与 `hash` 完全相等）。
 *
 * @param actual 实际读出的迁移日志条目列表。
 * @param expected 期望的迁移谱系条目列表。
 * @returns 两段谱系逐行相等时返回 true。
 */
function isSameMigrationLineage(
  actual: readonly StorageDatabaseMigrationJournalEntry[],
  expected: readonly StorageDatabaseMigrationJournalEntry[]
): boolean {
  if (actual.length !== expected.length) return false;
  for (let index: number = 0; index < expected.length; index++) {
    const row: StorageDatabaseMigrationJournalEntry | undefined = actual[index];
    const want: StorageDatabaseMigrationJournalEntry | undefined = expected[index];
    if (row?.createdAt !== want?.createdAt || row?.hash !== want?.hash) return false;
  }
  return true;
}

/**
 * 核对随包迁移 SQL 清单与源库 `__drizzle_migrations` 精确为 schema v13 谱系（`STORAGE_MIGRATION_LINEAGE.slice(0, -1)`）。
 *
 * @param database 已打开的产物副本共享存储数据库连接。
 * @param source 用于报错定位的数据库路径标识。
 */
function assertSourceLineage(database: StorageDatabase, source: string): void {
  const files: readonly StorageDatabaseMigrationJournalEntry[] = readMigrationFiles({
    migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR,
  }).map((entry: MigrationMeta): StorageDatabaseMigrationJournalEntry => ({
    createdAt: entry.folderMillis,
    hash: entry.hash,
  }));
  if (!isSameMigrationLineage(files, STORAGE_MIGRATION_LINEAGE)) {
    return invalidInput(source, "__drizzle_migrations", "the current release migration files");
  }
  if (
    !isSameMigrationLineage(
      readStorageDatabaseMigrationJournal(database, source),
      STORAGE_MIGRATION_LINEAGE.slice(0, -1)
    )
  ) {
    return invalidInput(
      source,
      "__drizzle_migrations",
      `the exact schema v${AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION} lineage`
    );
  }
}

/**
 * 校验源库 `storage_metadata` 的 JSONB 形态、精确版本号 `13` 与合法规范化时区标记，返回绑定时区。
 *
 * @param database 已打开的产物副本共享存储数据库连接。
 * @param source 用于报错定位的数据库路径标识。
 * @returns 源库绑定的规范化 IANA 时区名称。
 */
function readAndAssertSourceMetadata(database: StorageDatabase, source: string): string {
  assertStorageDatabaseStartupJsonbStorage(database, source);
  const metadata: readonly StoredStorageMetadataRow[] = readStorageDatabaseSchemaMetadata(database);
  const version: number = readStorageSchemaVersion({ metadata }, source);
  if (version !== AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION) {
    return invalidInput(
      source,
      "storage_metadata",
      `schema version ${AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION} from the preceding migration`
    );
  }
  const timeZoneRow: StoredStorageMetadataRow | undefined = metadata.find(
    (row: StoredStorageMetadataRow): boolean => row.key === IDENTITY_DATABASE_TIME_ZONE_KEY
  );
  if (timeZoneRow === undefined) {
    return invalidInput(source, `storage_metadata.${IDENTITY_DATABASE_TIME_ZONE_KEY}`, "present");
  }
  const timeZonePath: string = storageRowSource(
    source,
    "storage_metadata",
    IDENTITY_DATABASE_TIME_ZONE_KEY
  );
  const parsed: unknown = parseJsonInput(timeZoneRow.data, timeZonePath);
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ["timeZone"])) {
    return invalidInput(timeZonePath, "$.timeZone", "a canonical IANA time zone name");
  }
  const dbTimeZone: string = parseTimeZone(parsed.timeZone, timeZonePath, "$.timeZone");
  if (dbTimeZone !== parsed.timeZone) {
    return invalidInput(timeZonePath, "$.timeZone", "a canonical IANA time zone name");
  }
  assertStorageTimeZone({ metadata }, source, dbTimeZone);
  return dbTimeZone;
}

/**
 * 读取当前线程已接管的时区；尚未初始化时返回 null，避免影响 CLI 首次调用。
 *
 * @returns 当前线程已接管的 IANA 时区名称，或未初始化时的 null。
 */
function currentTimeZoneOrNull(): string | null {
  try {
    return getTimeZone();
  } catch {
    return null;
  }
}

/**
 * 在产物副本上执行全部 v13 源库只读前置校验（不改写数据库）：
 * 核对 `storage_metadata`（v13 与规范化时区）、精确 v13 迁移谱系、SQLite `integrity_check` 与全部 7 个 JSONB 列。
 *
 * @param database 已打开的产物副本共享存储数据库连接。
 * @param source 用于报错定位的数据库路径标识。
 * @returns 源库绑定的规范化 IANA 时区名称。
 */
export function inspectAdPackBlacklistsSourceDatabase(
  database: StorageDatabase,
  source: string
): string {
  const dbTimeZone: string = readAndAssertSourceMetadata(database, source);
  assertSourceLineage(database, source);
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  return dbTimeZone;
}

/**
 * 在产物副本上执行 schema v13 → v14 升级、写入贴纸/表情包黑名单、按源库时区运行生产级全量校验
 * (`validateStorageDatabase`) 并执行 `PRAGMA wal_checkpoint(TRUNCATE)`。
 *
 * @param options 产物数据库连接、路径标识、绑定时区与待导入的双黑名单列表。
 * @returns 写入 `ad_pack_blacklists` 的贴纸包与表情包条数汇总。
 */
export function applyAdPackBlacklistsDatabaseMigration({
  database,
  source,
  timeZone,
  stickerBlackList,
  emojiBlackList,
}: ApplyAdPackBlacklistsDatabaseOptions): AdPackBlacklistsDatabaseCounts {
  const previousTimeZone: string | null = currentTimeZoneOrNull();
  adoptTimeZone(timeZone);
  try {
    migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
    const rows: readonly StoredAdPackBlacklistRow[] = [
      ...stickerBlackList.map((pack: string): StoredAdPackBlacklistRow => ({ kind: "sticker", pack })),
      ...emojiBlackList.map((pack: string): StoredAdPackBlacklistRow => ({ kind: "emoji", pack })),
    ];
    if (rows.length > 0) {
      database.transaction((transaction: StorageDatabaseTransaction): void => {
        for (const row of rows) {
          transaction.insert(adPackBlacklists).values(row).run();
        }
      });
    }
    validateStorageDatabase(database, source);
    const checkpoint: WalCheckpointRow | null = database.$client
      .query<WalCheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE);")
      .get();
    if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
      return invalidInput(source, "wal_checkpoint", "a complete checkpoint without busy readers or writers");
    }
    return {
      migratedStickerPacks: stickerBlackList.length,
      migratedEmojiPacks: emojiBlackList.length,
    };
  } finally {
    if (previousTimeZone !== null) adoptTimeZone(previousTimeZone);
  }
}
