import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type { CheckBuilder } from "drizzle-orm/sqlite-core";

/** 待踢任务表：`removal_id` 为主键，`data` 列保存严格 SQLite JSONB。 */
// eslint-disable-next-line @typescript-eslint/typedef
export const pendingBlockedRemovals = sqliteTable("pending_blocked_removals", {
  removalId: integer("removal_id", { mode: "number" }).primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("pending_blocked_removals_data_jsonb", table));
