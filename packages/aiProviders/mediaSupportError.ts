/**
 * 跨 Worker 共享的供应商媒体输入不支持错误识别纯函数（供 aiChat 与 antiRaid 共用）。
 */

import {
  MEDIA_INPUT_CAPABILITY_PATTERN,
  MEDIA_INPUT_FILE_ERROR_PATTERN,
} from "../consts/aiChat/media";

/**
 * 从供应商错误对象读取数值 HTTP 状态码；非数值时返回 undefined。
 * @param error 捕获到的未知错误对象。
 * @returns 数值 HTTP 状态码；缺失或非数值时返回 undefined。
 */
export function numericErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate: { readonly status?: unknown } = error;
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

/**
 * 判断媒体请求错误是否明确表示模型不支持该输入模态（排除单份文件格式或损坏错误）。
 * @param status HTTP 状态码。
 * @param message 错误消息文本。
 * @returns 明确表示模态不受支持时返回 true，否则返回 false。
 */
export function isExplicitUnsupportedMediaError(
  status: number | undefined,
  message: string
): boolean {
  if (status !== 400 && status !== 415 && status !== 422) return false;
  if (MEDIA_INPUT_FILE_ERROR_PATTERN.test(message) || !MEDIA_INPUT_CAPABILITY_PATTERN.test(message)) return false;

  const normalized: string = message.toLowerCase();
  const rejectsCapability: boolean = normalized.includes("unsupported") ||
    normalized.includes("not supported") ||
    normalized.includes("does not support") ||
    normalized.includes("doesn't support") ||
    normalized.includes("cannot process") ||
    normalized.includes("can't process") ||
    normalized.includes("not capable");
  if (!rejectsCapability) return false;
  return normalized.includes("media") ||
    normalized.includes("modality") ||
    normalized.includes("image") ||
    normalized.includes("vision") ||
    normalized.includes("audio") ||
    normalized.includes("voice") ||
    normalized.includes("input type") ||
    normalized.includes("content type");
}
