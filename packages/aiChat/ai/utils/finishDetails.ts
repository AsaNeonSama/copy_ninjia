/**
 * 供应商收尾详情的有界 JSON 序列化与诊断字符串拼接。
 */

import { AI_FINISH_DETAILS_MAX_CHARS } from "../../../consts/aiChat/provider";

/**
 * 将详情对象序列化为按 AI_FINISH_DETAILS_MAX_CHARS 截断的 JSON 字符串；
 * 空值返回 undefined，不可序列化时返回类型标记字符串。
 * @param value 供应商返回的原始收尾详情。
 * @returns 截断后的 JSON 字符串；空值返回 undefined。
 */
export function finishDetailsJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const encoded: string | undefined = JSON.stringify(value);
    if (encoded !== undefined) return encoded.slice(0, AI_FINISH_DETAILS_MAX_CHARS);
  } catch {
    // 落到下方的不可序列化类型标记。
  }
  return `[unserializable ${typeof value}]`;
}

/**
 * 将诊断前缀与可选的 finishDetails 拼接为完整诊断说明。
 * @param diagnostic 基础诊断文本。
 * @param finishDetails 可选的收尾详情 JSON 字符串。
 * @returns 拼接后的完整诊断说明。
 */
export function diagnosticWithDetails(diagnostic: string, finishDetails: string | undefined): string {
  return finishDetails === undefined ? diagnostic : `${diagnostic}, details=${finishDetails}`;
}
