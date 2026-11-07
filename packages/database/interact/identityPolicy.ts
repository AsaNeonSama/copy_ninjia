import { asc, eq, gt, sql } from "drizzle-orm";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../consts/identityStorage";
import { blocklistEntries, permissionList } from "../schema/identityPolicy";
import { temporaryAdBypassEntries } from "../schema/temporaryAdBypass";
import type { IdentityPolicyTable } from "../../types/identityPolicy";
import type {
  StorageDatabase,
  StorageDatabaseReader,
  StoredIdentityIdLookups,
  StoredIdentityIdRow,
  StoredIdentityPolicyRow,
} from "../../types/storageDatabase";

/**
 * 为指定数据库连接预编译白名单、黑名单与临时广告免检表的按主键存在性查询语句。
 * @param database 共享存储数据库连接。
 * @returns 三张身份表的按主键查询预编译句柄集合。
 */
export function prepareStoredIdentityIdLookups(
  database: StorageDatabase
): StoredIdentityIdLookups {
  return {
    whitelist: database.select({ id: permissionList.id }).from(permissionList)
      .where(eq(permissionList.id, sql.placeholder("id"))).prepare(),
    blocklist: database.select({ id: blocklistEntries.id }).from(blocklistEntries)
      .where(eq(blocklistEntries.id, sql.placeholder("id"))).prepare(),
    temporaryAdBypass: database.select({ id: temporaryAdBypassEntries.id })
      .from(temporaryAdBypassEntries)
      .where(eq(temporaryAdBypassEntries.id, sql.placeholder("id"))).prepare(),
  };
}

/** `readStoredIdentityIdPage` 的游标与页大小。 */
export interface StoredIdentityIdPageCursor {
  /** 上一页最后一个主键 ID；首页传 null。 */
  readonly afterId: number | null;
  /** 单页最多读取的行数。 */
  readonly limit: number;
}

/**
 * 按主键升序游标读取一页黑名单或白名单 ID。
 * @param database 共享存储数据库连接。
 * @param table 读取的名单（白名单读 permission_list，黑名单读 blocklist_entries）。
 * @param cursor 游标起点（不含）与单页行数上限。
 * @returns 按升序排列的身份 ID 列表。
 */
export function readStoredIdentityIdPage(
  database: StorageDatabase,
  table: IdentityPolicyTable,
  { afterId, limit }: StoredIdentityIdPageCursor
): readonly number[] {
  const source: typeof permissionList | typeof blocklistEntries =
    table === "whitelist" ? permissionList : blocklistEntries;
  const rows: StoredIdentityIdRow[] = database
    .select({ id: source.id })
    .from(source)
    .where(afterId === null ? undefined : gt(source.id, afterId))
    .orderBy(asc(source.id))
    .limit(limit)
    .all();
  return rows.map((row: StoredIdentityIdRow): number => row.id);
}

/**
 * 通过预编译语句按 ID 列表批量读取白名单或黑名单的已提交行（单批不超过 IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES）。
 * @param reader 共享存储数据库的预编译读取句柄。
 * @param table 目标身份策略表标识（白名单或黑名单）。
 * @param ids 待读取的身份主键 ID 列表。
 * @returns 命中行的主键与 JSON 文本列表。
 */
export function readStoredIdentityPolicies(
  reader: StorageDatabaseReader,
  table: IdentityPolicyTable,
  ids: readonly number[]
): readonly StoredIdentityPolicyRow[] {
  if (ids.length === 0) return [];
  if (ids.length > IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES) {
    throw new Error(
      `Identity policy reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`
    );
  }
  return (table === "whitelist" ? reader.whitelistPolicies : reader.blocklistPolicies)
    .all({ ids: JSON.stringify(ids) });
}
