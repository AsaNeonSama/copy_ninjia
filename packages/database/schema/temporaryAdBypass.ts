import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { CheckBuilder, SQLiteColumn } from "drizzle-orm/sqlite-core";

/** Drizzle 表级约束回调使用的临时广告免检列集合。 */
interface TemporaryAdBypassTableParams {
  /** 用户 Telegram 数值 ID 主键列。 */
  readonly id: SQLiteColumn;
  /** 临时广告免检状态列（0 或 1）。 */
  readonly adBypass: SQLiteColumn;
  /** 授予临时广告免检时的毫秒时间戳列，未免检时为 NULL。 */
  readonly adBypassGrantedAt: SQLiteColumn;
  /** 已达标的连续活跃天数累计列（0..7）。 */
  readonly qualifiedDays: SQLiteColumn;
  /** 当前统计日窗口内的发言计数列。 */
  readonly sendCount: SQLiteColumn;
  /** 最近一次发言计入统计时的毫秒时间戳列。 */
  readonly countedAt: SQLiteColumn;
  /** 最近一次达标并累加活跃天数时的毫秒时间戳列，未达标时为 NULL。 */
  readonly qualifiedAt: SQLiteColumn;
}

/** 临时广告免检及连续日活跃累计表。 */
// eslint-disable-next-line @typescript-eslint/typedef
export const temporaryAdBypassEntries = sqliteTable("temporary_ad_bypass_entries", {
  id: integer("id", { mode: "number" }).primaryKey(),
  adBypass: integer("ad_bypass", { mode: "boolean" }).notNull(),
  adBypassGrantedAt: integer("ad_bypass_granted_at", { mode: "number" }),
  qualifiedDays: integer("qualified_days", { mode: "number" }).notNull(),
  sendCount: integer("send_count", { mode: "number" }).notNull(),
  countedAt: integer("counted_at", { mode: "number" }).notNull(),
  qualifiedAt: integer("qualified_at", { mode: "number" }),
}, (table: TemporaryAdBypassTableParams): CheckBuilder[] => [
  check("temporary_ad_bypass_id", sql`${table.id} <> 0`),
  check("temporary_ad_bypass_flag", sql`${table.adBypass} IN (0, 1)`),
  check(
    "temporary_ad_bypass_timestamp",
    sql`(${table.adBypass} = 1 AND ${table.adBypassGrantedAt} IS NOT NULL) OR (${table.adBypass} = 0 AND ${table.adBypassGrantedAt} IS NULL)`
  ),
  check(
    "temporary_ad_bypass_day_count",
    sql`${table.qualifiedDays} BETWEEN 0 AND 7 AND (${table.adBypass} = 1 OR ${table.qualifiedDays} = 0)`
  ),
  check("temporary_ad_bypass_send_count", sql`${table.sendCount} >= 1`),
  check("temporary_ad_bypass_counted_at", sql`${table.countedAt} >= 0`),
  check(
    "temporary_ad_bypass_qualified_at",
    sql`(${table.qualifiedAt} IS NULL AND ${table.sendCount} <= 7) OR (${table.qualifiedAt} BETWEEN 0 AND ${table.countedAt} AND ${table.sendCount} > 7 AND ${table.qualifiedDays} >= 1)`
  ),
  check(
    "temporary_ad_bypass_granted_at",
    sql`${table.adBypassGrantedAt} IS NULL OR (${table.adBypassGrantedAt} BETWEEN 0 AND ${table.countedAt} AND (${table.qualifiedAt} IS NULL OR ${table.adBypassGrantedAt} <= ${table.qualifiedAt}))`
  ),
]);
