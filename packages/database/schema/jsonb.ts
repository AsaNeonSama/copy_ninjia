import { sql } from "drizzle-orm";
import { check, customType } from "drizzle-orm/sqlite-core";
import {
  IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG,
  IDENTITY_DATABASE_JSONB_VALIDATION_FLAG,
} from "../../consts/identityStorage";
import type { SQL } from "drizzle-orm";
import type { CheckBuilder, SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * SQLite JSONB 的 Drizzle 驱动编解码边界。
 *
 * 写入时由 SQLite 把严格校验后的 JSON 文本编码为私有 JSONB BLOB；读取必须通过
 * `jsonbTextProjection` 转回文本，业务代码不接触 SQLite 私有二进制格式。
 */
export const jsonbText: ReturnType<typeof customType<{
  data: string;
  driverData: Uint8Array;
}>> = customType<{
  data: string;
  driverData: Uint8Array;
}>({
  dataType: (): string => "blob",
  toDriver: (value: string): SQL => sql`jsonb(${value})`,
  fromDriver: (_value: Uint8Array): never => {
    throw new Error("SQLite JSONB columns must be read through their schema projection.");
  },
});

/** 仅供各 JSONB 表声明共用 CHECK 时约束 data 列形状。 */
export interface JsonDataTable {
  /** 存储严格 SQLite JSONB BLOB 的 `data` 列。 */
  readonly data: SQLiteColumn;
}

/**
 * 为一张表生成 SQLite JSONB 合法性 CHECK，约束名由调用方显式提供。
 * @param name SQLite CHECK 约束名。
 * @param table 含 `data` 列的 Drizzle 表对象。
 * @returns 仅含该 JSONB 合法性约束的单元素数组。
 */
export function jsonDataCheck(name: string, table: JsonDataTable): CheckBuilder[] {
  const validationFlag: SQL = sql.raw(String(IDENTITY_DATABASE_JSONB_VALIDATION_FLAG));
  return [check(name, sql`json_valid(${table.data}, ${validationFlag})`)];
}

/**
 * 把 SQLite 私有 JSONB BLOB 投影为可交给严格领域解码器的规范 JSON 文本。
 * @param column 存储 JSONB BLOB 的 SQLite 列。
 * @returns 调用 `json(column)` 的 SQL 文本投影表达式。
 */
export function jsonbTextProjection(column: SQLiteColumn): SQL<string> {
  return sql<string>`json(${column})`;
}

/**
 * 启动分页先核对 BLOB 与严格 JSONB，再安全投影正文；非法值返回 null，
 * 不在投影时抛出 SQLite 底层错误。
 * @param column 存储 JSONB BLOB 的 SQLite 列。
 * @returns 合法 JSONB BLOB 投影为规范 JSON 文本、其余情况返回 `null` 的 SQL CASE 表达式。
 */
export function guardedStrictJsonbTextProjection(
  column: SQLiteColumn
): SQL<string | null> {
  const validationFlag: number = IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG;
  return sql<string | null>`CASE
    WHEN typeof(${column}) = 'blob' AND json_valid(${column}, ${validationFlag}) = 1
    THEN json(${column})
    ELSE NULL
  END`;
}

/**
 * 返回 SQLite 实际保存某行 data 的存储类，供 JSONB 存储检查使用。
 * @param column 待检查存储类的 SQLite 列。
 * @returns 调用 `typeof(column)` 的 SQL 字符串表达式。
 */
export function jsonbStorageClass(column: SQLiteColumn): SQL<string> {
  return sql<string>`typeof(${column})`;
}
