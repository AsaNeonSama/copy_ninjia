import { BOT_DEPARTED_DESCRIPTION_PATTERN, CHAT_GONE_DESCRIPTION_PATTERN } from "../../consts/telegram";
import type { ChatDepartureReason } from "../../types/chatTeardown";

/**
 * 破坏性 Telegram 请求命中限流退避后，重试前现查发现原前置条件已失效。
 * name 会穿过 Worker 双工错误线协议，业务动作据此把它归一化成「目标已离群」。
 */
export class TelegramRetryPreconditionChangedError extends Error {
  /** 构造破坏性重试前置条件已变更错误。 */
  constructor() {
    super("Telegram destructive retry precondition changed.");
    this.name = "TelegramRetryPreconditionChangedError";
  }
}

/**
 * 主线程原始错误与 Worker 重建错误共用的前置条件失效判定。
 * @param error 待判定的异常值。
 * @returns 为前置条件失效错误时返回 true，否则返回 false。
 */
export function isTelegramRetryPreconditionChanged(error: unknown): boolean {
  return error instanceof Error &&
    error.name === "TelegramRetryPreconditionChangedError";
}

/**
 * 主线程 GrammyError 与 Worker 双工错误共用的安全 Telegram 诊断字段。
 * @param error 待提取的异常值。
 * @returns 提取到的 Telegram 错误码与描述；非 Telegram API 错误时返回 undefined。
 */
export function telegramErrorDetails(
  error: unknown
): Readonly<{ errorCode: number; description: string }> | undefined {
  if (
    error instanceof Error &&
    "error_code" in error &&
    typeof error.error_code === "number" &&
    "description" in error &&
    typeof error.description === "string"
  ) {
    return { errorCode: error.error_code, description: error.description };
  }
  if (
    error instanceof Error &&
    "telegramErrorCode" in error &&
    typeof error.telegramErrorCode === "number" &&
    "telegramDescription" in error &&
    typeof error.telegramDescription === "string"
  ) {
    return {
      errorCode: error.telegramErrorCode,
      description: error.telegramDescription,
    };
  }
  return undefined;
}

/**
 * Bot API 以客户端错误状态码明确拒收了这次请求，请求没有生效。
 * 网络失败、服务端错误与本地错误不算：请求可能已经送达并生效。
 * @param error 待判定的异常值。
 * @returns 为 4xx 客户端拒绝错误时返回 true，否则返回 false。
 */
export function isTelegramRequestRejected(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  return details !== undefined && details.errorCode >= 400 && details.errorCode < 500;
}

/**
 * 把 getChat 的失败归为确证的「群不可达」：带 `parameters.migrate_to_chat_id` 或描述匹配
 * CHAT_GONE_DESCRIPTION_PATTERN 为 `gone`（群已不存在）；权限拒绝且描述匹配 BOT_DEPARTED_DESCRIPTION_PATTERN
 * 为 `departed`（机器人已不是成员）。其余错误不下结论，返回 null。
 * @param error getChat 抛出的异常值。
 * @returns 确证群已不存在返回 "gone"，机器人已离群返回 "departed"，其余错误返回 null。
 */
export function classifyChatAbsence(error: unknown): ChatDepartureReason | null {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details === undefined) return null;
  if (details.errorCode === 400) {
    if (hasMigrationTarget(error) || CHAT_GONE_DESCRIPTION_PATTERN.test(details.description)) return "gone";
    return null;
  }
  if (details.errorCode === 403 && BOT_DEPARTED_DESCRIPTION_PATTERN.test(details.description)) return "departed";
  return null;
}

/**
 * GrammyError 的 parameters 里是否带群迁移目标。
 * @param error 待检查的异常值。
 * @returns 含数字型 migrate_to_chat_id 参数时返回 true，否则返回 false。
 */
function hasMigrationTarget(error: unknown): boolean {
  if (!(error instanceof Error) || !("parameters" in error)) return false;
  const parameters: unknown = error.parameters;
  return typeof parameters === "object" &&
    parameters !== null &&
    "migrate_to_chat_id" in parameters &&
    typeof parameters.migrate_to_chat_id === "number";
}
