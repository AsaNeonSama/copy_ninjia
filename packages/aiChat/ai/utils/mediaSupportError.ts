/**
 * 供应商 API 失败的错误分类：区分端点配置错误、输入模态不受支持、单次输入被拒与端点故障；
 * 各模型客户端捕获的 SDK APIError 经 logAndClassifyProviderApiError 统一记录日志后分类。
 */

import {
  MEDIA_INPUT_CAPABILITY_PATTERN,
  MEDIA_INPUT_FILE_ERROR_PATTERN,
} from "../../../consts/aiChat/media";
import { logger } from "../../../infra/logger";

/**
 * 从供应商错误对象读取数值 HTTP 状态码；非数值时返回 undefined。
 * @param error 捕获到的未知错误对象。
 * @returns 数值 HTTP 状态码；缺失或非数值时返回 undefined。
 */
export function numericErrorStatus(error: unknown): number | undefined {
  const candidate: { readonly status?: unknown } = error as { readonly status?: unknown };
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

/**
 * 判断状态码是否表示当前配置的 API 路径或模型不可调用。
 * @param status HTTP 状态码。
 * @returns 状态码为 404 或 405 时返回 true，否则返回 false。
 */
function isEndpointMisconfiguredError(status: number | undefined): boolean {
  return status === 404 || status === 405;
}

/**
 * 判断状态码是否表示网络、超时、限流或服务端故障等端点级异常。
 * @param status HTTP 状态码。
 * @returns 无状态码、408、429 或 5xx 时返回 true，否则返回 false。
 */
function isEndpointFailureStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * 判断媒体请求错误是否明确表示模型不支持该输入模态（排除单份文件格式或损坏错误）。
 * @param status HTTP 状态码。
 * @param message 错误消息文本。
 * @returns 明确表示模态不受支持时返回 true，否则返回 false。
 */
function isExplicitUnsupportedMediaError(
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

/** 供应商 API 失败的归因档位。 */
export type ProviderApiFailureKind =
  | "misconfigured"
  | "unsupported"
  | "rejected"
  | "endpointFailure";

/**
 * 按固定优先级对供应商 API 错误做级联归因：
 * 依次判定路径配置错误、媒体模态不支持、单次输入被拒与端点故障。
 * @param status HTTP 状态码。
 * @param message 错误消息文本。
 * @param isMediaCapability 当前请求是否为媒体输入模态请求。
 * @returns 归因后的失败档位。
 */
export function classifyProviderApiFailure(
  status: number | undefined,
  message: string,
  isMediaCapability: boolean
): ProviderApiFailureKind {
  if (isEndpointMisconfiguredError(status)) return "misconfigured";
  if (isMediaCapability && isExplicitUnsupportedMediaError(status, message)) {
    return "unsupported";
  }
  if (!isEndpointFailureStatus(status)) return "rejected";
  return "endpointFailure";
}

/** logAndClassifyProviderApiError 的入参。 */
export interface ProviderApiErrorClassificationOptions {
  /** 捕获到的供应商 SDK API 错误对象。 */
  readonly error: { readonly message: string; readonly status?: unknown };
  /** 日志前缀使用的调用点标识。 */
  readonly errorLabel: string;
  /** 当前请求是否为媒体输入模态请求。 */
  readonly isMediaCapability: boolean;
  /** 是否在错误消息前拼入 HTTP 状态码（Gemini SDK 的错误日志格式）。 */
  readonly includeStatusInLog?: boolean;
}

/**
 * 记录供应商 SDK API 错误日志并返回归因后的失败档位。
 * @param options 供应商 API 错误对象、日志标签与模态归因选项。
 * @returns 归因后的供应商 API 失败档位。
 */
export function logAndClassifyProviderApiError({
  error,
  errorLabel,
  isMediaCapability,
  includeStatusInLog = false,
}: ProviderApiErrorClassificationOptions): ProviderApiFailureKind {
  logger.error(
    includeStatusInLog
      ? `${errorLabel} error: ${String(error.status)} ${error.message}`
      : `${errorLabel} error: ${error.message}`
  );
  return classifyProviderApiFailure(
    numericErrorStatus(error),
    error.message,
    isMediaCapability
  );
}

/** 各模型客户端共用的非端点故障失败结果。 */
export interface ProviderApiFailureResult {
  /** 固定为 false，表示请求失败。 */
  readonly ok: false;
  /** 非端点故障的具体失败归因档位。 */
  readonly failureKind: Exclude<ProviderApiFailureKind, "endpointFailure">;
}

/**
 * 将非端点故障的归因档位映射为客户端失败结果；endpointFailure 返回 undefined 交由调用方记日志兜底。
 * @param kind 供应商 API 失败归因档位。
 * @returns 非端点故障的客户端失败结果；为 endpointFailure 时返回 undefined。
 */
export function providerApiFailureResult(
  kind: ProviderApiFailureKind
): ProviderApiFailureResult | undefined {
  switch (kind) {
    case "misconfigured":
      return { ok: false, failureKind: kind };
    case "unsupported":
      return { ok: false, failureKind: kind };
    case "rejected":
      return { ok: false, failureKind: kind };
    case "endpointFailure":
      return undefined;
  }
}
