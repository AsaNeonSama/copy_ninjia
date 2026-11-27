import { and, eq, sql } from "drizzle-orm";
import { adPackBlacklists } from "../schema/adPackBlacklist";
import { chatStates } from "../schema/chatState";
import { blocklistEntries, permissionList } from "../schema/identityPolicy";
import { jsonbTextProjection } from "../schema/jsonb";
import { temporaryAdBypassEntries } from "../schema/temporaryAdBypass";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { StorageDatabase, StorageDatabaseReader } from "../../types/storageDatabase";

/**
 * 生成列值属于指定 JSON 数组占位符展开集合的 SQL 条件。
 * @param column 待匹配的主键列定义。
 * @param placeholderName SQL 占位符名称（如 `"ids"` 或 `"packs"`）。
 * @returns `column IN (SELECT value FROM json_each(:placeholderName))` 的 SQL 片段。
 */
function valueInPlaceholderList(column: SQLiteColumn, placeholderName: string): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${sql.placeholder(placeholderName)}))`;
}

/**
 * 为指定数据库连接预编译名单批量/单行读取、临时广告免检批量/单行读取、广告包黑名单单行/批量读取与群状态主键读取语句。
 * @param database 共享存储数据库连接。
 * @returns 绑定到该连接的预编译读取语句句柄集合。
 */
export function prepareStorageDatabaseReader(database: StorageDatabase): StorageDatabaseReader {
  return {
    whitelistPolicies: database
      .select({ id: permissionList.id, data: jsonbTextProjection(permissionList.data) })
      .from(permissionList)
      .where(valueInPlaceholderList(permissionList.id, "ids"))
      .prepare(),
    whitelistPolicyById: database
      .select({ id: permissionList.id, data: jsonbTextProjection(permissionList.data) })
      .from(permissionList)
      .where(eq(permissionList.id, sql.placeholder("id")))
      .prepare(),
    blocklistPolicies: database
      .select({ id: blocklistEntries.id, data: jsonbTextProjection(blocklistEntries.data) })
      .from(blocklistEntries)
      .where(valueInPlaceholderList(blocklistEntries.id, "ids"))
      .prepare(),
    blocklistPolicyById: database
      .select({ id: blocklistEntries.id, data: jsonbTextProjection(blocklistEntries.data) })
      .from(blocklistEntries)
      .where(eq(blocklistEntries.id, sql.placeholder("id")))
      .prepare(),
    temporaryAdBypassActivities: database.select().from(temporaryAdBypassEntries)
      .where(valueInPlaceholderList(temporaryAdBypassEntries.id, "ids"))
      .prepare(),
    temporaryAdBypassActivityById: database.select().from(temporaryAdBypassEntries)
      .where(eq(temporaryAdBypassEntries.id, sql.placeholder("id")))
      .prepare(),
    adPackBlacklistByKey: database
      .select({ pack: adPackBlacklists.pack })
      .from(adPackBlacklists)
      .where(
        and(
          eq(adPackBlacklists.kind, sql.placeholder("kind")),
          eq(adPackBlacklists.pack, sql.placeholder("pack"))
        )
      )
      .prepare(),
    adPackBlacklistsByPacks: database
      .select({ pack: adPackBlacklists.pack })
      .from(adPackBlacklists)
      .where(
        and(
          eq(adPackBlacklists.kind, sql.placeholder("kind")),
          valueInPlaceholderList(adPackBlacklists.pack, "packs")
        )
      )
      .prepare(),
    chatStateIds: database.select({ chatId: chatStates.chatId }).from(chatStates).prepare(),
  };
}
