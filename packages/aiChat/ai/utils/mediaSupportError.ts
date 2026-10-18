/**
 * 供应商 API 失败的错误分类：区分端点配置错误、输入模态不受支持、单次输入被拒与端点故障。
 */

import {
  MEDIA_INPUT_CAPABILITY_PATTERN,
  MEDIA_INPUT_FILE_ERROR_PATTERN,
} from "../../../consts/aiChat/media";

/** 从供应商错误对象读取数值 HTTP 状态码；非数值时返回 undefined。 */
export function numericErrorStatus(error: unknown): number | undefined {
  const candidate: { readonly status?: unknown } = error as { readonly status?: unknown };
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

/** 判断状态码是否表示当前配置的 API 路径或模型不可调用。 */
function isEndpointMisconfiguredError(status: number | undefined): boolean {
  return status === 404 || status === 405;
}

/** 判断状态码是否表示网络、超时、限流或服务端故障等端点级异常。 */
function isEndpointFailureStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * 判断媒体请求错误是否明确表示模型不支持该输入模态（排除单份文件格式或损坏错误）。
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

/** 各模型客户端共用的非端点故障失败结果。 */
export interface ProviderApiFailureResult {
  readonly ok: false;
  readonly failureKind: Exclude<ProviderApiFailureKind, "endpointFailure">;
}

/**
 * 将非端点故障的归因档位映射为客户端失败结果；endpointFailure 返回 undefined 交由调用方记日志兜底。
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
