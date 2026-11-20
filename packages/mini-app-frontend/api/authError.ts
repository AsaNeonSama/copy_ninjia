import {
  MINI_APP_ACCESS_DENIED_ERROR_CODES,
  MINI_APP_EMBEDDED_AUTH_PREFIX_PATTERN,
  MINI_APP_LEADING_AUTH_PREFIX_PATTERN,
  MINI_APP_SESSION_REAUTH_ERROR_CODES,
} from "../consts/miniApp/auth";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionToken,
} from "../libs/credentials";
import { asPayloadRecord } from "../libs/record";

/** Mini App 鉴权失效、会话密钥吊销或门禁拒绝对应的重定向动作分类。 */
export type MiniAppAuthErrorAction = "reauth" | "accessDenied";

/**
 * 合并两个门禁动作判定结果：`"accessDenied"` 优先级高于 `"reauth"`，二者均优先于 `null`。
 *
 * @param current 当前已判定的动作
 * @param candidate 新的候选动作
 * @returns 优先级更高的门禁动作
 */
function mergeMiniAppAuthErrorAction(
  current: MiniAppAuthErrorAction | null,
  candidate: MiniAppAuthErrorAction | null
): MiniAppAuthErrorAction | null {
  if (current === "accessDenied" || candidate === "accessDenied") {
    return "accessDenied";
  }
  return current ?? candidate;
}

/**
 * 判定单个规范化错误代码是否命中会话重认证或门禁拒绝集合。
 *
 * @param code 待检查的错误代码文本
 * @returns 命中的门禁动作；非鉴权/会话失效代码时返回 `null`
 */
function classifyMiniAppAuthCode(code: string): MiniAppAuthErrorAction | null {
  const normalized: string = code.trim();
  if (normalized.length === 0) return null;
  if (MINI_APP_ACCESS_DENIED_ERROR_CODES.has(normalized)) {
    return "accessDenied";
  }
  if (MINI_APP_SESSION_REAUTH_ERROR_CODES.has(normalized)) {
    return "reauth";
  }
  return null;
}

/**
 * 从载荷对象的 `code` 与 `error` 字段中识别最高优先级的门禁动作；非对象输入直接返回 `null`。
 *
 * @param value 未知载荷或错误 `cause`
 * @returns 命中的门禁动作；未命中时返回 `null`
 */
function classifyMiniAppAuthRecordValue(
  value: unknown
): MiniAppAuthErrorAction | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record: Record<string, unknown> = asPayloadRecord(value);
  let action: MiniAppAuthErrorAction | null = null;
  if (typeof record.code === "string") {
    action = mergeMiniAppAuthErrorAction(action, classifyMiniAppAuthCode(record.code));
  }
  if (action !== "accessDenied" && typeof record.error === "string") {
    action = mergeMiniAppAuthErrorAction(action, classifyMiniAppAuthCode(record.error));
  }
  return action;
}

/**
 * 判定错误消息文本是否命中 `[CODE] ...` 前缀、裸错误码或内嵌 `[CODE]` 标记，并返回最高优先级门禁动作。
 *
 * @param message 错误消息文本
 * @returns 命中的门禁重定向动作；普通业务或网络错误返回 `null`
 */
function classifyMiniAppAuthErrorMessage(
  message: string
): MiniAppAuthErrorAction | null {
  const trimmed: string = message.trim();
  if (trimmed.length === 0) return null;
  let action: MiniAppAuthErrorAction | null = classifyMiniAppAuthCode(trimmed);
  if (action === "accessDenied" || !trimmed.includes("[")) {
    return action;
  }
  const leadingMatch: RegExpExecArray | null =
    MINI_APP_LEADING_AUTH_PREFIX_PATTERN.exec(trimmed);
  if (leadingMatch !== null) {
    action = mergeMiniAppAuthErrorAction(
      action,
      classifyMiniAppAuthCode(leadingMatch[1] ?? "")
    );
    action = mergeMiniAppAuthErrorAction(
      action,
      classifyMiniAppAuthCode(leadingMatch[2] ?? "")
    );
    if (action === "accessDenied") return action;
  }
  for (const match of trimmed.matchAll(MINI_APP_EMBEDDED_AUTH_PREFIX_PATTERN)) {
    action = mergeMiniAppAuthErrorAction(
      action,
      classifyMiniAppAuthCode(match[1] ?? "")
    );
    if (action === "accessDenied") break;
  }
  return action;
}

/**
 * 仅当未提供 `sentSessionToken` 或本地当前活跃会话令牌仍等于发包时刻令牌时清除本地会话凭据，
 * 防止令牌滑动轮换后旧在途请求的失效响应误擦除更新一代的会话。
 *
 * @param sentSessionToken 发出请求时刻携带的会话令牌（可选）
 */
export function clearLocalMiniAppSessionIfMatching(
  sentSessionToken?: string
): void {
  if (
    sentSessionToken === undefined ||
    readMiniAppSessionToken() === sentSessionToken
  ) {
    clearMiniAppSessionToken();
  }
}

/**
 * 综合错误消息与附带元数据（`Error` 及其 `cause`、响应对象字典）判定门禁重定向动作，
 * 使带前缀文案、裸错误码以及透传原始异常或响应对象的已本地化提示都能准确触发重定向。
 *
 * @param message 错误消息文本
 * @param metaSource 可选原始异常或响应载荷对象
 * @returns 命中的门禁重定向动作；普通业务或网络错误返回 `null`
 */
export function classifyMiniAppAuthError(
  message: string,
  metaSource?: unknown
): MiniAppAuthErrorAction | null {
  let action: MiniAppAuthErrorAction | null =
    classifyMiniAppAuthErrorMessage(message);
  if (action === "accessDenied" || metaSource === undefined || metaSource === null) {
    return action;
  }
  if (metaSource instanceof Error) {
    action = mergeMiniAppAuthErrorAction(
      action,
      classifyMiniAppAuthErrorMessage(metaSource.message)
    );
    if (action === "accessDenied") return action;
    const cause: unknown = metaSource.cause;
    if (cause instanceof Error) {
      action = mergeMiniAppAuthErrorAction(
        action,
        classifyMiniAppAuthErrorMessage(cause.message)
      );
      if (action === "accessDenied") return action;
      return mergeMiniAppAuthErrorAction(
        action,
        classifyMiniAppAuthRecordValue(cause.cause)
      );
    }
    return mergeMiniAppAuthErrorAction(
      action,
      classifyMiniAppAuthRecordValue(cause)
    );
  }
  return mergeMiniAppAuthErrorAction(
    action,
    classifyMiniAppAuthRecordValue(metaSource)
  );
}

/**
 * 核对服务端错误响应记录中的鉴权、会话过期与加密载荷失效状态码（同时检查 `code` 与 `error` 字段），并返回 `"[<状态码>] "` 前缀：
 * - 命中 `MINI_APP_ACCESS_DENIED_ERROR_CODES`（如 `PASSWORD_LOCKED`、`EXPIRED_AUTH_DATE`、`FORBIDDEN_USER`、`INVALID_SIGNATURE`、`MISSING_INIT_DATA`）：
 *   无论请求期间会话是否轮换，立即清除本地会话令牌与会话密钥，返回 `"[<命中码>] "`；
 * - 命中 `MINI_APP_SESSION_REAUTH_ERROR_CODES`（如 `PASSWORD_REQUIRED`、`SESSION_EXPIRED`、`INVALID_ENCRYPTED_PAYLOAD`、`INVALID_HANDSHAKE`）：
 *   若提供 `sentSessionToken`，仅当本地当前会话令牌仍等于发出请求时的 `sentSessionToken` 时清除本地凭据，返回 `"[PASSWORD_REQUIRED] "`。
 *
 * @param record 服务端响应 JSON 解析出的字典
 * @param sentSessionToken 发出本次请求时刻携带的会话令牌（可选；缺省按无令牌对比语义直接清理）
 * @returns 鉴权失败前缀或空字符串
 */
function consumeMiniAppAuthErrorPrefix(
  record: Readonly<Record<string, unknown>>,
  sentSessionToken?: string
): string {
  const code: string = typeof record.code === "string" ? record.code.trim() : "";
  const errorCode: string =
    typeof record.error === "string" ? record.error.trim() : "";
  if (MINI_APP_ACCESS_DENIED_ERROR_CODES.has(code)) {
    clearMiniAppSessionToken();
    return `[${code}] `;
  }
  if (MINI_APP_ACCESS_DENIED_ERROR_CODES.has(errorCode)) {
    clearMiniAppSessionToken();
    return `[${errorCode}] `;
  }
  if (
    MINI_APP_SESSION_REAUTH_ERROR_CODES.has(code) ||
    MINI_APP_SESSION_REAUTH_ERROR_CODES.has(errorCode)
  ) {
    clearLocalMiniAppSessionIfMatching(sentSessionToken);
    return "[PASSWORD_REQUIRED] ";
  }
  return "";
}

/**
 * 从非 2xx 响应解析的 JSON 记录提取错误文案并消费鉴权失效、密钥吊销或锁定状态码后抛出带 `cause` 的 `Error`；
 * 未携带已知状态码但 HTTP 状态为 `401` 时同样按令牌一致性清除本地会话并附加 `[PASSWORD_REQUIRED] ` 前缀。
 *
 * @param payload 响应体解析出的未知 JSON 值
 * @param status 响应无错误信息时兜底写入的 HTTP 状态码
 * @param sentSessionToken 发出请求时刻携带的会话令牌（可选；透传至 `consumeMiniAppAuthErrorPrefix` 防止旧令牌 401 误清已轮换的新会话）
 */
export function throwMiniAppRecordError(
  payload: unknown,
  status: number,
  sentSessionToken?: string
): never {
  const record: Record<string, unknown> = asPayloadRecord(payload);
  let prefix: string = consumeMiniAppAuthErrorPrefix(
    record,
    sentSessionToken
  );
  if (prefix.length === 0 && status === 401) {
    clearLocalMiniAppSessionIfMatching(sentSessionToken);
    prefix = "[PASSWORD_REQUIRED] ";
  }
  const errorText: string =
    typeof record.error === "string"
      ? record.error
      : typeof record.message === "string"
        ? record.message
        : typeof record.code === "string"
          ? record.code
          : `HTTP ${String(status)}`;
  throw new Error(`${prefix}${errorText}`, { cause: record });
}
