import { asc, count, gt } from "drizzle-orm";
import { BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE } from
  "../../consts/antiRaid/blocklist";
import { STORAGE_MIGRATION_LINEAGE } from "../../consts/identityStorage";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
} from "../codec/identity";
import { assertTemporaryAdBypassActivity } from "../codec/temporaryAdBypass";
import { readStoredChatStates } from "./chatState";
import { readStoredChatQa } from "./chatQa";
import { blocklistEntries, permissionList } from "../schema/identityPolicy";
import {
  guardedStrictJsonbTextProjection,
  jsonbStorageClass,
  jsonbTextProjection,
} from "../schema/jsonb";
import { storageMetadata } from "../schema/metadata";
import { pendingBlockedRemovals } from "../schema/pendingRemoval";
import type { StoredTemporaryAdBypassActivity } from
  "../../types/temporaryAdBypass";
import { readStorageDatabaseMigrationJournal } from "./migration";
import { storageRowSource } from "../validation/storageRows";
import type {
  StorageDatabase,
  StorageDatabaseJsonStorageRow,
  StorageDatabaseStartupRows,
  StorageDatabaseMigrationJournalEntry,
  StoredChatStateRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalStartupRow,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";

/** 读取单张表 JSONB 列存储统计的选项。 */
interface ReadJsonbStorageRowOptions {
  /** 待检查的 SQLite 表名。 */
  readonly tableName: string;
  /** 待检查的 JSONB 列名；缺省为 `"data"`。 */
  readonly columnName?: string;
  /** 为 true 时统计前忽略 SQL NULL 行。 */
  readonly nullable?: boolean;
}

/** `pragma_table_xinfo` 查询出的列声明类型行。 */
interface StorageColumnDeclarationRow {
  /** SQLite 表定义中声明的列类型字符串。 */
  readonly type: string;
}

/** 单张表 JSONB 列的存储分布聚合查询行。 */
interface StorageJsonbAggregateRow {
  /** 参与统计的总行数。 */
  readonly rowCount: number;
  /** 存储类为 `text` 的行数。 */
  readonly textRows: number;
  /** 存储类为 `blob` 的行数。 */
  readonly blobRows: number;
  /** 未通过 `json_valid(..., 8)` 严格 JSONB 校验的行数。 */
  readonly invalidJsonbRows: number;
}

/** `PRAGMA integrity_check` 返回的单行结果。 */
interface StorageDatabaseIntegrityRow {
  /** 完整性检查结果字符串（正常时为 `"ok"`）。 */
  readonly integrity_check: string;
}

/**
 * 读取单张表指定 JSONB 列的声明类型与存储类型分布统计。
 * @param database 共享存储数据库连接。
 * @param options 表名、列名与可空标志。
 * @returns 该列的声明类型及文本/二进制/非法 JSONB 行数统计。
 */
function readJsonbStorageRow(
  database: StorageDatabase,
  { tableName, columnName = "data", nullable = false }: ReadJsonbStorageRowOptions
): StorageDatabaseJsonStorageRow {
  const declaration: StorageColumnDeclarationRow | null = database.$client
    .query<StorageColumnDeclarationRow, [string, string]>(
      "SELECT type FROM pragma_table_xinfo(?1) WHERE name = ?2;"
    )
    .get(tableName, columnName);
  const aggregate: StorageJsonbAggregateRow | null = database.$client
    .query<StorageJsonbAggregateRow, []>(
      `SELECT COUNT(*) AS rowCount, ` +
      `COALESCE(SUM(typeof(${columnName}) = 'text'), 0) AS textRows, ` +
      `COALESCE(SUM(typeof(${columnName}) = 'blob'), 0) AS blobRows, ` +
      `COALESCE(SUM(json_valid(${columnName}, 8) <> 1), 0) AS invalidJsonbRows ` +
      `FROM ${tableName}${nullable ? ` WHERE ${columnName} IS NOT NULL` : ""};`
    )
    .get();
  return {
    tableName: `${tableName}.${columnName}`,
    declaredType: declaration?.type.toUpperCase() ?? null,
    rowCount: aggregate?.rowCount ?? 0,
    textRows: aggregate?.textRows ?? 0,
    blobRows: aggregate?.blobRows ?? 0,
    invalidJsonbRows: aggregate?.invalidJsonbRows ?? 0,
  };
}

/**
 * 读取当前 schema 全部 JSONB 列的声明与存储统计。
 * @param database 共享存储数据库连接。
 * @returns 当前 schema 全部 7 个 JSONB 列的存储统计列表。
 */
function readStorageDatabaseJsonStorage(
  database: StorageDatabase
): readonly StorageDatabaseJsonStorageRow[] {
  return [
    readJsonbStorageRow(database, { tableName: "permission_list", columnName: "policy" }),
    readJsonbStorageRow(database, { tableName: "blocklist_entries" }),
    readJsonbStorageRow(database, { tableName: "pending_blocked_removals" }),
    readJsonbStorageRow(database, { tableName: "storage_metadata" }),
    readJsonbStorageRow(database, { tableName: "chat_states", columnName: "status" }),
    readJsonbStorageRow(database, { tableName: "chat_states", columnName: "ai_context", nullable: true }),
    readJsonbStorageRow(database, { tableName: "chat_qa" }),
  ];
}

/**
 * 断言给定 JSONB 列统计均声明为 BLOB 且全部非空行都是合法的 SQLite JSONB。
 * @param rows 待核对的 JSONB 列统计列表。
 * @param source 数据库来源路径标识，用于构造错误消息。
 * @param expectedCount 期望的统计条目数。
 */
function assertJsonbStorageRows(
  rows: readonly StorageDatabaseJsonStorageRow[],
  source: string,
  expectedCount: number
): void {
  if (rows.length !== expectedCount) {
    throw new Error(
      `${source}: expected JSONB storage metadata for exactly ` +
      `${expectedCount} storage tables.`
    );
  }
  for (const row of rows) {
    if (
      row.declaredType !== "BLOB" ||
      row.textRows !== 0 ||
      row.blobRows !== row.rowCount ||
      row.invalidJsonbRows !== 0
    ) {
      throw new Error(
        `${source}:${row.tableName}: expected a BLOB column containing only strict SQLite JSONB.`
      );
    }
  }
}

/**
 * 启动与性能夹具都拒绝当前 schema 全部 JSONB 列的非严格存储。
 * @param database 共享存储数据库连接。
 * @param source 数据库来源路径标识，用于构造错误消息。
 */
export function assertStorageDatabaseJsonbStorage(
  database: StorageDatabase,
  source: string
): void {
  assertJsonbStorageRows(readStorageDatabaseJsonStorage(database), source, 7);
}

/**
 * 启动时执行 SQLite 自身的完整性检查。
 * @param database 共享存储数据库连接。
 * @param source 数据库来源路径标识，用于构造错误消息。
 */
export function assertStorageDatabaseIntegrity(
  database: StorageDatabase,
  source: string
): void {
  const rows: StorageDatabaseIntegrityRow[] = database.$client
    .query<StorageDatabaseIntegrityRow, []>("PRAGMA integrity_check;")
    .all();
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error(`${source}: expected SQLite integrity_check to return exactly ok.`);
  }
}

/**
 * 两段迁移谱系逐行相等：条数相同，每行的 created_at 与 hash 都相同。
 * @param actual 数据库中实际读出的迁移日志条目列表。
 * @param expected 期望的内置迁移谱系条目列表。
 * @returns 两段迁移谱系完全一致时返回 true。
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
 * `__drizzle_migrations` 必须与 STORAGE_MIGRATION_LINEAGE 逐行相等，不接受缺项、额外项或乱序。
 * @param database 共享存储数据库连接。
 * @param source 数据库来源路径标识，用于构造错误消息。
 */
export function assertStorageDatabaseMigrationLineage(
  database: StorageDatabase,
  source: string
): void {
  if (!isSameMigrationLineage(readStorageDatabaseMigrationJournal(database, source), STORAGE_MIGRATION_LINEAGE)) {
    throw new Error(`${source}: expected the exact supported schema v13 migration lineage.`);
  }
}

/**
 * 流式严格解码三张身份表（`permission_list`、`blocklist_entries`、`temporary_ad_bypass_entries`），
 * 并用 SQL 拒绝跨表重复主键。
 * @param database 共享存储数据库连接。
 * @param source 数据库来源路径标识，用于构造错误消息。
 */
export function assertStoredIdentityPolicies(
  database: StorageDatabase,
  source: string
): void {
  const overlap: { readonly id: number } | null = database.$client
    .query<{ readonly id: number }, []>(
      "SELECT permission_list.id AS id FROM permission_list " +
      "INNER JOIN blocklist_entries USING (id) LIMIT 1;"
    )
    .get();
  if (overlap !== null) {
    throw new Error(
      `${source}:permission_list/blocklist_entries[$.id]: expected disjoint primary keys.`
    );
  }
  const temporaryOverlap: { readonly id: number } | null = database.$client
    .query<{ readonly id: number }, []>(
      "SELECT temporary_ad_bypass_entries.id AS id FROM temporary_ad_bypass_entries " +
      "INNER JOIN blocklist_entries USING (id) LIMIT 1;"
    )
    .get();
  if (temporaryOverlap !== null) {
    throw new Error(
      `${source}:temporary_ad_bypass_entries/blocklist_entries[$.id]: ` +
      "expected disjoint primary keys."
    );
  }
  const whitelistRows: IterableIterator<StoredIdentityPolicyRow> = database.$client
    .query<StoredIdentityPolicyRow, []>(
      "SELECT id, json(policy) AS data FROM permission_list ORDER BY id ASC;"
    )
    .iterate();
  for (const row of whitelistRows) {
    const path: string = storageRowSource(source, "permission_list", row.id);
    assertTelegramIdentityId(row.id, path);
    decodeWhitelistEntryData(row.data, path);
  }
  const blocklistRows: IterableIterator<StoredIdentityPolicyRow> = database.$client
    .query<StoredIdentityPolicyRow, []>(
      "SELECT id, json(data) AS data FROM blocklist_entries ORDER BY id ASC;"
    )
    .iterate();
  for (const row of blocklistRows) {
    const path: string = storageRowSource(source, "blocklist_entries", row.id);
    assertTelegramIdentityId(row.id, path);
    decodeBlocklistEntryData(row.data, path);
  }
  const temporaryRows: IterableIterator<{
    readonly id: number;
    readonly adBypass: number;
    readonly adBypassGrantedAt: number | null;
    readonly qualifiedDays: number;
    readonly sendCount: number;
    readonly countedAt: number;
    readonly qualifiedAt: number | null;
  }> = database.$client.query<{
    readonly id: number;
    readonly adBypass: number;
    readonly adBypassGrantedAt: number | null;
    readonly qualifiedDays: number;
    readonly sendCount: number;
    readonly countedAt: number;
    readonly qualifiedAt: number | null;
  }, []>(
    "SELECT id, ad_bypass AS adBypass, ad_bypass_granted_at AS adBypassGrantedAt, " +
    "qualified_days AS qualifiedDays, send_count AS sendCount, " +
    "counted_at AS countedAt, qualified_at AS qualifiedAt " +
    "FROM temporary_ad_bypass_entries ORDER BY id ASC;"
  ).iterate();
  for (const row of temporaryRows) {
    const path: string = `${source}:temporary_ad_bypass_entries[${row.id}]`;
    assertTelegramIdentityId(row.id, path);
    if (row.adBypass !== 0 && row.adBypass !== 1) {
      throw new Error(`${path}.ad_bypass: expected SQLite integer 0 or 1.`);
    }
    const activity: StoredTemporaryAdBypassActivity = {
      id: row.id,
      adBypass: row.adBypass === 1,
      adBypassGrantedAt: row.adBypassGrantedAt,
      qualifiedDays: row.qualifiedDays,
      sendCount: row.sendCount,
      countedAt: row.countedAt,
      qualifiedAt: row.qualifiedAt,
    };
    assertTemporaryAdBypassActivity(activity, path);
  }
}

/**
 * 校验 `storage_metadata.data` 列为严格 JSONB BLOB。
 * @param database 共享存储数据库连接。
 * @param source 数据库来源路径标识，用于构造错误消息。
 */
export function assertStorageDatabaseStartupJsonbStorage(
  database: StorageDatabase,
  source: string
): void {
  assertJsonbStorageRows([
    readJsonbStorageRow(database, {
      tableName: "storage_metadata",
    }),
  ], source, 1);
}

/**
 * 读取 `storage_metadata` 全表行。
 * @param database 共享存储数据库连接。
 * @returns `storage_metadata` 表中的全部键值行列表。
 */
export function readStorageDatabaseSchemaMetadata(
  database: StorageDatabase
): readonly StoredStorageMetadataRow[] {
  return database
    .select({ key: storageMetadata.key, data: jsonbTextProjection(storageMetadata.data) })
    .from(storageMetadata)
    .all();
}

/**
 * 读取启动恢复所需的名单条数统计、群状态全表行与群问答全表行。
 * @param database 共享存储数据库连接。
 * @returns 启动恢复所需的原始行与条数汇总。
 */
export function readStorageDatabaseStartupRows(
  database: StorageDatabase
): StorageDatabaseStartupRows {
  const permissionEntryCount: number = database
    .select({ value: count() }).from(permissionList).get()?.value ?? 0;
  const blocklistEntryCount: number = database
    .select({ value: count() }).from(blocklistEntries).get()?.value ?? 0;
  const storedChatStates: readonly StoredChatStateRow[] = readStoredChatStates(database);
  return {
    permissionEntryCount,
    blocklistEntryCount,
    chatStates: storedChatStates,
    chatQa: readStoredChatQa(database),
  };
}

/**
 * 按 `removal_id` 升序游标读取一页待踢任务行及其存储形态。
 * @param database 共享存储数据库连接。
 * @param afterRemovalId 上一页最后一个 `removal_id`；首页传 null。
 * @returns 当前页的待踢任务原始行列表。
 */
export function readStorageDatabasePendingRemovalPage(
  database: StorageDatabase,
  afterRemovalId: number | null
): readonly StoredPendingRemovalStartupRow[] {
  if (afterRemovalId === null) {
    return database
      .select({
        removalId: pendingBlockedRemovals.removalId,
        data: guardedStrictJsonbTextProjection(pendingBlockedRemovals.data),
        storageClass: jsonbStorageClass(pendingBlockedRemovals.data),
      })
      .from(pendingBlockedRemovals)
      .orderBy(asc(pendingBlockedRemovals.removalId))
      .limit(BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE)
      .all();
  }
  return database
    .select({
      removalId: pendingBlockedRemovals.removalId,
      data: guardedStrictJsonbTextProjection(pendingBlockedRemovals.data),
      storageClass: jsonbStorageClass(pendingBlockedRemovals.data),
    })
    .from(pendingBlockedRemovals)
    .where(gt(pendingBlockedRemovals.removalId, afterRemovalId))
    .orderBy(asc(pendingBlockedRemovals.removalId))
    .limit(BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE)
    .all();
}
