import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type {
  CheckBuilder,
  SQLiteColumn,
  SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";

/** 群问答表：`(chat_id, q)` 复合主键，`data` 列保存严格 SQLite JSONB。 */
// eslint-disable-next-line @typescript-eslint/typedef
export const chatQa = sqliteTable("chat_qa", {
  chatId: integer("chat_id", { mode: "number" }).notNull(),
  q: text("q").notNull(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable & {
  readonly chatId: SQLiteColumn;
  readonly q: SQLiteColumn;
}): SQLiteTableExtraConfigValue[] => {
  const checks: CheckBuilder[] = jsonDataCheck("chat_qa_data_jsonb", table);
  return [primaryKey({ columns: [table.chatId, table.q] }), ...checks];
});
