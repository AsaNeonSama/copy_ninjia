import {
  MINI_APP_ED25519_ALGORITHM,
  MINI_APP_ED25519_SIGNATURE_BYTES,
  MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX,
  MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX,
  MINI_APP_HANDSHAKE_ID_HEX_PATTERN,
  MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN,
  MINI_APP_HKDF_ALGORITHM,
  MINI_APP_HKDF_HASH,
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_SESSION_KEY_BITS,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
  MINI_APP_X25519_ALGORITHM,
  MINI_APP_X25519_PUBLIC_KEY_BYTES,
} from "../consts/miniAppCrypto";
import type { MiniAppAuthHandshakeOffer } from "../types/miniApp/auth";
import {
  base64ToBytes,
  bytesToBase64,
  encodeUtf8Bytes,
  hexToBytes,
} from "./crypto";
import { asPayloadRecord } from "./record";
import {
  getMiniAppServerSigningPublicKey,
  isMiniAppWebCryptoUnsupportedError,
} from "./signingKey";

const X25519_SHARED_SECRET_BITS: number = MINI_APP_X25519_PUBLIC_KEY_BYTES * 8;

/** 仅保存在浏览器内存中的已验签单次待用握手快照（严禁落盘进 Web Storage）。 */
interface PendingMiniAppAuthHandshake {
  readonly offer: Readonly<MiniAppAuthHandshakeOffer>;
  readonly localExpiresAt: number;
}

/** 当前等待在一次 `POST /api/auth/login` 中消耗的已验签临时握手。 */
let pendingAuthHandshake: Readonly<PendingMiniAppAuthHandshake> | null = null;

/** 客户端从临时 X25519 ECDH 协商推导方向隔离 `c2sKey` / `s2cKey` 所需的入参。 */
export interface DeriveClientMiniAppHandshakeKeysOptions {
  /** 客户端为本次登录生成的不可导出 X25519 临时私钥。 */
  readonly clientPrivateKey: CryptoKey;
  /** 服务端通过 Ed25519 签名验证后的 32 字节临时 X25519 公钥（标准 Base64）。 */
  readonly serverPublicKeyBase64: string;
  /** 客户端本次生成的 32 字节临时 X25519 公钥（标准 Base64）。 */
  readonly clientPublicKeyBase64: string;
  /** 服务端下发的 32 位小写十六进制握手 ID。 */
  readonly handshakeId: string;
}

/** 客户端在单次登录握手期间经 HKDF-SHA256 派生的方向隔离 AES-256-GCM 密钥对。 */
export interface DerivedClientMiniAppHandshakeKeys {
  /** 仅允许加密的请求方向对称密钥（绑定 `CopyNinjaMiniAppEcdhV1:c2s`）。 */
  readonly c2sKey: CryptoKey;
  /** 仅允许解密的响应方向对称密钥（绑定 `CopyNinjaMiniAppEcdhV1:s2c`）。 */
  readonly s2cKey: CryptoKey;
}

/**
 * 检查字节序列是否全零（用于客户端低阶点与弱共享密钥防御校验）。
 *
 * @param bytes 待检查的字节视图
 * @returns 全零时返回 `true`
 */
function isAllZeroBytes(bytes: Uint8Array): boolean {
  let accumulator: number = 0;
  for (const byte of bytes) {
    accumulator |= byte;
  }
  return accumulator === 0;
}

/**
 * 构造临时 X25519 握手公钥的规范签名抄本字节序列（与服务端 `buildMiniAppHandshakeTranscript` 逐字节一致）。
 *
 * @param handshakeId 32 位十六进制握手标识
 * @param serverPublicKey 标准 Base64 编码的 32 字节服务端临时 X25519 公钥
 * @param expiresAt 服务端原始过期毫秒时间戳
 * @returns UTF-8 编码的规范抄本字节数组
 */
export function buildMiniAppHandshakeTranscript(
  handshakeId: string,
  serverPublicKey: string,
  expiresAt: number
): Uint8Array<ArrayBuffer> {
  return encodeUtf8Bytes(
    `${MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN}\n${handshakeId.trim().toLowerCase()}\n${serverPublicKey.trim()}\n${expiresAt}`
  );
}

/**
 * 将预检下发的已验签临时 X25519 握手存入前端内存单次槽位。
 *
 * @param offer 已通过 Ed25519 验签的握手凭据
 * @param localExpiresAt 经浏览器本地时钟校准后的过期毫秒时间戳
 */
export function setPendingMiniAppAuthHandshake(
  offer: Readonly<MiniAppAuthHandshakeOffer>,
  localExpiresAt: number
): void {
  pendingAuthHandshake = {
    offer,
    localExpiresAt,
  };
}

/**
 * 原子取出并立即清空内存中的待用临时握手凭据（用完即焚）；若不存在或已过期则返回 `null`。
 *
 * @param nowMs 当前毫秒时间戳
 * @returns 取出的未过期握手凭据，否则返回 `null`
 */
export function takePendingMiniAppAuthHandshake(
  nowMs: number = Date.now()
): Readonly<MiniAppAuthHandshakeOffer> | null {
  const current: Readonly<PendingMiniAppAuthHandshake> | null = pendingAuthHandshake;
  pendingAuthHandshake = null;
  if (current === null || current.localExpiresAt <= nowMs) {
    return null;
  }
  return current.offer;
}

/**
 * 清空内存中暂存的临时 X25519 登录握手凭据（登出、锁定或切换会话时调用）。
 */
export function clearPendingMiniAppAuthHandshake(): void {
  pendingAuthHandshake = null;
}

/** `verifyMiniAppHandshakeOfferDetailed` 的详细验签结果（区分公钥失配、WebCrypto 不支持与格式错误）。 */
export type VerifyMiniAppHandshakeOfferResult =
  | {
    readonly ok: true;
    readonly offer: Readonly<MiniAppAuthHandshakeOffer>;
  }
  | {
    readonly ok: false;
    readonly code: string;
    readonly signatureMismatch: boolean;
  };

/**
 * 构造握手凭据格式或验签失败（非公钥失配）的统一结果。
 *
 * @param code 失败代码（`MINI_APP_INVALID_HANDSHAKE_CODE` 或 `MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE`）
 * @returns `signatureMismatch` 恒为 `false` 的失败结果
 */
function rejectHandshakeOffer(code: string): VerifyMiniAppHandshakeOfferResult {
  return { ok: false, code, signatureMismatch: false };
}

/**
 * 校验并验签预检接口下发的临时 X25519 公钥凭据（区分签名不匹配、WebCrypto 不支持与格式错误）：
 * 仅当 `crypto.subtle.verify` 返回 `false`（服务端重启轮换了内存 Ed25519 密钥而浏览器持有旧静态公钥）时标记 `signatureMismatch: true`。
 *
 * @param rawOffer 预检响应中的未知 `handshake` 字段
 * @returns 详尽验签结果
 */
export async function verifyMiniAppHandshakeOfferDetailed(
  rawOffer: unknown
): Promise<VerifyMiniAppHandshakeOfferResult> {
  if (isMiniAppWebCryptoUnsupportedError(undefined)) {
    return rejectHandshakeOffer(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
  }
  const record: Record<string, unknown> = asPayloadRecord(rawOffer);
  if (
    Object.keys(record).length !== 4 ||
    typeof record.handshakeId !== "string" ||
    typeof record.serverPublicKey !== "string" ||
    typeof record.expiresAt !== "number" ||
    typeof record.signature !== "string"
  ) {
    return rejectHandshakeOffer(MINI_APP_INVALID_HANDSHAKE_CODE);
  }
  const normalizedHandshakeId: string = record.handshakeId.trim().toLowerCase();
  const serverPublicKey: string = record.serverPublicKey.trim();
  const signature: string = record.signature.trim();
  const expiresAt: number = record.expiresAt;
  if (
    !MINI_APP_HANDSHAKE_ID_HEX_PATTERN.test(normalizedHandshakeId) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    return rejectHandshakeOffer(MINI_APP_INVALID_HANDSHAKE_CODE);
  }

  let serverPublicBytes: Uint8Array<ArrayBuffer>;
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    serverPublicBytes = base64ToBytes(serverPublicKey);
    signatureBytes = base64ToBytes(signature);
  } catch (_error: unknown) {
    return rejectHandshakeOffer(MINI_APP_INVALID_HANDSHAKE_CODE);
  }
  if (
    serverPublicBytes.byteLength !== MINI_APP_X25519_PUBLIC_KEY_BYTES ||
    isAllZeroBytes(serverPublicBytes) ||
    signatureBytes.byteLength !== MINI_APP_ED25519_SIGNATURE_BYTES
  ) {
    return rejectHandshakeOffer(MINI_APP_INVALID_HANDSHAKE_CODE);
  }

  try {
    const verifyKey: CryptoKey = await getMiniAppServerSigningPublicKey();
    const transcript: Uint8Array<ArrayBuffer> = buildMiniAppHandshakeTranscript(
      normalizedHandshakeId,
      serverPublicKey,
      expiresAt
    );
    const verified: boolean = await globalThis.crypto.subtle.verify(
      { name: MINI_APP_ED25519_ALGORITHM },
      verifyKey,
      signatureBytes,
      transcript
    );
    if (!verified) {
      return {
        ok: false,
        code: MINI_APP_INVALID_HANDSHAKE_CODE,
        signatureMismatch: true,
      };
    }
    return {
      ok: true,
      offer: {
        handshakeId: normalizedHandshakeId,
        serverPublicKey,
        expiresAt,
        signature,
      },
    };
  } catch (error: unknown) {
    if (isMiniAppWebCryptoUnsupportedError(error)) {
      return rejectHandshakeOffer(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
    }
    return rejectHandshakeOffer(MINI_APP_INVALID_HANDSHAKE_CODE);
  }
}

/**
 * 将 Web Crypto `generateKey` 返回值窄化为包含公私钥句柄的 `CryptoKeyPair`。
 *
 * @param value `crypto.subtle.generateKey` 返回值
 * @returns 窄化后的 `CryptoKeyPair`
 */
function assertClientCryptoKeyPair(value: unknown): CryptoKeyPair {
  if (
    typeof value === "object" &&
    value !== null &&
    "privateKey" in value &&
    "publicKey" in value
  ) {
    return value as CryptoKeyPair;
  }
  throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE);
}

/**
 * 为单次登录提交生成客户端临时 X25519 密钥对（私钥不可导出，仅导出 32 字节标准 Base64 公钥随登录请求发送）。
 *
 * @returns 客户端临时私钥与编码后的 32 字节公钥
 */
export async function generateClientMiniAppX25519KeyPair(): Promise<
  Readonly<{ privateKey: CryptoKey; publicKeyBase64: string }>
> {
  if (isMiniAppWebCryptoUnsupportedError(undefined)) {
    throw new Error(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
  }
  try {
    const generated: unknown = await globalThis.crypto.subtle.generateKey(
      { name: MINI_APP_X25519_ALGORITHM },
      false,
      ["deriveBits"]
    );
    const keyPair: CryptoKeyPair = assertClientCryptoKeyPair(generated);
    const rawPublicBuffer: ArrayBuffer = await globalThis.crypto.subtle.exportKey(
      "raw",
      keyPair.publicKey
    );
    return {
      privateKey: keyPair.privateKey,
      publicKeyBase64: bytesToBase64(new Uint8Array(rawPublicBuffer)),
    };
  } catch (error: unknown) {
    if (isMiniAppWebCryptoUnsupportedError(error)) {
      throw new Error(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE, { cause: error });
    }
    throw error;
  }
}

/**
 * 执行客户端临时 X25519 ECDH 协商，并经 HKDF-SHA256 派生本次登录独占的方向隔离 `c2sKey` / `s2cKey`。
 *
 * @param options 客户端临时私钥、已验签的服务端临时公钥、客户端公钥及握手 ID
 * @returns 方向隔离的两把 AES-256-GCM 密钥（失败时抛出 `MINI_APP_INVALID_HANDSHAKE_CODE`）
 */
export async function deriveClientMiniAppHandshakeKeys({
  clientPrivateKey,
  serverPublicKeyBase64,
  clientPublicKeyBase64,
  handshakeId,
}: Readonly<DeriveClientMiniAppHandshakeKeysOptions>): Promise<
  Readonly<DerivedClientMiniAppHandshakeKeys>
> {
  const normalizedHandshakeId: string = handshakeId.trim().toLowerCase();
  if (!MINI_APP_HANDSHAKE_ID_HEX_PATTERN.test(normalizedHandshakeId)) {
    throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE);
  }
  let serverPublicBytes: Uint8Array<ArrayBuffer>;
  let clientPublicBytes: Uint8Array<ArrayBuffer>;
  try {
    serverPublicBytes = base64ToBytes(serverPublicKeyBase64.trim());
    clientPublicBytes = base64ToBytes(clientPublicKeyBase64.trim());
  } catch (error: unknown) {
    throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE, { cause: error });
  }
  if (
    serverPublicBytes.byteLength !== MINI_APP_X25519_PUBLIC_KEY_BYTES ||
    clientPublicBytes.byteLength !== MINI_APP_X25519_PUBLIC_KEY_BYTES ||
    isAllZeroBytes(serverPublicBytes)
  ) {
    throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE);
  }

  let sharedSecretBytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    const serverPublicKey: CryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      serverPublicBytes,
      { name: MINI_APP_X25519_ALGORITHM },
      false,
      []
    );
    const sharedBuffer: ArrayBuffer = await globalThis.crypto.subtle.deriveBits(
      { name: MINI_APP_X25519_ALGORITHM, public: serverPublicKey },
      clientPrivateKey,
      X25519_SHARED_SECRET_BITS
    );
    sharedSecretBytes = new Uint8Array(sharedBuffer);
    if (
      sharedSecretBytes.byteLength !== MINI_APP_X25519_PUBLIC_KEY_BYTES ||
      isAllZeroBytes(sharedSecretBytes)
    ) {
      throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE);
    }

    const hkdfBaseKey: CryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      sharedSecretBytes,
      { name: MINI_APP_HKDF_ALGORITHM },
      false,
      ["deriveKey"]
    );
    const salt: Uint8Array<ArrayBuffer> = hexToBytes(normalizedHandshakeId);
    const contextSuffix: string =
      `\n${normalizedHandshakeId}\n${serverPublicKeyBase64.trim()}\n${clientPublicKeyBase64.trim()}`;
    const c2sInfo: Uint8Array<ArrayBuffer> = encodeUtf8Bytes(
      `${MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX}${contextSuffix}`
    );
    const s2cInfo: Uint8Array<ArrayBuffer> = encodeUtf8Bytes(
      `${MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX}${contextSuffix}`
    );

    const c2sKey: CryptoKey = await globalThis.crypto.subtle.deriveKey(
      {
        name: MINI_APP_HKDF_ALGORITHM,
        hash: MINI_APP_HKDF_HASH,
        salt,
        info: c2sInfo,
      },
      hkdfBaseKey,
      { name: "AES-GCM", length: MINI_APP_SESSION_KEY_BITS },
      false,
      ["encrypt"]
    );
    const s2cKey: CryptoKey = await globalThis.crypto.subtle.deriveKey(
      {
        name: MINI_APP_HKDF_ALGORITHM,
        hash: MINI_APP_HKDF_HASH,
        salt,
        info: s2cInfo,
      },
      hkdfBaseKey,
      { name: "AES-GCM", length: MINI_APP_SESSION_KEY_BITS },
      false,
      ["decrypt"]
    );
    return { c2sKey, s2cKey };
  } catch (error: unknown) {
    if (isMiniAppWebCryptoUnsupportedError(error)) {
      throw new Error(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE, { cause: error });
    }
    if (error instanceof Error && error.message === MINI_APP_INVALID_HANDSHAKE_CODE) {
      throw error;
    }
    throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE, { cause: error });
  } finally {
    if (sharedSecretBytes !== null) {
      sharedSecretBytes.fill(0);
    }
  }
}
