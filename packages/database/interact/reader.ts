import { sql } from "drizzle-orm";
import { chatStates } from "../schema/chatState";
import { blocklistEntries, permissionList } from "../schema/identityPolicy";
import { jsonbTextProjection } from "../schema/jsonb";
import { temporaryAdBypassEntries } from "../schema/temporaryAdBypass";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { StorageDatabase, StorageDatabaseReader } from "../../types/storageDatabase";

/** 生成列值属于 `ids` JSON 数组占位符展开集合的 SQL 条件。 */
function idInPlaceholderList(column: SQLiteColumn): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${sql.placeholder("ids")}))`;
}

/** 为指定数据库连接预编译名单批量读取、临时广告免检批量读取与群状态主键读取语句。 */
export function prepareStorageDatabaseReader(database: StorageDatabase): StorageDatabaseReader {
  return {
    whitelistPolicies: database
      .select({ id: permissionList.id, data: jsonbTextProjection(permissionList.data) })
      .from(permissionList)
      .where(idInPlaceholderList(permissionList.id))
      .prepare(),
    blocklistPolicies: database
      .select({ id: blocklistEntries.id, data: jsonbTextProjection(blocklistEntries.data) })
      .from(blocklistEntries)
      .where(idInPlaceholderList(blocklistEntries.id))
      .prepare(),
    temporaryAdBypassActivities: database.select().from(temporaryAdBypassEntries)
      .where(idInPlaceholderList(temporaryAdBypassEntries.id))
      .prepare(),
    chatStateIds: database.select({ chatId: chatStates.chatId }).from(chatStates).prepare(),
  };
}
