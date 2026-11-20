import {
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY,
  MINI_APP_SIGNING_KEY_RELOAD_WINDOW_MS,
} from "../consts/miniApp";
import {
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../consts/miniAppCrypto";
import {
  clearMiniAppSessionToken,
  getMiniAppSessionCryptoKey,
  hasMiniAppSessionCryptoKey,
  hydrateMiniAppSessionFromStorage,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
  restoreMiniAppSessionCryptoKey,
  setMiniAppSessionToken,
} from "../libs/credentials";
import { formatUtcTimestamp } from "../libs/formatters";
import {
  clearPendingMiniAppAuthHandshake,
  setPendingMiniAppAuthHandshake,
  verifyMiniAppHandshakeOfferDetailed,
} from "../libs/handshakeCrypto";
import type { VerifyMiniAppHandshakeOfferResult } from "../libs/handshakeCrypto";
import { asPayloadRecord } from "../libs/record";
import type {
  MiniAppAccessDiagnostics,
  MiniAppAuthHandshakeOffer,
  MiniAppAuthPrecheckResponse,
  MiniAppPrecheckResult,
} from "../types/miniApp/auth";
import type { TelegramWindow } from "../types/miniApp/host";
import type { MiniAppAuthMode } from "../types/miniAppTotp";
import {
  buildMiniAppAuthHeaders,
  syncRefreshedMiniAppSession,
  toLocalEpochMs,
} from "./request";

/**
 * 从后端 401/403 JSON 载荷与响应头提取真实访问诊断元数据。
 *
 * @param payload 响应 JSON 对象
 * @param response 原始 `Response`
 * @param fallbackError 兜底错误说明
 * @returns 归一化后的真实访问诊断对象
 */
function parseAccessDiagnostics(
  payload: unknown,
  response: Response,
  fallbackError: string
): Readonly<MiniAppAccessDiagnostics> {
  const record: Record<string, unknown> = asPayloadRecord(payload);
  const str = (key: string, fallback: string): string => {
    const val: unknown = record[key];
    return typeof val === "string" && val.length > 0 ? val : fallback;
  };
  return {
    requestId: str(
      "requestId",
      response.headers.get("x-request-id") ?? "0000000000000000"
    ),
    timestamp: str("timestamp", formatUtcTimestamp()),
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
 * 清除 `sessionStorage` 中的签名公钥轮换防循环刷新时间戳（验签成功或会话有效时调用）。
 */
function clearSigningKeyReloadGuard(): void {
  const tgWindow: TelegramWindow = globalThis;
  try {
    tgWindow.sessionStorage?.removeItem(MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY);
  } catch (_error: unknown) {
    // 忽略受限 WebView 禁用 sessionStorage 的异常
  }
}

/**
 * 检测到服务端内存签名公钥轮换（`signatureMismatch`）时，在 10 秒防循环窗口内自动整页刷新一次以拉取最新静态 JS 中的 Ed25519 公钥。
 */
function tryReloadAfterSigningKeyRotation(): void {
  const tgWindow: TelegramWindow = globalThis;
  const storage: TelegramWindow["sessionStorage"] = tgWindow.sessionStorage;
  if (storage === undefined || typeof tgWindow.location?.reload !== "function") {
    return;
  }
  const nowMs: number = Date.now();
  let lastReloadMs: number = 0;
  try {
    const raw: string | null =
      storage.getItem(MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY) ?? null;
    if (raw !== null && raw.length > 0) {
      const parsed: number = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        lastReloadMs = parsed;
      }
    }
  } catch (_error: unknown) {
    lastReloadMs = 0;
  }
  if (lastReloadMs > 0 && nowMs - lastReloadMs < MINI_APP_SIGNING_KEY_RELOAD_WINDOW_MS) {
    return;
  }
  try {
    storage.setItem(MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY, String(nowMs));
  } catch (_error: unknown) {
    // 忽略受限 WebView 禁用 sessionStorage 的异常；无可用存储时放弃自动刷新以防死循环
    return;
  }
  tgWindow.location.reload();
}

/**
 * 调用 `GET ./api/auth/precheck` 核验 SuperAdmin `initData` 签名及本地持久化的 45 分钟会话凭据（先异步水合 `sessionStorage` + IndexedDB 不可导出 `CryptoKey`）：
 * 1. 会话有效且本地持有不可导出 `CryptoKey` 时更新到期时刻，预热 `CryptoKey`、清空待用握手与刷新防重标记；
 * 2. 尚未解锁活跃会话时清理过期本地凭据并验签 `handshake` 临时 X25519 公钥：
 *    - 命中服务端重启导致的 Ed25519 签名不匹配（`signatureMismatch`）时执行 10 秒防循环保护的 `location.reload()` 自动更新前端静态块公钥；
 *    - 检测到浏览器缺少 Web Crypto 安全上下文或不支持 `Ed25519`/`X25519` 时直接返回 `WEBCRYPTO_UNSUPPORTED`（不触发刷新循环）；
 * 3. 预检请求失败时清空待用登录握手并按令牌一致性清理本地会话。
 *
 * @returns 预检结果
 */
export async function precheckMiniAppAccess(): Promise<MiniAppPrecheckResult> {
  await hydrateMiniAppSessionFromStorage();
  const sentSessionToken: string = readMiniAppSessionToken();
  const sentCryptoKey: CryptoKey | null =
    sentSessionToken.length > 0 ? await getMiniAppSessionCryptoKey() : null;
  const hadKeyAtSend: boolean = sentCryptoKey !== null;
  const response: Response = await fetch("./api/auth/precheck", {
    method: "GET",
    headers: buildMiniAppAuthHeaders(true, undefined, sentSessionToken),
  });
  syncRefreshedMiniAppSession(response);
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok || payload === null) {
    clearPendingMiniAppAuthHandshake();
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
  const currentToken: string = readMiniAppSessionToken();
  const currentHasKey: boolean = hasMiniAppSessionCryptoKey();
  const supersededByNewerSession: boolean =
    currentToken.length > 0 &&
    currentHasKey &&
    currentToken !== sentSessionToken;
  const existingToken: string = currentToken || sentSessionToken;
  const existingHasKey: boolean =
    currentToken.length > 0 ? currentHasKey : hadKeyAtSend;
  const serverSessionLocalExpiresAt: number =
    body.sessionExpiresAt !== undefined
      ? toLocalEpochMs(body.sessionExpiresAt, response)
      : 0;
  const sessionValid: boolean =
    body.sessionValid === true &&
    serverSessionLocalExpiresAt > Date.now() &&
    existingToken.length > 0 &&
    existingHasKey;
  const sessionExpiresAt: number = sessionValid
    ? supersededByNewerSession
      ? Math.max(readMiniAppSessionExpiresAt(), serverSessionLocalExpiresAt)
      : serverSessionLocalExpiresAt
    : 0;

  if (sessionValid && !supersededByNewerSession) {
    if (currentToken === existingToken) {
      setMiniAppSessionToken(existingToken, sessionExpiresAt);
    } else if (sentCryptoKey !== null) {
      restoreMiniAppSessionCryptoKey(
        existingToken,
        sessionExpiresAt,
        sentCryptoKey
      );
    }
    clearPendingMiniAppAuthHandshake();
    clearSigningKeyReloadGuard();
    await getMiniAppSessionCryptoKey();
  } else if (sessionValid) {
    clearPendingMiniAppAuthHandshake();
    clearSigningKeyReloadGuard();
  } else {
    if (
      (currentToken === sentSessionToken || currentToken === "") &&
      existingToken.length > 0
    ) {
      clearMiniAppSessionToken();
    }
    const verifyResult: VerifyMiniAppHandshakeOfferResult =
      await verifyMiniAppHandshakeOfferDetailed(body.handshake);
    if (!verifyResult.ok) {
      clearPendingMiniAppAuthHandshake();
      if (verifyResult.code === MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE) {
        return {
          ok: false,
          diagnostics: parseAccessDiagnostics(
            {
              code: MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
              error: MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
              status: 403,
            },
            response,
            MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE
          ),
        };
      }
      if (verifyResult.signatureMismatch) {
        tryReloadAfterSigningKeyRotation();
      }
      return {
        ok: false,
        diagnostics: parseAccessDiagnostics(
          {
            code: MINI_APP_INVALID_HANDSHAKE_CODE,
            error: MINI_APP_INVALID_HANDSHAKE_CODE,
            status: 403,
          },
          response,
          MINI_APP_INVALID_HANDSHAKE_CODE
        ),
      };
    }
    const verifiedHandshake: Readonly<MiniAppAuthHandshakeOffer> = verifyResult.offer;
    const handshakeLocalExpiresAt: number = toLocalEpochMs(
      verifiedHandshake.expiresAt,
      response
    );
    if (handshakeLocalExpiresAt <= Date.now()) {
      clearPendingMiniAppAuthHandshake();
      return {
        ok: false,
        diagnostics: parseAccessDiagnostics(
          {
            code: MINI_APP_INVALID_HANDSHAKE_CODE,
            error: MINI_APP_INVALID_HANDSHAKE_CODE,
            status: 403,
          },
          response,
          MINI_APP_INVALID_HANDSHAKE_CODE
        ),
      };
    }
    clearSigningKeyReloadGuard();
    setPendingMiniAppAuthHandshake(verifiedHandshake, handshakeLocalExpiresAt);
  }
  return {
    ok: true,
    ttlMs,
    totpEnabled,
    authMode,
    ...(sessionValid ? { sessionValid: true, sessionExpiresAt } : {}),
  };
}
