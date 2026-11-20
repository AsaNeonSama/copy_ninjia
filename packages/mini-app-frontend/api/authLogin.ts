import { MINI_APP_SHA256_HEX_PATTERN } from "../consts/miniApp";
import {
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_LOGIN_REQUEST_AAD,
  MINI_APP_LOGIN_RESPONSE_AAD,
} from "../consts/miniAppCrypto";
import {
  getMiniAppSessionCryptoKey,
  setMiniAppSessionToken,
} from "../libs/credentials";
import {
  encodeUtf8Bytes,
  encryptMiniAppPayload,
  isValidMiniAppHexKey,
} from "../libs/crypto";
import {
  deriveClientMiniAppHandshakeKeys,
  generateClientMiniAppX25519KeyPair,
  takePendingMiniAppAuthHandshake,
} from "../libs/handshakeCrypto";
import type { DerivedClientMiniAppHandshakeKeys } from "../libs/handshakeCrypto";
import { asPayloadRecord } from "../libs/record";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppEncryptedLoginRequest,
  MiniAppLoginSuccessResponse,
  MiniAppPrecheckResult,
} from "../types/miniApp/auth";
import type { MiniAppEncryptedPayload } from "../types/miniAppConfigs";
import type { MiniAppAuthMode } from "../types/miniAppTotp";
import { throwMiniAppRecordError } from "./authError";
import { precheckMiniAppAccess } from "./authPrecheck";
import {
  buildMiniAppAuthHeaders,
  decodeMiniAppJsonResponse,
} from "./request";

const LOGIN_REQUEST_AAD_BYTES: Uint8Array<ArrayBuffer> = encodeUtf8Bytes(
  MINI_APP_LOGIN_REQUEST_AAD
);
const LOGIN_RESPONSE_AAD_BYTES: Uint8Array<ArrayBuffer> = encodeUtf8Bytes(
  MINI_APP_LOGIN_RESPONSE_AAD
);

/**
 * 取出预检阶段验签暂存的单次临时 X25519 握手凭据；若已被前一次登录尝试消费或已过期，
 * 则即时触发一次 `precheckMiniAppAccess()` 获取并验签全新握手凭据。
 *
 * @returns 可用于本次登录加密的已验签握手凭据；若预检确认会话已生效则返回 `null`
 */
async function resolveFreshAuthHandshake(): Promise<Readonly<MiniAppAuthHandshakeOffer> | null> {
  const existing: Readonly<MiniAppAuthHandshakeOffer> | null =
    takePendingMiniAppAuthHandshake();
  if (existing !== null) {
    return existing;
  }
  const precheckResult: MiniAppPrecheckResult = await precheckMiniAppAccess();
  if (!precheckResult.ok) {
    throwMiniAppRecordError(
      precheckResult.diagnostics,
      precheckResult.diagnostics.status
    );
  }
  if (precheckResult.sessionValid === true) {
    return null;
  }
  const fresh: Readonly<MiniAppAuthHandshakeOffer> | null =
    takePendingMiniAppAuthHandshake();
  if (fresh === null) {
    throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE);
  }
  return fresh;
}

/**
 * 执行 TLS 模式临时 ECDH 加密登录：
 * 1. 取用预检阶段通过源站本次启动 Ed25519 公钥验签的单次临时 X25519 握手公钥（若已消费/过期则自动重新预检验签）；
 * 2. 客户端实时生成临时 X25519 密钥对并经 HKDF-SHA256 派生方向隔离的 `c2sKey` / `s2cKey`；
 * 3. 使用 `c2sKey` 与 AAD `POST /api/auth/login:request` 加密提交 `{ handshakeId, password }` 或 `{ handshakeId, totpCode }`（二者严格互斥）；
 * 4. 使用 `s2cKey` 与 AAD `POST /api/auth/login:response` 解封服务端加密响应（200 下发首把 45 分钟 `sessionToken` 与 256-bit `AES PSK`，403/409 抛出带状态码前缀的结构化错误）。
 *
 * @param credential 用户输入的 6 位 TOTP 验证码或访问密码
 * @param mode 当前登录校验模式（`"totp"` 或 `"password"`）
 */
export async function loginMiniAppWithPassword(
  credential: string,
  mode: MiniAppAuthMode = "password"
): Promise<void> {
  const handshake: Readonly<MiniAppAuthHandshakeOffer> | null =
    await resolveFreshAuthHandshake();
  if (handshake === null) {
    return;
  }

  const clientKeyPair: Readonly<{ privateKey: CryptoKey; publicKeyBase64: string }> =
    await generateClientMiniAppX25519KeyPair();
  const { c2sKey, s2cKey }: Readonly<DerivedClientMiniAppHandshakeKeys> =
    await deriveClientMiniAppHandshakeKeys({
      clientPrivateKey: clientKeyPair.privateKey,
      serverPublicKeyBase64: handshake.serverPublicKey,
      clientPublicKeyBase64: clientKeyPair.publicKeyBase64,
      handshakeId: handshake.handshakeId,
    });

  const plaintextPayload: string = JSON.stringify(
    mode === "totp"
      ? { handshakeId: handshake.handshakeId, totpCode: credential }
      : { handshakeId: handshake.handshakeId, password: credential }
  );
  const encryptedPayload: Readonly<MiniAppEncryptedPayload> =
    await encryptMiniAppPayload(
      c2sKey,
      plaintextPayload,
      LOGIN_REQUEST_AAD_BYTES
    );
  const loginRequest: MiniAppEncryptedLoginRequest = {
    handshakeId: handshake.handshakeId,
    clientPublicKey: clientKeyPair.publicKeyBase64,
    encryptedPayload,
  };

  const rawLoginResponse: Response = await fetch("./api/auth/login", {
    method: "POST",
    headers: buildMiniAppAuthHeaders(false, "application/json"),
    body: JSON.stringify(loginRequest),
  });
  const decodedPayload: unknown = await decodeMiniAppJsonResponse(
    rawLoginResponse,
    s2cKey,
    {
      requireEncryptedSuccess: true,
      additionalData: LOGIN_RESPONSE_AAD_BYTES,
    }
  );
  if (!rawLoginResponse.ok) {
    throwMiniAppRecordError(decodedPayload, rawLoginResponse.status);
  }

  const record: Record<string, unknown> = asPayloadRecord(decodedPayload);
  if (
    record.ok !== true ||
    typeof record.sessionToken !== "string" ||
    !MINI_APP_SHA256_HEX_PATTERN.test(record.sessionToken.trim()) ||
    !isValidMiniAppHexKey(record.sessionKey) ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt <= 0 ||
    typeof record.ttlMs !== "number" ||
    !Number.isFinite(record.ttlMs) ||
    record.ttlMs <= 0
  ) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }

  const issued: MiniAppLoginSuccessResponse =
    decodedPayload as MiniAppLoginSuccessResponse;
  const localExpiresAt: number = Date.now() + issued.ttlMs;
  setMiniAppSessionToken(
    issued.sessionToken,
    localExpiresAt,
    issued.sessionKey
  );
  await getMiniAppSessionCryptoKey();
}
