import {
  miniAppActiveConfigHolder,
  miniAppLastConsumedTotpStepHolder,
  miniAppPasswordGuardHolder,
} from "../../cache/main/miniApp";
import { SUPER_ADMIN_USER_ID, getBotMiniAppConfig } from "../../config/bot";
import {
  MINI_APP_PASSWORD_LOCKOUT_MS,
  MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_TTL_MS,
} from "../../consts/miniApp";
import {
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_LOGIN_REQUEST_AAD,
  MINI_APP_LOGIN_RESPONSE_AAD,
} from "../../consts/miniAppCrypto";
import { chatAtmosphere } from "../../infra/atmosphere";
import { logger } from "../../infra/logger";
import { sendMessage } from "../../infra/telegram/actions/messages";
import { verifyMiniAppPassword } from "../../libs/miniAppAuth";
import {
  computeMiniAppTotpCounter,
  verifyMiniAppTotpCode,
} from "../../libs/miniAppTotp";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { formatLocalTime } from "../../libs/time";
import type { BotMiniAppConfig } from "../../types/config";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppAuthHandshakeRecord,
  MiniAppAuthPrecheckResponse,
  MiniAppAuthSession,
  MiniAppConsumedTotpStep,
  MiniAppLoginSuccessResponse,
  MiniAppPasswordGuardState,
} from "../../types/miniApp/auth";
import type {
  MiniAppEncryptedEnvelope,
  MiniAppEncryptedPayload,
} from "../../types/miniApp/configs";
import type { MiniAppTotpRecord } from "../../types/miniAppTotp";
import {
  acquireMiniAppAuthHandshake,
  consumeMiniAppAuthHandshake,
  issueMiniAppAuthHandshake,
  releaseMiniAppAuthHandshakeInFlight,
} from "../auth/handshake";
import {
  attachClearMiniAppPageGateCookie,
  attachMiniAppPageGateCookie,
} from "../auth/pageGate";
import {
  checkSuperAdminPasswordLockout,
} from "../auth/lockout";
import {
  clearAllMiniAppAuthSessions,
  clearPendingMiniAppSessionKey,
  findActiveMiniAppAuthSession,
  issueMiniAppAuthSession,
  revokeMiniAppAuthSession,
} from "../auth/session";
import { loadMiniAppTotpRecord } from "../auth/totpStorage";
import {
  decryptMiniAppText,
  encryptMiniAppEnvelope,
  parseMiniAppEncryptedPayload,
} from "../libs/crypto";
import { deriveMiniAppHandshakeKeys } from "../libs/handshakeCrypto";
import type { DerivedMiniAppHandshakeKeys } from "../libs/handshakeCrypto";
import { extractSessionToken, readJsonObjectBody, resolveSafeClientIp } from "../libs/request";
import { accessErrorResponse, jsonResponse } from "../libs/response";

/** 模块内复用的 UTF-8 编码器。 */
const UTF8_ENCODER: TextEncoder = new TextEncoder();

/** `POST /api/auth/login` 解密请求载荷时绑定的固定 UTF-8 AAD 字节。 */
const LOGIN_REQUEST_AAD_BYTES: Uint8Array<ArrayBuffer> =
  UTF8_ENCODER.encode(MINI_APP_LOGIN_REQUEST_AAD);

/** `POST /api/auth/login` 加密响应信封时绑定的固定 UTF-8 AAD 字节。 */
const LOGIN_RESPONSE_AAD_BYTES: Uint8Array<ArrayBuffer> =
  UTF8_ENCODER.encode(MINI_APP_LOGIN_RESPONSE_AAD);

/** 从加密登录请求内层 JSON 解码出的握手绑定与二次认证凭据。 */
interface DecryptedLoginCredentials {
  readonly password?: string;
  readonly totpCode?: string;
}

/**
 * 构造统一的 `400 INVALID_HANDSHAKE` 响应并记录操作日志。
 * @param detailReason 仅写入后端操作日志的诊断细分标识（不返回给客户端）。
 * @returns 状态码 `400` 的 JSON 响应。
 */
function invalidHandshakeResponse(detailReason: string): Response {
  logger.operation("[MiniApp] auth.login", {
    outcome: "rejected",
    reason: detailReason,
  });
  return jsonResponse(
    {
      ok: false,
      code: MINI_APP_INVALID_HANDSHAKE_CODE,
      error: MINI_APP_INVALID_HANDSHAKE_CODE,
    },
    400
  );
}

/**
 * 解析并严格校验经 ECDH + HKDF `c2sKey` 解密还原的登录请求 JSON 明文：
 * 仅允许 `{ handshakeId, password }` 或 `{ handshakeId, totpCode }`（严格互斥，不允许同时出现），且 `handshakeId` 必须与外层已锁定的 `expectedHandshakeId` 一致。
 * @param decryptedText 解密还原的 UTF-8 文本。
 * @param expectedHandshakeId 已归一化的小写 32 位十六进制握手 ID。
 * @returns 校验通过的凭据对象，否则返回 `null`。
 */
function parseDecryptedLoginCredentials(
  decryptedText: string | null,
  expectedHandshakeId: string
): Readonly<DecryptedLoginCredentials> | null {
  if (decryptedText === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptedText);
  } catch (_error: unknown) {
    return null;
  }
  if (
    !isPlainRecord(parsed) ||
    !hasOnlyKeys(parsed, ["handshakeId", "password", "totpCode"]) ||
    typeof parsed.handshakeId !== "string" ||
    parsed.handshakeId.trim().toLowerCase() !== expectedHandshakeId
  ) {
    return null;
  }
  const hasPassword: boolean = parsed.password !== undefined;
  const hasTotpCode: boolean = parsed.totpCode !== undefined;
  if (
    hasPassword === hasTotpCode ||
    (hasPassword && typeof parsed.password !== "string") ||
    (hasTotpCode && typeof parsed.totpCode !== "string")
  ) {
    return null;
  }
  return {
    ...(typeof parsed.password === "string" ? { password: parsed.password } : {}),
    ...(typeof parsed.totpCode === "string" ? { totpCode: parsed.totpCode } : {}),
  };
}

/**
 * 使用本次握手派生的 `s2cKey` 与固定 `MINI_APP_LOGIN_RESPONSE_AAD` 将既有错误 `Response` 的 JSON 正文封装为加密信封，
 * 同时原样保留其 HTTP 状态码、`X-Request-Id` 与防缓存安全响应头。
 * @param s2cKey 服务端到客户端方向的 `AES-256-GCM` 加密密钥。
 * @param rawResponse 待加密封装的原始 JSON 响应。
 * @returns 正文已加密的 `Response` 实例。
 */
async function encryptLoginResponseEnvelope(
  s2cKey: CryptoKey,
  rawResponse: Response
): Promise<Response> {
  const plainText: string = await rawResponse.text();
  const envelope: Readonly<MiniAppEncryptedEnvelope> = await encryptMiniAppEnvelope(
    s2cKey,
    plainText,
    LOGIN_RESPONSE_AAD_BYTES
  );
  const headers: Headers = new Headers(rawResponse.headers);
  headers.delete("Content-Length");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(envelope), {
    status: rawResponse.status,
    headers,
  });
}

/**
 * 处理 `GET /api/auth/precheck`：在前置鉴权策略完成超级管理员 `initData` 签名与锁定期核验后，
 * 返回会话 TTL、TOTP 启用状态及当前二次认证会话是否有效，并签发最新单页门禁 Cookie；
 * 尚未解锁活跃会话时，立即生成一对临时 X25519 密钥并用本次启动内存 Ed25519 私钥签名随响应下发（用完即焚）。
 * 预检对已解锁会话仅只读核验而不轮换令牌或签发新会话密钥。
 * @param request 可选 HTTP 请求对象（用于核验客户端持久化的会话令牌及附加 `Set-Cookie`）。
 * @returns JSON 响应。
 */
export async function handleGetAuthPrecheckRoute(request?: Request): Promise<Response> {
  const totpRecord: Readonly<MiniAppTotpRecord> | null = await loadMiniAppTotpRecord();
  const totpEnabled: boolean = totpRecord !== null;
  const nowMs: number = Date.now();
  const sessionToken: string = request !== undefined ? extractSessionToken(request) : "";
  const activeSession: Readonly<MiniAppAuthSession> | null =
    findActiveMiniAppAuthSession(sessionToken, nowMs);

  let handshake: Readonly<MiniAppAuthHandshakeOffer> | undefined;
  if (activeSession === null) {
    const activeConfig: Readonly<BotMiniAppConfig> | undefined =
      miniAppActiveConfigHolder.current ?? getBotMiniAppConfig();
    if (activeConfig === undefined) {
      return jsonResponse(
        {
          ok: false,
          code: "MINI_APP_NOT_CONFIGURED",
          error: "MINI_APP_NOT_CONFIGURED",
        },
        503
      );
    }
    handshake = await issueMiniAppAuthHandshake(nowMs);
  }

  const payload: MiniAppAuthPrecheckResponse = {
    ok: true,
    ttlMs: MINI_APP_SESSION_TTL_MS,
    totpEnabled,
    authMode: totpEnabled ? "totp" : "password",
    ...(activeSession !== null
      ? {
        sessionValid: true,
        sessionExpiresAt: activeSession.expiresAt,
      }
      : { handshake }),
  };
  const response: Response = jsonResponse(payload);
  if (request !== undefined) {
    attachMiniAppPageGateCookie(response, request, nowMs);
  }
  return response;
}

/**
 * 处理 `POST /api/auth/login`：在前置鉴权策略完成超级管理员 `initData` 签名与锁定期核验后，
 * 结合预检签发的临时 X25519 私钥与请求携带的客户端临时公钥执行 ECDH + HKDF-SHA256 协商出方向隔离的 `c2sKey` / `s2cKey`，
 * 解密登录凭据后校验 6 位 Google Authenticator 动态码或 `mini_app.password`（并在裁决瞬间核销该临时握手，用完即焚）；
 * 校验通过后签发 45 分钟会话令牌与 256-bit AES PSK 并以 `s2cKey` 加密封装响应（活跃会话已满 5 个时淘汰最久未签发或轮换的会话）；
 * 连续输错满 3 次锁定 30 分钟、清空全部会话与握手记录并发送超级管理员告警。
 * @param request HTTP 请求对象。
 * @returns JSON 响应（握手协商通过后的 200/403 均封装为 `s2cKey` 加密的 `MiniAppEncryptedEnvelope`）。
 */
export async function handlePostAuthLoginRoute(request: Request): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  const lockoutBefore: Response | null = checkSuperAdminPasswordLockout(request, Date.now());
  if (lockoutBefore !== null) {
    return attachClearMiniAppPageGateCookie(lockoutBefore, request);
  }

  if (
    body === null ||
    !hasExactKeys(body, ["handshakeId", "clientPublicKey", "encryptedPayload"]) ||
    typeof body.handshakeId !== "string" ||
    typeof body.clientPublicKey !== "string"
  ) {
    return invalidHandshakeResponse("invalidHandshakeBody");
  }

  const encryptedPayload: Readonly<MiniAppEncryptedPayload> | null =
    parseMiniAppEncryptedPayload(body.encryptedPayload);
  if (encryptedPayload === null) {
    return invalidHandshakeResponse("invalidEncryptedPayload");
  }

  const handshake: Readonly<MiniAppAuthHandshakeRecord> | null =
    acquireMiniAppAuthHandshake(body.handshakeId, Date.now());
  if (handshake === null) {
    return invalidHandshakeResponse("invalidHandshake");
  }

  try {
    const derivedKeys: Readonly<DerivedMiniAppHandshakeKeys> | null =
      await deriveMiniAppHandshakeKeys({
        serverPrivateKey: handshake.serverPrivateKey,
        handshakeId: handshake.handshakeId,
        serverPublicKeyBase64: handshake.serverPublicKey,
        clientPublicKeyBase64: body.clientPublicKey,
      });
    if (derivedKeys === null) {
      consumeMiniAppAuthHandshake(handshake.handshakeId);
      return invalidHandshakeResponse("invalidClientPublicKey");
    }

    const decryptedText: string | null = await decryptMiniAppText({
      cryptoKey: derivedKeys.c2sKey,
      encrypted: encryptedPayload,
      additionalData: LOGIN_REQUEST_AAD_BYTES,
    });
    const credentials: Readonly<DecryptedLoginCredentials> | null =
      parseDecryptedLoginCredentials(decryptedText, handshake.handshakeId);
    if (credentials === null) {
      consumeMiniAppAuthHandshake(handshake.handshakeId);
      return invalidHandshakeResponse("invalidHandshakePayload");
    }

    const totpRecord: Readonly<MiniAppTotpRecord> | null = await loadMiniAppTotpRecord();
    const authNowMs: number = Date.now();
    // 自此读取锁定状态并消费握手到写回失败计数/签发会话为止不得插入 await；
    // 锁定裁决（含并发窗口内已通过外层锁定检查的在途请求）须先于握手存在性检查，避免锁定清空握手后误报 INVALID_HANDSHAKE。
    const guard: Readonly<MiniAppPasswordGuardState> | null = miniAppPasswordGuardHolder.current;
    const locked: boolean = guard?.userId === SUPER_ADMIN_USER_ID && guard.lockedUntil > authNowMs;
    if (locked) {
      consumeMiniAppAuthHandshake(handshake.handshakeId);
    } else if (!consumeMiniAppAuthHandshake(handshake.handshakeId)) {
      return invalidHandshakeResponse("handshakeRevoked");
    }

    let totpCounterToConsume: number | null = null;
    let verified: boolean;
    if (locked) {
      verified = false;
    } else if (totpRecord !== null) {
      const inputCode: string =
        typeof credentials.totpCode === "string"
          ? credentials.totpCode.trim()
          : "";
      const totpCounter: number = computeMiniAppTotpCounter(authNowMs);
      const lastConsumed: Readonly<MiniAppConsumedTotpStep> | null =
        miniAppLastConsumedTotpStepHolder.current;
      const isReplayedStep: boolean =
        lastConsumed !== null &&
        lastConsumed.secret === totpRecord.secret &&
        totpCounter <= lastConsumed.counter;
      verified =
        !isReplayedStep &&
        verifyMiniAppTotpCode(inputCode, totpRecord.secret, authNowMs);
      if (verified) {
        totpCounterToConsume = totpCounter;
      }
    } else {
      const inputPassword: string =
        typeof credentials.password === "string" ? credentials.password.trim() : "";
      const activeConfig: Readonly<BotMiniAppConfig> | undefined =
        miniAppActiveConfigHolder.current ?? getBotMiniAppConfig();
      verified =
        activeConfig !== undefined &&
        verifyMiniAppPassword(inputPassword, activeConfig.password);
    }

    const mode: "totp" | "password" = totpRecord !== null ? "totp" : "password";

    if (!verified) {
      const prevAttempts: number =
        guard?.userId === SUPER_ADMIN_USER_ID && (guard.lockedUntil === 0 || locked)
          ? guard.failedAttempts
          : 0;
      const nextAttempts: number = prevAttempts + 1;
      if (nextAttempts >= MINI_APP_PASSWORD_MAX_ATTEMPTS) {
        const lockedUntil: number = authNowMs + MINI_APP_PASSWORD_LOCKOUT_MS;
        miniAppPasswordGuardHolder.current = {
          userId: SUPER_ADMIN_USER_ID,
          failedAttempts: nextAttempts,
          lockedUntil,
        };
        clearAllMiniAppAuthSessions();
        logger.operation("[MiniApp] auth.login", {
          outcome: "rejected",
          mode,
          locked: true,
        });
        logger.warn(
          "[MiniApp] Super-admin login locked out after consecutive failed attempts."
        );
        if (!locked) {
          void sendMessage({
            chatId: SUPER_ADMIN_USER_ID,
            text: chatAtmosphere().NOTICE_TEXTS.miniAppLoginLocked(
              nextAttempts,
              formatLocalTime(lockedUntil),
              resolveSafeClientIp(request)
            ),
          });
        }
        const lockoutResponse: Response = checkSuperAdminPasswordLockout(request, authNowMs)!;
        const encryptedLockoutResponse: Response = await encryptLoginResponseEnvelope(
          derivedKeys.s2cKey,
          lockoutResponse
        );
        return attachClearMiniAppPageGateCookie(encryptedLockoutResponse, request);
      }
      miniAppPasswordGuardHolder.current = {
        userId: SUPER_ADMIN_USER_ID,
        failedAttempts: nextAttempts,
        lockedUntil: 0,
      };
      const remaining: number = MINI_APP_PASSWORD_MAX_ATTEMPTS - nextAttempts;
      const errorCode: string = totpRecord !== null ? "INVALID_TOTP_CODE" : "INVALID_PASSWORD";
      logger.operation("[MiniApp] auth.login", {
        outcome: "rejected",
        mode,
        locked: false,
      });
      const errorResponse: Response = accessErrorResponse(request, {
        status: 403,
        code: errorCode,
        reason: "invalid_password",
        error: errorCode,
        remainingAttempts: remaining,
      });
      return encryptLoginResponseEnvelope(derivedKeys.s2cKey, errorResponse);
    }

    miniAppPasswordGuardHolder.current = null;
    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(authNowMs);
    if (totpRecord !== null && totpCounterToConsume !== null) {
      miniAppLastConsumedTotpStepHolder.current = {
        secret: totpRecord.secret,
        counter: totpCounterToConsume,
      };
    }

    logger.operation("[MiniApp] auth.login", {
      outcome: "succeeded",
      mode,
    });
    try {
      const initialSessionKey: string = session.pendingSessionKey ?? "";
      const responsePayload: MiniAppLoginSuccessResponse = {
        ok: true,
        sessionToken: session.token,
        sessionKey: initialSessionKey,
        expiresAt: session.expiresAt,
        ttlMs: MINI_APP_SESSION_TTL_MS,
      };
      const envelope: Readonly<MiniAppEncryptedEnvelope> = await encryptMiniAppEnvelope(
        derivedKeys.s2cKey,
        JSON.stringify(responsePayload),
        LOGIN_RESPONSE_AAD_BYTES
      );
      return attachMiniAppPageGateCookie(jsonResponse(envelope), request, authNowMs);
    } finally {
      clearPendingMiniAppSessionKey(session.token);
    }
  } finally {
    releaseMiniAppAuthHandshakeInFlight(handshake.handshakeId);
  }
}

/**
 * 处理 `POST /api/auth/logout`：在前置鉴权策略完成超级管理员 `initData` 签名与锁定期核验后，
 * 吊销请求头 `X-Mini-App-Session` 携带的二次认证会话与 256-bit 临时密钥；会话已过期或不存在时同样返回成功。
 * @param request HTTP 请求对象。
 * @returns JSON 响应（`revoked` 表示是否删除了仍有效的会话）。
 */
export function handlePostAuthLogoutRoute(request: Request): Response {
  const revoked: boolean = revokeMiniAppAuthSession(extractSessionToken(request));
  logger.operation("[MiniApp] auth.logout", { sessionRevoked: revoked });
  return jsonResponse({ ok: true, revoked });
}
