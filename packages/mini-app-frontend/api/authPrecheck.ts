import {
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../consts/miniApp";
import {
  clearMiniAppAssetToken,
  clearMiniAppSessionToken,
  readMiniAppSessionToken,
  setMiniAppAssetToken,
  setMiniAppSessionToken,
} from "../libs/credentials";
import { asPayloadRecord } from "../libs/record";
import type {
  MiniAppAccessDiagnostics,
  MiniAppAuthPrecheckResponse,
  MiniAppPrecheckResult,
} from "../types/miniApp";
import type { MiniAppAuthMode } from "../types/miniAppTotp";
import {
  buildMiniAppAuthHeaders,
  syncRefreshedMiniAppSession,
  toLocalEpochMs,
} from "./request";

/**
 * 从后端 401/403 JSON 载荷与响应头提取真实访问诊断元数据。
 * @param payload 响应 JSON 对象
 * @param response 原始 `Response`
 * @param fallbackError 兜底错误说明
 * @returns 归一化后的真实访问诊断对象
 */
function parseAccessDiagnostics(
  payload: unknown, response: Response, fallbackError: string
): Readonly<MiniAppAccessDiagnostics> {
  const record: Record<string, unknown> = asPayloadRecord(payload);
  const str = (key: string, fallback: string): string => {
    const val: unknown = record[key];
    return typeof val === "string" && val.length > 0 ? val : fallback;
  };
  return {
    requestId: str("requestId", response.headers.get("x-request-id") ?? "0000000000000000"),
    timestamp: str("timestamp", `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`),
    clientIp: str("clientIp", "127.0.0.1"),
    host: str("host", "localhost"),
    path: str("path", "/api/auth/precheck"),
    status: typeof record.status === "number" ? record.status : response.status,
    code: str("code", `HTTP_${response.status}`),
    error: str("error", fallbackError),
    ...(typeof record.remainingAttempts === "number"
      ? { remainingAttempts: record.remainingAttempts }
      : {}),
    ...(typeof record.remainingMinutes === "number"
      ? { remainingMinutes: record.remainingMinutes }
      : {}),
  };
}

/**
 * 调用 `GET ./api/auth/precheck` 核验当前客户端是否持有合法的 SuperAdmin `initData` 签名，并验证持久化的 45 分钟会话凭据是否仍有效；
 * 服务端给出的会话到期时刻经 `toLocalEpochMs` 换算为本机时刻后再判定与保存。
 * 本函数是预检路径上本地会话与资源令牌的唯一同步方：会话有效时保存令牌；预检失败或会话无效时，仅当本地令牌仍是发出请求时的那一枚
 * （或已为空）才清除，请求在途期间另行写入的新令牌保持不动。
 * @returns 预检结果
 */
export async function precheckMiniAppAccess(): Promise<MiniAppPrecheckResult> {
  const sentSessionToken: string = readMiniAppSessionToken();
  const response: Response = await fetch("./api/auth/precheck", {
    method: "GET", headers: buildMiniAppAuthHeaders(true),
  });
  syncRefreshedMiniAppSession(response);
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok || payload === null) {
    if (readMiniAppSessionToken() === sentSessionToken) {
      clearMiniAppSessionToken();
    }
    return {
      ok: false,
      diagnostics: parseAccessDiagnostics(
        payload,
        response,
        response.ok ? "INVALID_RESPONSE" : "MISSING_INIT_DATA"
      ),
    };
  }
  const body: MiniAppAuthPrecheckResponse = payload as MiniAppAuthPrecheckResponse;
  const ttlMs: number = body.ttlMs ?? MINI_APP_SESSION_TTL_MS;
  const totpEnabled: boolean = body.totpEnabled === true;
  const authMode: MiniAppAuthMode =
    body.authMode === "totp" || totpEnabled ? "totp" : "password";
  const rawRefreshedToken: string = body.sessionToken?.trim() ?? "";
  const refreshedBodyToken: string =
    MINI_APP_SHA256_HEX_PATTERN.test(rawRefreshedToken) ? rawRefreshedToken : "";
  const existingToken: string =
    refreshedBodyToken.length > 0
      ? refreshedBodyToken
      : (readMiniAppSessionToken() || sentSessionToken);
  const localSessionExpiresAt: number =
    body.sessionExpiresAt !== undefined
      ? toLocalEpochMs(body.sessionExpiresAt, response)
      : 0;
  const sessionValid: boolean =
    body.sessionValid === true &&
    localSessionExpiresAt > Date.now() &&
    existingToken.length > 0;
  const sessionExpiresAt: number = sessionValid ? localSessionExpiresAt : 0;
  const assetToken: string | undefined =
    sessionValid && body.assetToken !== undefined && body.assetToken.length > 0
      ? body.assetToken
      : undefined;
  if (assetToken !== undefined) {
    setMiniAppAssetToken(assetToken);
  }
  if (sessionValid) {
    setMiniAppSessionToken(existingToken, sessionExpiresAt);
  } else if (
    readMiniAppSessionToken() === sentSessionToken ||
    readMiniAppSessionToken() === ""
  ) {
    if (existingToken.length > 0) {
      clearMiniAppSessionToken();
    } else {
      clearMiniAppAssetToken();
    }
  }
  return {
    ok: true, ttlMs, totpEnabled, authMode,
    ...(assetToken === undefined ? {} : { assetToken }),
    ...(sessionValid ? { sessionValid: true, sessionExpiresAt } : {}),
  };
}
