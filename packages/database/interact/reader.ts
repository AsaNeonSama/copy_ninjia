import { sql } from "drizzle-orm";
import { chatStates } from "../schema/chatState";
import { blocklistEntries, permissionList } from "../schema/identityPolicy";
import { jsonbTextProjection } from "../schema/jsonb";
import { temporaryAdBypassEntries } from "../schema/temporaryAdBypass";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { StorageDatabase, StorageDatabaseReader } from "../../types/storageDatabase";

/** 主键落在 `ids` 占位（JSON 数组文本）展开出的集合里。 */
function idInPlaceholderList(column: SQLiteColumn): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${sql.placeholder("ids")}))`;
}

/**
 * 为一条连接建预热与容量闸用的整套预编译读语句。
 *
 * 批量读取以 `ids` 占位绑定一个 JSON 数组文本，id 个数不同也复用同一条语句；
 * 调用方不得在每次读取时现拼 Drizzle 查询。本函数只建不持有：语句挂在
 * cache/workers/diskIO/storageDatabase.ts 的连接级 WeakMap 上（由
 * workers/diskIO/storageDatabase/context.ts 取用），本文件不接触线程独占缓存。
 */
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
