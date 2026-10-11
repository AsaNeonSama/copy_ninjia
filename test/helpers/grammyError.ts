import { GrammyError } from "grammy";

/** Bot API 以 errorCode 与 description 拒绝一次请求时 grammY 抛出的错误；parameters 原样放进响应体。 */
export function grammyApiError(
  errorCode: number,
  description: string,
  parameters?: Record<string, unknown>
): GrammyError {
  return new GrammyError("request failed", {
    ok: false,
    error_code: errorCode,
    description,
    ...(parameters === undefined ? {} : { parameters }),
  }, "getChat", {});
}
