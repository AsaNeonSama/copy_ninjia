import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type { CheckBuilder } from "drizzle-orm/sqlite-core";

/** 权限名单表：Telegram 用户或频道 ID 为主键，`policy` 列保存严格 SQLite JSONB。 */
// eslint-disable-next-line @typescript-eslint/typedef
export const permissionList = sqliteTable("permission_list", {
  id: integer("id", { mode: "number" }).primaryKey(),
  data: jsonbText("policy").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("permission_list_data_jsonb", table));

/** 黑名单表：Telegram 用户或频道 ID 为主键，`data` 列保存严格 SQLite JSONB。 */
// eslint-disable-next-line @typescript-eslint/typedef
export const blocklistEntries = sqliteTable("blocklist_entries", {
  id: integer("id", { mode: "number" }).primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("blocklist_entries_data_jsonb", table));
