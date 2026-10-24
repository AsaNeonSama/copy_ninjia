import { logger } from "./logger";
import {
  JSON_API_ALLOWED_ORIGINS,
  JSON_API_ERROR_LOG_MAX_CHARS,
  JSON_API_MAX_RESPONSE_BYTES,
} from "../consts/httpFetch";
import { signalWithTimeout } from "../libs/abortSignal";
import { readBoundedResponseBytes } from "../libs/boundedResponse";
import { parseAllowedHttpsUrl } from "../libs/httpUrlPolicy";
import type { BoundedResponseResult } from "../libs/boundedResponse";

/** 所有 JSON 响应共用一个非 fatal UTF-8 解码器。 */
const UTF8_DECODER: TextDecoder = new TextDecoder();

/**
 * 截断错误响应体文本至 `JSON_API_ERROR_LOG_MAX_CHARS` 字符以内供日志打印。
 * @param text 原始响应体文本。
 * @returns 未超限时返回原文，超限时返回截断后附加省略号的字符串。
 */
function boundedErrorPreview(text: string): string {
  if (text.length <= JSON_API_ERROR_LOG_MAX_CHARS) return text;
  return `${text.slice(0, JSON_API_ERROR_LOG_MAX_CHARS)}…`;
}

/** fetchJsonWithTimeout 的入参。 */
export interface FetchJsonWithTimeoutParams {
  /** 请求的完整 URL 字符串或 URL 对象。 */
  input: string | URL;
  /** fetch 请求配置项。 */
  init: RequestInit;
  /** 单次请求的超时毫秒数。 */
  timeoutMs: number;
  /** 出现在错误日志里的接口名（如「Open-Meteo API」）。 */
  errorLabel: string;
}

/**
 * 带超时和响应体上限（`JSON_API_MAX_RESPONSE_BYTES`）的 JSON API 请求：
 * 请求地址必须命中 `JSON_API_ALLOWED_ORIGINS` 且不跟随重定向；请求失败、取消、超时、超限、
 * 非法 JSON 或非成功响应时返回 null。
 * @param params JSON API 请求的地址、配置、超时与错误标签参数。
 * @returns 解析后的 JSON 值；请求失败或响应不合法时返回 null。
 */
export async function fetchJsonWithTimeout({
  input,
  init,
  timeoutMs,
  errorLabel,
}: FetchJsonWithTimeoutParams): Promise<unknown> {
  const requestUrl: URL | null = parseAllowedHttpsUrl({
    input,
    policy: { allowedOrigins: JSON_API_ALLOWED_ORIGINS },
  });
  if (requestUrl === null) {
    logger.error(`${errorLabel} request URL is not in the configured allowlist.`);
    return null;
  }
  const callerSignal: AbortSignal | undefined = init.signal ?? undefined;
  const signal: AbortSignal = signalWithTimeout(callerSignal, timeoutMs);
  try {
    signal.throwIfAborted();
    const response: Response = await fetch(requestUrl, {
      ...init,
      redirect: "error",
      signal,
    });
    const body: BoundedResponseResult = await readBoundedResponseBytes(response, JSON_API_MAX_RESPONSE_BYTES);
    signal.throwIfAborted();
    if (!body.ok) {
      logger.error(`${errorLabel} response exceeded ${JSON_API_MAX_RESPONSE_BYTES} bytes (observed ${body.observedBytes}).`);
      return null;
    }
    const text: string = UTF8_DECODER.decode(body.bytes);
    if (!response.ok) {
      logger.error(`${errorLabel} error: ${response.status} ${boundedErrorPreview(text)}`);
      return null;
    }
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (callerSignal?.aborted !== true) logger.error(`Error calling ${errorLabel}:`, error);
    return null;
  }
}
