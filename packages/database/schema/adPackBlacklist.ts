import { sql } from "drizzle-orm";
import { check, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  SQLiteColumn,
  SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";

/** `ad_pack_blacklists` 表参与复合主键与表级 CHECK 约束的列集合。 */
interface AdPackBlacklistColumns {
  /** 黑名单种类列（`'sticker'` 或 `'emoji'`）。 */
  readonly kind: SQLiteColumn;
  /** Telegram 贴纸包或自定义表情包 short name 列。 */
  readonly pack: SQLiteColumn;
}

/** 广告贴纸包与自定义表情包黑名单表：`(kind, pack)` 复合主键，STRICT 关系表。 */
// eslint-disable-next-line @typescript-eslint/typedef
export const adPackBlacklists = sqliteTable("ad_pack_blacklists", {
  kind: text("kind").notNull(),
  pack: text("pack").notNull(),
}, (table: AdPackBlacklistColumns): SQLiteTableExtraConfigValue[] => [
  primaryKey({ columns: [table.kind, table.pack] }),
  check("ad_pack_blacklists_kind", sql`${table.kind} IN ('sticker', 'emoji')`),
  check(
    "ad_pack_blacklists_pack",
    sql`length(${table.pack}) BETWEEN 1 AND 64 AND ${table.pack} NOT GLOB '*[^A-Za-z0-9_]*'`
  ),
]);
