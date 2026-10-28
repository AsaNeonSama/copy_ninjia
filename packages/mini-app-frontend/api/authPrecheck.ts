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
import type { MiniAppAccessDiagnostics, MiniAppPrecheckResult } from "../types/miniApp";
import type { MiniAppAuthMode } from "../types/miniAppTotp";
import { buildMiniAppAuthHeaders, syncRefreshedMiniAppSession } from "./request";

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
 * 调用 `GET ./api/auth/precheck` 核验当前客户端是否持有合法的 SuperAdmin `initData` 签名，并验证持久化的 45 分钟会话凭据是否仍有效。
 * @returns 预检结果
 */
export async function precheckMiniAppAccess(): Promise<MiniAppPrecheckResult> {
  const response: Response = await fetch("./api/auth/precheck", {
    method: "GET", headers: buildMiniAppAuthHeaders(true),
  });
  syncRefreshedMiniAppSession(response);
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    clearMiniAppAssetToken();
    clearMiniAppSessionToken();
    return {
      ok: false,
      diagnostics: parseAccessDiagnostics(
        payload,
        response,
        "MISSING_INIT_DATA"
      ),
    };
  }
  const record: Record<string, unknown> = asPayloadRecord(payload);
  const ttlMs: number = typeof record.ttlMs === "number" ? record.ttlMs : MINI_APP_SESSION_TTL_MS;
  const totpEnabled: boolean = record.totpEnabled === true;
  const authMode: MiniAppAuthMode =
    record.authMode === "totp" || totpEnabled ? "totp" : "password";
  const refreshedBodyToken: string =
    typeof record.sessionToken === "string" &&
    MINI_APP_SHA256_HEX_PATTERN.test(record.sessionToken.trim())
      ? record.sessionToken.trim()
      : "";
  const existingToken: string =
    refreshedBodyToken.length > 0 ? refreshedBodyToken : readMiniAppSessionToken();
  const sessionValid: boolean =
    record.sessionValid === true &&
    typeof record.sessionExpiresAt === "number" &&
    record.sessionExpiresAt > Date.now() &&
    existingToken.length > 0;
  const sessionExpiresAt: number =
    sessionValid && typeof record.sessionExpiresAt === "number"
      ? record.sessionExpiresAt
      : 0;
  const assetToken: string | undefined =
    sessionValid && typeof record.assetToken === "string" && record.assetToken.length > 0
      ? record.assetToken
      : undefined;
  if (assetToken !== undefined) {
    setMiniAppAssetToken(assetToken);
  }
  if (sessionValid) {
    setMiniAppSessionToken(existingToken, sessionExpiresAt);
  } else {
    clearMiniAppAssetToken();
    if (existingToken.length > 0) {
      clearMiniAppSessionToken();
    }
  }
  return {
    ok: true, ttlMs, totpEnabled, authMode,
    ...(assetToken === undefined ? {} : { assetToken }),
    ...(sessionValid ? { sessionValid: true, sessionExpiresAt } : {}),
  };
}
