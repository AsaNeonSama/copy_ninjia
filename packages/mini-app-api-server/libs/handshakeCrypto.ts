/**
 * Mini App 登录阶段服务端角色的临时 X25519 ECDH + HKDF-SHA256 与源站本次启动 Ed25519 签名纯函数原语。
 * 本模块不接触任何主线程缓存；客户端角色（验签、客户端密钥对与派生）由 `packages/mini-app-frontend/libs/handshakeCrypto.ts` 实现。
 */

import {
  MINI_APP_AES_GCM_ALGORITHM,
  MINI_APP_ED25519_ALGORITHM,
  MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX,
  MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX,
  MINI_APP_HANDSHAKE_ID_HEX_PATTERN,
  MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN,
  MINI_APP_HKDF_ALGORITHM,
  MINI_APP_HKDF_HASH,
  MINI_APP_SESSION_KEY_BITS,
  MINI_APP_X25519_ALGORITHM,
  MINI_APP_X25519_PUBLIC_KEY_BYTES,
} from "../../consts/miniAppCrypto";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppRuntimeSigningKeyPair,
} from "../../types/miniApp/auth";
import { decodeMiniAppBase64Bytes } from "./crypto";

/** 模块内复用的 UTF-8 编码器。 */
const UTF8_ENCODER: TextEncoder = new TextEncoder();

/** X25519 共享密钥比特长度（32 字节 = 256 bits）。 */
const X25519_SHARED_SECRET_BITS: number = MINI_APP_X25519_PUBLIC_KEY_BYTES * 8;

/** `deriveMiniAppHandshakeKeys` 以服务端临时 X25519 私钥与客户端公钥派生方向隔离会话密钥的入参。 */
export interface DeriveMiniAppHandshakeKeysOptions {
  /** 本次握手服务端生成的临时 X25519 私钥句柄。 */
  readonly serverPrivateKey: CryptoKey;
  /** 32 位小写十六进制握手标识（解码为 16 字节 HKDF salt）。 */
  readonly handshakeId: string;
  /** 服务端下发的 32 字节临时 X25519 公钥（标准 Base64 编码）。 */
  readonly serverPublicKeyBase64: string;
  /** 客户端随登录请求提交的 32 字节临时 X25519 公钥（标准 Base64 编码）。 */
  readonly clientPublicKeyBase64: string;
}

/** HKDF-SHA256 为单次登录握手派生的方向隔离对称 `AES-256-GCM` 密钥对（服务端用途）。 */
export interface DerivedMiniAppHandshakeKeys {
  /** 仅允许解密的客户端请求方向密钥。 */
  readonly c2sKey: CryptoKey;
  /** 仅允许加密的服务端响应方向密钥。 */
  readonly s2cKey: CryptoKey;
}

/**
 * 构造临时 X25519 握手公钥的规范签名抄本字节序列（前后端及单测必须严格一致）。
 * 格式：`${MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN}\n${normalizedHandshakeId}\n${trimmedServerPubKey}\n${expiresAt}`。
 * @param handshakeId 32 位十六进制握手标识。
 * @param serverPublicKey 标准 Base64 编码的 32 字节服务端临时 X25519 公钥。
 * @param expiresAt 服务端签发时确定的过期毫秒时间戳。
 * @returns 规范 UTF-8 抄本字节视图。
 */
export function buildMiniAppHandshakeTranscript(
  handshakeId: string,
  serverPublicKey: string,
  expiresAt: number
): Uint8Array<ArrayBuffer> {
  return UTF8_ENCODER.encode(
    `${MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN}\n${handshakeId.trim().toLowerCase()}\n${serverPublicKey.trim()}\n${expiresAt}`
  );
}

/**
 * 校验 Web Crypto `generateKey` 返回值确为含 `privateKey` 与 `publicKey` 的 `CryptoKeyPair`。
 * @param value `crypto.subtle.generateKey` 未知返回对象。
 * @returns 类型收敛后的 `CryptoKeyPair`。
 */
function assertCryptoKeyPair(value: unknown): CryptoKeyPair {
  if (
    typeof value !== "object" ||
    value === null ||
    !("privateKey" in value) ||
    !("publicKey" in value) ||
    !(value.privateKey instanceof CryptoKey) ||
    !(value.publicKey instanceof CryptoKey)
  ) {
    throw new Error("Web Crypto generateKey did not return a CryptoKeyPair.");
  }
  return {
    privateKey: value.privateKey,
    publicKey: value.publicKey,
  };
}

/**
 * 为当前服务进程在内存中生成不可导出的 Ed25519 签名私钥与 32 字节标准 Base64 原始公钥。
 * 私钥仅允许 `["sign"]` 且不落盘；公钥编码后注入前端打包 JS 产物，供浏览器验签临时 X25519 公钥。
 * @returns 本次启动内存生成的 Ed25519 私钥句柄与 32 字节原始公钥标准 Base64。
 */
export async function generateMiniAppEd25519KeyPair(): Promise<
  Readonly<MiniAppRuntimeSigningKeyPair>
> {
  const generated: unknown = await crypto.subtle.generateKey(
    { name: MINI_APP_ED25519_ALGORITHM },
    false,
    ["sign", "verify"]
  );
  const keyPair: CryptoKeyPair = assertCryptoKeyPair(generated);
  const rawPublicBuffer: ArrayBuffer = await crypto.subtle.exportKey(
    "raw",
    keyPair.publicKey
  );
  return {
    privateKey: keyPair.privateKey,
    publicKeyBase64: new Uint8Array(rawPublicBuffer).toBase64(),
  };
}

/**
 * 使用本次启动内存生成的 Ed25519 私钥对临时 X25519 握手公钥抄本签出 64 字节标准 Base64 签名。
 * @param signingKey 已导入的 Ed25519 签名私钥句柄。
 * @param offer 含 `handshakeId`、`serverPublicKey` 与 `expiresAt` 的未签名握手凭据。
 * @returns 标准 Base64 编码的 64 字节 Ed25519 签名。
 */
export async function signMiniAppHandshakeOffer(
  signingKey: CryptoKey,
  offer: Omit<MiniAppAuthHandshakeOffer, "signature">
): Promise<string> {
  const transcript: Uint8Array<ArrayBuffer> = buildMiniAppHandshakeTranscript(
    offer.handshakeId,
    offer.serverPublicKey,
    offer.expiresAt
  );
  const signatureBuffer: ArrayBuffer = await crypto.subtle.sign(
    { name: MINI_APP_ED25519_ALGORITHM },
    signingKey,
    transcript
  );
  return new Uint8Array(signatureBuffer).toBase64();
}

/**
 * 为单次登录握手生成不可导出的临时 X25519 私钥与 32 字节标准 Base64 原始公钥。
 * @returns 临时 X25519 私钥句柄与编码后的原始公钥。
 */
export async function generateMiniAppX25519KeyPair(): Promise<
  Readonly<{ privateKey: CryptoKey; publicKeyBase64: string }>
> {
  const generated: unknown = await crypto.subtle.generateKey(
    { name: MINI_APP_X25519_ALGORITHM },
    false,
    ["deriveBits"]
  );
  const keyPair: CryptoKeyPair = assertCryptoKeyPair(generated);
  const rawPublicBuffer: ArrayBuffer = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKeyBase64: new Uint8Array(rawPublicBuffer).toBase64(),
  };
}

/**
 * 检查 X25519 共享密钥缓冲是否全零（低阶点防御校验）。
 * @param bytes 待检验的 32 字节共享密钥切片。
 * @returns 全零时返回 `true`。
 */
function isAllZeroBytes(bytes: Uint8Array): boolean {
  let accumulator: number = 0;
  for (const byte of bytes) {
    accumulator |= byte;
  }
  return accumulator === 0;
}

/**
 * 以服务端临时 X25519 私钥与客户端公钥执行 ECDH 共享密钥协商，并经 HKDF-SHA256 派生方向隔离的 `c2sKey`（仅解密）/ `s2cKey`（仅加密）`AES-256-GCM` 密钥对。
 * 遇到非法编码、非 32 字节公钥或低阶全零共享密钥时统一返回 `null`，并在返回前擦除共享密钥原始缓冲。
 * @param options 服务端临时私钥、双方公钥及握手抄本上下文。
 * @returns 派生成功时返回方向隔离的两把 `AES-GCM` 密钥，任意失败返回 `null`。
 */
export async function deriveMiniAppHandshakeKeys({
  serverPrivateKey,
  handshakeId,
  serverPublicKeyBase64,
  clientPublicKeyBase64,
}: Readonly<DeriveMiniAppHandshakeKeysOptions>): Promise<
  Readonly<DerivedMiniAppHandshakeKeys> | null
> {
  const normalizedHandshakeId: string = handshakeId.trim().toLowerCase();
  if (!MINI_APP_HANDSHAKE_ID_HEX_PATTERN.test(normalizedHandshakeId)) {
    return null;
  }
  const serverPublicBytes: Uint8Array<ArrayBuffer> | null = decodeMiniAppBase64Bytes(
    serverPublicKeyBase64.trim()
  );
  const clientPublicBytes: Uint8Array<ArrayBuffer> | null = decodeMiniAppBase64Bytes(
    clientPublicKeyBase64.trim()
  );
  if (
    serverPublicBytes?.byteLength !== MINI_APP_X25519_PUBLIC_KEY_BYTES ||
    clientPublicBytes?.byteLength !== MINI_APP_X25519_PUBLIC_KEY_BYTES ||
    isAllZeroBytes(clientPublicBytes)
  ) {
    return null;
  }

  let sharedSecretBytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    const clientPublicKey: CryptoKey = await crypto.subtle.importKey(
      "raw",
      clientPublicBytes,
      { name: MINI_APP_X25519_ALGORITHM },
      false,
      []
    );
    const sharedBuffer: ArrayBuffer = await crypto.subtle.deriveBits(
      { name: MINI_APP_X25519_ALGORITHM, public: clientPublicKey },
      serverPrivateKey,
      X25519_SHARED_SECRET_BITS
    );
    sharedSecretBytes = new Uint8Array(sharedBuffer);
    if (
      sharedSecretBytes.byteLength !== MINI_APP_X25519_PUBLIC_KEY_BYTES ||
      isAllZeroBytes(sharedSecretBytes)
    ) {
      return null;
    }

    const hkdfBaseKey: CryptoKey = await crypto.subtle.importKey(
      "raw",
      sharedSecretBytes,
      { name: MINI_APP_HKDF_ALGORITHM },
      false,
      ["deriveKey"]
    );
    const salt: Uint8Array<ArrayBuffer> = Uint8Array.fromHex(normalizedHandshakeId);
    const contextSuffix: string =
      `\n${normalizedHandshakeId}\n${serverPublicKeyBase64.trim()}\n${clientPublicKeyBase64.trim()}`;
    const c2sInfo: Uint8Array<ArrayBuffer> = UTF8_ENCODER.encode(
      `${MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX}${contextSuffix}`
    );
    const s2cInfo: Uint8Array<ArrayBuffer> = UTF8_ENCODER.encode(
      `${MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX}${contextSuffix}`
    );

    const [c2sResult, s2cResult]: readonly PromiseSettledResult<CryptoKey>[] =
      await Promise.allSettled([
        crypto.subtle.deriveKey(
          {
            name: MINI_APP_HKDF_ALGORITHM,
            hash: MINI_APP_HKDF_HASH,
            salt,
            info: c2sInfo,
          },
          hkdfBaseKey,
          {
            name: MINI_APP_AES_GCM_ALGORITHM,
            length: MINI_APP_SESSION_KEY_BITS,
          },
          false,
          ["decrypt"]
        ),
        crypto.subtle.deriveKey(
          {
            name: MINI_APP_HKDF_ALGORITHM,
            hash: MINI_APP_HKDF_HASH,
            salt,
            info: s2cInfo,
          },
          hkdfBaseKey,
          {
            name: MINI_APP_AES_GCM_ALGORITHM,
            length: MINI_APP_SESSION_KEY_BITS,
          },
          false,
          ["encrypt"]
        ),
      ]);
    if (
      c2sResult?.status !== "fulfilled" ||
      s2cResult?.status !== "fulfilled"
    ) {
      return null;
    }
    return { c2sKey: c2sResult.value, s2cKey: s2cResult.value };
  } catch (_error: unknown) {
    return null;
  } finally {
    if (sharedSecretBytes !== null) {
      sharedSecretBytes.fill(0);
    }
  }
}
