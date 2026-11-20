import {
  MINI_APP_ED25519_ALGORITHM,
  MINI_APP_ED25519_PUBLIC_KEY_BYTES,
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_SERVER_SIGNING_PUBLIC_KEY_BASE64,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../consts/miniAppCrypto";
import { base64ToBytes } from "./crypto";

/**
 * 判断异常或运行时环境是否反映浏览器缺失 Web Crypto 安全上下文或不支持现代椭圆曲线算法（`NotSupportedError`）。
 *
 * @param error 待判定的异常对象
 * @returns 缺失 `crypto.subtle`、命中 `NotSupportedError` 或已标记为 `WEBCRYPTO_UNSUPPORTED` 时返回 `true`
 */
export function isMiniAppWebCryptoUnsupportedError(error: unknown): boolean {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (
    subtle === undefined ||
    typeof subtle.importKey !== "function" ||
    typeof subtle.verify !== "function"
  ) {
    return true;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "NotSupportedError"
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    error.message === MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE
  );
}

/** 模块级缓存条目：按当前激活的 Base64 公钥文本复用已导入的 Web Crypto Ed25519 验签公钥。 */
interface CachedSigningPublicKey {
  readonly publicKeyBase64: string;
  readonly cryptoKeyPromise: Promise<CryptoKey>;
}

/** 测试隔离注入的可选源站 Ed25519 公钥 Base64 覆盖值（`null` 表示读取内置打包常量）。 */
let signingPublicKeyOverride: string | null = null;

/** 按公钥文本缓存的已导入 `Ed25519` `["verify"]` `CryptoKey`。 */
let cachedSigningKey: Readonly<CachedSigningPublicKey> | null = null;

/**
 * 覆盖前端源站本次启动 Ed25519 验签公钥（仅供单测/集成测试夹具使用，传入 `null` 还原读取编译常量）。
 *
 * @param publicKeyBase64 32 字节标准 Base64 编码的 Ed25519 原始公钥，或 `null` 重置
 */
export function setMiniAppServerSigningPublicKeyForTest(
  publicKeyBase64: string | null
): void {
  signingPublicKeyOverride =
    publicKeyBase64 === null ? null : publicKeyBase64.trim();
  cachedSigningKey = null;
}

/**
 * 获取当前前端使用的源站本次启动 Ed25519 验签公钥 `CryptoKey`（只读 `["verify"]`，由服务端物化静态 JS 时注入）。
 * 若打包常量仍为未替换的编译占位符或非法 Base64 / 非 32 字节公钥，直接抛出 `MINI_APP_INVALID_HANDSHAKE_CODE` fail-closed 拒绝握手。
 *
 * @returns 已导入的不可导出 `Ed25519` 验签公钥
 */
export async function getMiniAppServerSigningPublicKey(): Promise<CryptoKey> {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (
    subtle === undefined ||
    typeof subtle.importKey !== "function" ||
    typeof subtle.verify !== "function"
  ) {
    throw new Error(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
  }
  const effectiveBase64: string = (
    signingPublicKeyOverride ?? MINI_APP_SERVER_SIGNING_PUBLIC_KEY_BASE64
  ).trim();
  if (
    cachedSigningKey !== null &&
    cachedSigningKey.publicKeyBase64 === effectiveBase64
  ) {
    return cachedSigningKey.cryptoKeyPromise;
  }

  let rawPublicKeyBytes: Uint8Array<ArrayBuffer>;
  try {
    rawPublicKeyBytes = base64ToBytes(effectiveBase64);
  } catch (error: unknown) {
    throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE, { cause: error });
  }
  if (rawPublicKeyBytes.byteLength !== MINI_APP_ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE);
  }

  const nextPromise: Promise<CryptoKey> = subtle.importKey(
    "raw",
    rawPublicKeyBytes,
    { name: MINI_APP_ED25519_ALGORITHM },
    false,
    ["verify"]
  );
  const nextEntry: Readonly<CachedSigningPublicKey> = {
    publicKeyBase64: effectiveBase64,
    cryptoKeyPromise: nextPromise,
  };
  cachedSigningKey = nextEntry;
  try {
    return await nextPromise;
  } catch (error: unknown) {
    if (cachedSigningKey === nextEntry) {
      cachedSigningKey = null;
    }
    if (isMiniAppWebCryptoUnsupportedError(error)) {
      throw new Error(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE, { cause: error });
    }
    throw new Error(MINI_APP_INVALID_HANDSHAKE_CODE, { cause: error });
  }
}
