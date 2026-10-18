import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type { CheckBuilder } from "drizzle-orm/sqlite-core";

/** 数据库元数据表（主键与严格 JSONB 值）。 */
// eslint-disable-next-line @typescript-eslint/typedef
export const storageMetadata = sqliteTable("storage_metadata", {
  key: text("key").primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("storage_metadata_data_jsonb", table));
