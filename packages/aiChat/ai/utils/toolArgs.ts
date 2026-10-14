/**
 * 工具调用参数 JSON 字符串的字段解析函数族。
 */

import { isPlainRecord } from "../../../libs/record";

/**
 * 将参数 JSON 解析为普通键值记录；解析失败或顶层非普通对象时返回 null。
 */
export function parseToolArguments(argumentsJson: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  return isPlainRecord(parsed) ? parsed : null;
}

/** 解析非空白字符串字段；解析失败、缺失或类型不符时返回 null。 */
export function parseStringField(argumentsJson: string, field: string): string | null {
  const value: unknown = parseToolArguments(argumentsJson)?.[field];
  return typeof value === "string" && value.trim() ? value : null;
}

/** 解析布尔字段；解析失败、缺失或非 true 时返回 false。 */
export function parseBooleanField(argumentsJson: string, field: string): boolean {
  return parseToolArguments(argumentsJson)?.[field] === true;
}

/**
 * 解析不大于 max 的正整数编号字段；解析失败、缺失、非整数或越界时返回 null。
 */
export function parseIndexField(argumentsJson: string, field: string, max: number): number | null {
  const index: unknown = parseToolArguments(argumentsJson)?.[field];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > max) return null;
  return index;
}
