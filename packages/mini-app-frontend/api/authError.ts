import {
  MINI_APP_ACCESS_DENIED_ERROR_CODES,
  MINI_APP_EMBEDDED_AUTH_PREFIX_PATTERN,
  MINI_APP_EXPIRED_AUTH_DATE_CODE,
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
 * 在内部细分鉴权归类优先级：无条件一层拒绝（`"accessDenied"`）高于依赖活跃会话延展窗口的
 * `EXPIRED_AUTH_DATE`（`"expiredAuthDate"`），二者均高于会话重认证（`"reauth"`）与 `null`。
 */
type InternalMiniAppAuthErrorAction =
  | "accessDenied"
  | "expiredAuthDate"
  | "reauth";

/** 在 `Error` 实例上保存发包时刻会话令牌的私有 Symbol（不可枚举，绝不进入 `cause` 或序列化结果）。 */
const MINI_APP_AUTH_ERROR_SENT_SESSION_TOKEN: unique symbol = Symbol(
  "miniAppAuthErrorSentSessionToken"
);

/** 附带发包时刻会话令牌私有标记的内部异常形态。 */
interface TaggedMiniAppAuthError extends Error {
  [MINI_APP_AUTH_ERROR_SENT_SESSION_TOKEN]?: string;
}

/**
 * 判断发包时刻携带的会话令牌是否已被本地更新一代的活跃会话令牌取代。
 *
 * @param sentSessionToken 发出请求时刻携带的会话令牌（可选）
 * @returns 存在非空当前活跃令牌且与 `sentSessionToken` 不同时返回 `true`
 */
export function isStaleMiniAppSessionToken(
  sentSessionToken?: string
): boolean {
  if (sentSessionToken === undefined || sentSessionToken.length === 0) {
    return false;
  }
  const currentToken: string = readMiniAppSessionToken();
  return currentToken.length > 0 && currentToken !== sentSessionToken;
}

/**
 * 构造可附带发包时刻会话令牌上下文的鉴权异常，使全局通知层与调用方能识别已被新会话取代的滞后旧令牌错误。
 *
 * @param message 异常消息文本
 * @param cause 可选原始载荷或底层异常
 * @param sentSessionToken 发出请求时刻携带的会话令牌（可选）
 * @returns 带私有令牌上下文标记的 `Error` 实例
 */
export function createMiniAppAuthError(
  message: string,
  cause?: unknown,
  sentSessionToken?: string
): Error {
  const error: TaggedMiniAppAuthError =
    cause !== undefined ? new Error(message, { cause }) : new Error(message);
  if (sentSessionToken !== undefined && sentSessionToken.length > 0) {
    error[MINI_APP_AUTH_ERROR_SENT_SESSION_TOKEN] = sentSessionToken;
  }
  return error;
}

/**
 * 从异常对象或其单层 `cause` 异常中提取发包时刻附带的会话令牌标记。
 *
 * @param metaSource 未知异常或响应载荷对象
 * @returns 发包时刻的会话令牌；未附带或非异常对象时返回 `undefined`
 */
function readMiniAppAuthErrorSentSessionToken(
  metaSource?: unknown
): string | undefined {
  if (!(metaSource instanceof Error)) {
    return undefined;
  }
  const direct: string | undefined = (
    metaSource as TaggedMiniAppAuthError
  )[MINI_APP_AUTH_ERROR_SENT_SESSION_TOKEN];
  if (direct !== undefined) {
    return direct;
  }
  if (metaSource.cause instanceof Error) {
    return (metaSource.cause as TaggedMiniAppAuthError)[
      MINI_APP_AUTH_ERROR_SENT_SESSION_TOKEN
    ];
  }
  return undefined;
}

/**
 * 合并两个内部门禁动作判定结果：`"accessDenied"` > `"expiredAuthDate"` > `"reauth"` > `null`。
 *
 * @param current 当前已判定的内部动作
 * @param candidate 新的候选内部动作
 * @returns 优先级更高的内部门禁动作
 */
function mergeMiniAppAuthErrorAction(
  current: InternalMiniAppAuthErrorAction | null,
  candidate: InternalMiniAppAuthErrorAction | null
): InternalMiniAppAuthErrorAction | null {
  if (current === "accessDenied" || candidate === "accessDenied") {
    return "accessDenied";
  }
  if (current === "expiredAuthDate" || candidate === "expiredAuthDate") {
    return "expiredAuthDate";
  }
  return current ?? candidate;
}

/**
 * 判定单个规范化错误代码是否命中无条件门禁拒绝、会话延展期 `EXPIRED_AUTH_DATE` 或会话重认证集合。
 *
 * @param code 待检查的错误代码文本
 * @returns 命中的内部门禁动作；非鉴权/会话失效代码时返回 `null`
 */
function classifyMiniAppAuthCode(
  code: string
): InternalMiniAppAuthErrorAction | null {
  const normalized: string = code.trim();
  if (normalized.length === 0) return null;
  if (normalized === MINI_APP_EXPIRED_AUTH_DATE_CODE) {
    return "expiredAuthDate";
  }
  if (MINI_APP_ACCESS_DENIED_ERROR_CODES.has(normalized)) {
    return "accessDenied";
  }
  if (MINI_APP_SESSION_REAUTH_ERROR_CODES.has(normalized)) {
    return "reauth";
  }
  return null;
}

/**
 * 从载荷对象的 `code` 与 `error` 字段中识别最高优先级的内部门禁动作；非对象输入直接返回 `null`。
 *
 * @param value 未知载荷或错误 `cause`
 * @returns 命中的内部门禁动作；未命中时返回 `null`
 */
function classifyMiniAppAuthRecordValue(
  value: unknown
): InternalMiniAppAuthErrorAction | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record: Record<string, unknown> = asPayloadRecord(value);
  let action: InternalMiniAppAuthErrorAction | null = null;
  if (typeof record.code === "string") {
    action = mergeMiniAppAuthErrorAction(action, classifyMiniAppAuthCode(record.code));
  }
  if (action !== "accessDenied" && typeof record.error === "string") {
    action = mergeMiniAppAuthErrorAction(action, classifyMiniAppAuthCode(record.error));
  }
  return action;
}

/**
 * 判定错误消息文本是否命中 `[CODE] ...` 前缀、裸错误码或内嵌 `[CODE]` 标记，并返回最高优先级内部门禁动作。
 *
 * @param message 错误消息文本
 * @returns 命中的内部门禁重定向动作；普通业务或网络错误返回 `null`
 */
function classifyMiniAppAuthErrorMessage(
  message: string
): InternalMiniAppAuthErrorAction | null {
  const trimmed: string = message.trim();
  if (trimmed.length === 0) return null;
  let action: InternalMiniAppAuthErrorAction | null = classifyMiniAppAuthCode(trimmed);
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
 * 综合错误消息与附带元数据（`Error` 及其 `cause`、响应对象字典）解析原始内部门禁动作（尚未应用旧令牌抑制）。
 *
 * @param message 错误消息文本
 * @param metaSource 可选原始异常或响应载荷对象
 * @returns 命中的原始内部门禁动作；普通业务或网络错误返回 `null`
 */
function resolveInternalMiniAppAuthErrorAction(
  message: string,
  metaSource?: unknown
): InternalMiniAppAuthErrorAction | null {
  let action: InternalMiniAppAuthErrorAction | null =
    classifyMiniAppAuthErrorMessage(message);
  if (action !== "accessDenied" && metaSource !== undefined && metaSource !== null) {
    if (metaSource instanceof Error) {
      action = mergeMiniAppAuthErrorAction(
        action,
        classifyMiniAppAuthErrorMessage(metaSource.message)
      );
      if (action !== "accessDenied") {
        const cause: unknown = metaSource.cause;
        if (cause instanceof Error) {
          action = mergeMiniAppAuthErrorAction(
            action,
            classifyMiniAppAuthErrorMessage(cause.message)
          );
          if (action !== "accessDenied") {
            action = mergeMiniAppAuthErrorAction(
              action,
              classifyMiniAppAuthRecordValue(cause.cause)
            );
          }
        } else {
          action = mergeMiniAppAuthErrorAction(
            action,
            classifyMiniAppAuthRecordValue(cause)
          );
        }
      }
    } else {
      action = mergeMiniAppAuthErrorAction(
        action,
        classifyMiniAppAuthRecordValue(metaSource)
      );
    }
  }
  return action;
}

/**
 * 综合错误消息与附带元数据（`Error` 及其 `cause`、响应对象字典）判定门禁重定向动作，
 * 使带前缀文案、裸错误码以及透传原始异常或响应对象的已本地化提示都能准确触发重定向；
 * 若异常带有发包时刻会话令牌且本地已轮换或重新登录至更新一代活跃令牌，则抑制会话重认证与依赖会话延展窗口的
 * `EXPIRED_AUTH_DATE` 重定向（无条件一层门禁拒绝如 `PASSWORD_LOCKED`、`FORBIDDEN_USER` 仍立即生效）。
 *
 * @param message 错误消息文本
 * @param metaSource 可选原始异常或响应载荷对象
 * @returns 命中的门禁重定向动作；普通业务、网络错误或已被新会话取代的旧令牌鉴权失败返回 `null`
 */
export function classifyMiniAppAuthError(
  message: string,
  metaSource?: unknown
): MiniAppAuthErrorAction | null {
  const action: InternalMiniAppAuthErrorAction | null =
    resolveInternalMiniAppAuthErrorAction(message, metaSource);
  if (action === null) {
    return null;
  }
  if (action === "accessDenied") {
    return "accessDenied";
  }
  const sentSessionToken: string | undefined =
    readMiniAppAuthErrorSentSessionToken(metaSource);
  if (isStaleMiniAppSessionToken(sentSessionToken)) {
    return null;
  }
  return action === "expiredAuthDate" ? "accessDenied" : "reauth";
}

/**
 * 判断错误是否属于已被本地更新一代活跃会话取代的滞后旧令牌鉴权错误（即本应触发 `reauth` 或 `EXPIRED_AUTH_DATE`，
 * 但因发包令牌已过时而被抑制重定向）；无条件一层门禁拒绝、当前活跃会话鉴权失败与普通业务/网络错误均返回 `false`。
 * 供全局通知与配置错误横幅抑制在活跃会话上弹出误导性的「会话已过期」提示。
 *
 * @param message 错误消息文本
 * @param metaSource 可选原始异常或响应载荷对象
 * @returns 命中被抑制的旧令牌鉴权错误时返回 `true`，否则返回 `false`
 */
export function isSuppressedStaleMiniAppAuthError(
  message: string,
  metaSource?: unknown
): boolean {
  const action: InternalMiniAppAuthErrorAction | null =
    resolveInternalMiniAppAuthErrorAction(message, metaSource);
  if (action !== "reauth" && action !== "expiredAuthDate") {
    return false;
  }
  const sentSessionToken: string | undefined =
    readMiniAppAuthErrorSentSessionToken(metaSource);
  return isStaleMiniAppSessionToken(sentSessionToken);
}

/**
 * 核对服务端错误响应记录中的鉴权、会话过期与加密载荷失效状态码（同时检查 `code` 与 `error` 字段），并返回 `"[<状态码>] "` 前缀：
 * - 命中非会话依赖的一层门禁拒绝（如 `PASSWORD_LOCKED`、`FORBIDDEN_USER`、`INVALID_SIGNATURE`、`MISSING_INIT_DATA`）：
 *   无论请求期间会话是否轮换，立即清除本地会话令牌与会话密钥，返回 `"[<命中码>] "`；
 * - 命中 `EXPIRED_AUTH_DATE`（服务端按活跃会话延展 `auth_date` 窗口）：
 *   仅当未提供 `sentSessionToken` 或本地当前会话令牌仍等于 `sentSessionToken` 时清除本地凭据，返回 `"[EXPIRED_AUTH_DATE] "`；
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
  if (
    code !== MINI_APP_EXPIRED_AUTH_DATE_CODE &&
    MINI_APP_ACCESS_DENIED_ERROR_CODES.has(code)
  ) {
    clearMiniAppSessionToken();
    return `[${code}] `;
  }
  if (
    errorCode !== MINI_APP_EXPIRED_AUTH_DATE_CODE &&
    MINI_APP_ACCESS_DENIED_ERROR_CODES.has(errorCode)
  ) {
    clearMiniAppSessionToken();
    return `[${errorCode}] `;
  }
  if (
    code === MINI_APP_EXPIRED_AUTH_DATE_CODE ||
    errorCode === MINI_APP_EXPIRED_AUTH_DATE_CODE
  ) {
    clearLocalMiniAppSessionIfMatching(sentSessionToken);
    return `[${MINI_APP_EXPIRED_AUTH_DATE_CODE}] `;
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
 * 从非 2xx 响应解析的 JSON 记录提取错误文案并消费鉴权失效、密钥吊销或锁定状态码后抛出带 `cause` 与发包令牌上下文的 `Error`；
 * 未携带已知状态码但 HTTP 状态为 `401` 时同样按令牌一致性清除本地会话并附加 `[PASSWORD_REQUIRED] ` 前缀。
 *
 * @param payload 响应体解析出的未知 JSON 值
 * @param status 响应无错误信息时兜底写入的 HTTP 状态码
 * @param sentSessionToken 发出请求时刻携带的会话令牌（可选；同时用于传输层防误清与向全局通知层传递发包上下文）
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
  throw createMiniAppAuthError(`${prefix}${errorText}`, record, sentSessionToken);
}
