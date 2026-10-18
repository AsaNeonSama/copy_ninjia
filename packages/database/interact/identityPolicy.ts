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

/** 为指定数据库连接预编译白名单、黑名单与临时广告免检表的按主键存在性查询语句。 */
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

/** 按主键升序游标读取一页黑名单 ID。 */
export function readStoredBlocklistIdPage(
  database: StorageDatabase,
  afterId: number | null,
  limit: number
): readonly number[] {
  const rows: StoredIdentityIdRow[] = database
    .select({ id: blocklistEntries.id })
    .from(blocklistEntries)
    .where(afterId === null ? undefined : gt(blocklistEntries.id, afterId))
    .orderBy(asc(blocklistEntries.id))
    .limit(limit)
    .all();
  return rows.map((row: StoredIdentityIdRow): number => row.id);
}

/** 通过预编译语句按 ID 列表批量读取白名单或黑名单的已提交行（单批不超过 IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES）。 */
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
