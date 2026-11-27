import { MINI_APP_SHA256_HEX_PATTERN } from "../consts/miniApp";
import {
  MINI_APP_AES_GCM_IV_BYTES,
  MINI_APP_AES_GCM_TAG_BITS,
  MINI_APP_AES_GCM_TAG_BYTES,
  MINI_APP_BASE64_ALPHABET,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH,
  MINI_APP_SESSION_KEY_BITS,
  MINI_APP_SESSION_KEY_BYTES,
} from "../consts/miniAppCrypto";
import type {
  MiniAppEncryptedEnvelope,
  MiniAppEncryptedPayload,
} from "../types/miniAppConfigs";
import { asPayloadRecord } from "./record";

/** 模块内复用的 UTF-8 编码器。 */
const UTF8_ENCODER: TextEncoder = new TextEncoder();

/** 模块内复用的严格 UTF-8 解码器（拒绝畸形字节序列）。 */
const STRICT_UTF8_DECODER: TextDecoder = new TextDecoder("utf-8", {
  fatal: true,
});

/**
 * 校验输入是否为合法的 64 位十六进制（256-bit）对称密钥文本。
 *
 * @param value 待校验的值
 * @returns 为合法 64 位十六进制密钥字符串时返回 `true`
 */
export function isValidMiniAppHexKey(value: unknown): value is string {
  return typeof value === "string" && MINI_APP_SHA256_HEX_PATTERN.test(value.trim());
}

/**
 * 将单个十六进制字符的 UTF-16 码元值解析为 `0..15` 半字节整数，非法字符返回 `-1`。
 *
 * @param code 字符 UTF-16 码元值
 * @returns `0..15` 的半字节值，非法时返回 `-1`
 */
function decodeHexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

/**
 * 将单个标准 Base64 字符的 UTF-16 码元值解析为 `0..63` 六位整数，非法字符返回 `-1`。
 *
 * @param code 字符 UTF-16 码元值
 * @returns `0..63` 的六位值，非法时返回 `-1`
 */
function decodeBase64Sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/**
 * 将任意偶长度十六进制字符串严格解码为 `Uint8Array<ArrayBuffer>`，遇到奇数长度或非十六进制字符时抛错。
 *
 * @param hex 待解码的十六进制字符串
 * @returns 解码后的字节数组
 */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const trimmed: string = hex.trim();
  if (trimmed.length === 0 || trimmed.length % 2 !== 0) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  const byteLength: number = trimmed.length / 2;
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(byteLength);
  for (let i: number = 0; i < byteLength; i += 1) {
    const hi: number = decodeHexNibble(trimmed.charCodeAt(i * 2));
    const lo: number = decodeHexNibble(trimmed.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) {
      throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/**
 * 将字节数组按标准 RFC 4648 Base64 编码为字符串；宿主提供原生 `Uint8Array.prototype.toBase64` 时直走原生快路径，否则回退纯 JS 实现。
 *
 * @param bytes 待编码的字节视图
 * @returns 标准 Base64 字符串
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const len: number = bytes.length;
  if (len === 0) return "";
  if (typeof bytes.toBase64 === "function") {
    return bytes.toBase64();
  }
  const fullTriplets: number = len - (len % 3);
  const chunks: string[] = [];
  for (let i: number = 0; i < fullTriplets; i += 3) {
    const triple: number =
      ((bytes[i] ?? 0) << 16)
      | ((bytes[i + 1] ?? 0) << 8)
      | (bytes[i + 2] ?? 0);
    chunks.push(
      (MINI_APP_BASE64_ALPHABET[(triple >>> 18) & 63] ?? "A") +
      (MINI_APP_BASE64_ALPHABET[(triple >>> 12) & 63] ?? "A") +
      (MINI_APP_BASE64_ALPHABET[(triple >>> 6) & 63] ?? "A") +
      (MINI_APP_BASE64_ALPHABET[triple & 63] ?? "A")
    );
  }
  const remainder: number = len - fullTriplets;
  if (remainder === 1) {
    const single: number = bytes[fullTriplets] ?? 0;
    chunks.push(
      `${MINI_APP_BASE64_ALPHABET[(single >>> 2) & 63] ?? "A"}${MINI_APP_BASE64_ALPHABET[(single << 4) & 63] ?? "A"}=` +
      "="
    );
  } else if (remainder === 2) {
    const pair: number =
      ((bytes[fullTriplets] ?? 0) << 8) | (bytes[fullTriplets + 1] ?? 0);
    chunks.push(
      `${MINI_APP_BASE64_ALPHABET[(pair >>> 10) & 63] ?? "A"}${MINI_APP_BASE64_ALPHABET[(pair >>> 4) & 63] ?? "A"}${MINI_APP_BASE64_ALPHABET[(pair << 2) & 63] ?? "A"}=`
    );
  }
  return chunks.join("");
}

/**
 * 将标准 RFC 4648 Base64 字符串严格解码为 `Uint8Array<ArrayBuffer>`，空串、含空白、长度不齐、字符非法或填充残位非零时抛错；
 * 宿主提供原生 `Uint8Array.fromBase64` 时在完成无空白核验后直走严格模式原生快路径，否则回退纯 JS 实现。
 *
 * @param base64 待解码的 Base64 文本
 * @returns 解码后的字节数组
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length === 0 || /\s/u.test(base64)) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  if (typeof Uint8Array.fromBase64 === "function") {
    try {
      return Uint8Array.fromBase64(base64, {
        alphabet: "base64",
        lastChunkHandling: "strict",
      });
    } catch (error: unknown) {
      throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE, { cause: error });
    }
  }
  if (base64.length % 4 !== 0) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  let padCount: number = 0;
  if (base64.endsWith("==")) {
    padCount = 2;
  } else if (base64.endsWith("=")) {
    padCount = 1;
  }
  const outLength: number = (base64.length / 4) * 3 - padCount;
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(outLength);
  let outOffset: number = 0;
  const quadCount: number = base64.length / 4;
  for (let q: number = 0; q < quadCount; q += 1) {
    const baseIdx: number = q * 4;
    const isLastQuad: boolean = q === quadCount - 1;
    const c0: number = decodeBase64Sextet(base64.charCodeAt(baseIdx));
    const c1: number = decodeBase64Sextet(base64.charCodeAt(baseIdx + 1));
    if (c0 < 0 || c1 < 0) {
      throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    }
    if (isLastQuad && padCount === 2) {
      if ((c1 & 15) !== 0) {
        throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
      }
      out[outOffset] = (c0 << 2) | (c1 >>> 4);
      break;
    }
    const c2: number = decodeBase64Sextet(base64.charCodeAt(baseIdx + 2));
    if (c2 < 0) {
      throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    }
    if (isLastQuad && padCount === 1) {
      if ((c2 & 3) !== 0) {
        throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
      }
      out[outOffset] = (c0 << 2) | (c1 >>> 4);
      out[outOffset + 1] = ((c1 & 15) << 4) | (c2 >>> 2);
      break;
    }
    const c3: number = decodeBase64Sextet(base64.charCodeAt(baseIdx + 3));
    if (c3 < 0) {
      throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    }
    out[outOffset] = (c0 << 2) | (c1 >>> 4);
    out[outOffset + 1] = ((c1 & 15) << 4) | (c2 >>> 2);
    out[outOffset + 2] = ((c2 & 3) << 6) | c3;
    outOffset += 3;
  }
  return out;
}

/**
 * 将任意 `Uint8Array` 视图转为底层缓冲严格属于 `ArrayBuffer` 的切片，供 Web Crypto API 加密使用。
 *
 * @param bytes 待转换的字节视图
 * @returns 底层为 `ArrayBuffer` 的 `Uint8Array`
 */
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * 将 UTF-8 文本编码为底层缓冲类型为 `ArrayBuffer` 的 `Uint8Array`。
 *
 * @param text 待编码的字符串
 * @returns UTF-8 字节数组
 */
export function encodeUtf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  return toArrayBufferView(UTF8_ENCODER.encode(text));
}

/**
 * 将 64 位十六进制（256-bit）密钥导入为不可导出的 Web Crypto `AES-GCM` `CryptoKey`，并在返回前擦除临时字节缓冲。
 *
 * @param hexKey 64 位十六进制密钥文本
 * @param usages 允许的密钥用途列表（默认同时允许加密与解密）
 * @returns 导入后的 Web Crypto `CryptoKey`
 */
export async function importMiniAppAesGcmKey(
  hexKey: string,
  usages: readonly ("encrypt" | "decrypt")[] = ["encrypt", "decrypt"]
): Promise<CryptoKey> {
  if (!isValidMiniAppHexKey(hexKey)) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  const keyBytes: Uint8Array<ArrayBuffer> = hexToBytes(hexKey);
  try {
    if (keyBytes.byteLength !== MINI_APP_SESSION_KEY_BYTES) {
      throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    }
    return await globalThis.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM", length: MINI_APP_SESSION_KEY_BITS },
      false,
      [...usages]
    );
  } finally {
    keyBytes.fill(0);
  }
}

/**
 * 判断未知 JSON 载荷是否为严格仅含 `{ encrypted: true, iv, payload }` 且不含空白字符的密文信封结构。
 *
 * @param value 待检测的未知 JSON 值
 * @returns 符合严格 `{ encrypted: true, iv, payload }` 结构时返回 `true`
 */
export function isMiniAppEncryptedEnvelope(
  value: unknown
): value is Readonly<MiniAppEncryptedEnvelope> {
  const record: Record<string, unknown> = asPayloadRecord(value);
  return (
    Object.keys(record).length === 3 &&
    Object.hasOwn(record, "encrypted") &&
    Object.hasOwn(record, "iv") &&
    Object.hasOwn(record, "payload") &&
    record.encrypted === true &&
    typeof record.iv === "string" &&
    record.iv.length > 0 &&
    !/\s/u.test(record.iv) &&
    typeof record.payload === "string" &&
    record.payload.length > 0 &&
    !/\s/u.test(record.payload)
  );
}

/**
 * 使用已导入的 `AES-256-GCM` `CryptoKey` 与新生成的 12 字节随机 IV 加密 UTF-8 明文，输出 `{ iv, payload }`（`payload` 尾部附带 16 字节认证标签）。
 *
 * @param cryptoKey 已导入的 256-bit `AES-GCM` 密钥
 * @param plaintext 待加密的 UTF-8 文本
 * @param additionalData 可选的 AEAD 附加认证数据字节
 * @returns Base64 编码的 `{ iv, payload }`
 */
export async function encryptMiniAppPayload(
  cryptoKey: CryptoKey,
  plaintext: string,
  additionalData?: Uint8Array<ArrayBuffer>
): Promise<Readonly<MiniAppEncryptedPayload>> {
  const iv: Uint8Array<ArrayBuffer> = globalThis.crypto.getRandomValues(
    new Uint8Array(MINI_APP_AES_GCM_IV_BYTES)
  );
  const plainBytes: Uint8Array<ArrayBuffer> = encodeUtf8Bytes(plaintext);
  const cipherBuffer: ArrayBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: MINI_APP_AES_GCM_TAG_BITS,
      additionalData,
    },
    cryptoKey,
    plainBytes
  );
  return {
    iv: bytesToBase64(iv),
    payload: bytesToBase64(new Uint8Array(cipherBuffer)),
  };
}

/**
 * 将 UTF-8 JSON 明文加密为 `MiniAppEncryptedEnvelope` 传输信封（可绑定 `${METHOD} ${routePath}:req` AEAD 附加认证数据）。
 *
 * @param cryptoKey 已导入的 256-bit `AES-GCM` 会话密钥
 * @param plaintext 待加密的 UTF-8 JSON 字符串
 * @param additionalData 可选的 AEAD 附加认证数据字节
 * @returns `{ encrypted: true, iv, payload }` 加密信封
 */
export async function encryptMiniAppEnvelope(
  cryptoKey: CryptoKey,
  plaintext: string,
  additionalData?: Uint8Array<ArrayBuffer>
): Promise<Readonly<MiniAppEncryptedEnvelope>> {
  const encrypted: Readonly<MiniAppEncryptedPayload> =
    await encryptMiniAppPayload(cryptoKey, plaintext, additionalData);
  return {
    encrypted: true,
    iv: encrypted.iv,
    payload: encrypted.payload,
  };
}

/**
 * 使用已导入的 `AES-256-GCM` `CryptoKey` 与新生成的 12 字节随机 IV 加密原始二进制字节，输出紧凑二进制帧 `[12 字节 IV || 密文 + 16 字节认证标签]`。
 *
 * @param cryptoKey 已导入的 256-bit `AES-GCM` 会话密钥
 * @param plainBytes 待加密的原始字节数组
 * @param additionalData 可选的 AEAD 附加认证数据字节（如 `POST /api/gallery/upload:req`）
 * @returns 紧凑拼接 `[IV || 密文+标签]` 的二进制帧
 */
export async function encryptMiniAppBinary(
  cryptoKey: CryptoKey,
  plainBytes: Uint8Array,
  additionalData?: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const iv: Uint8Array<ArrayBuffer> = globalThis.crypto.getRandomValues(
    new Uint8Array(MINI_APP_AES_GCM_IV_BYTES)
  );
  const cipherBuffer: ArrayBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: MINI_APP_AES_GCM_TAG_BITS,
      additionalData,
    },
    cryptoKey,
    toArrayBufferView(plainBytes)
  );
  const cipherBytes: Uint8Array = new Uint8Array(cipherBuffer);
  const frame: Uint8Array<ArrayBuffer> = new Uint8Array(
    MINI_APP_AES_GCM_IV_BYTES + cipherBytes.byteLength
  );
  frame.set(iv, 0);
  frame.set(cipherBytes, MINI_APP_AES_GCM_IV_BYTES);
  return frame;
}

/**
 * 构造 Mini App 已认证业务路由加密信封或二进制上传帧的固定方向绑定 AEAD 附加认证数据（AAD）UTF-8 字节序列。
 * 格式：`${METHOD} ${routePath}:req` 或 `${METHOD} ${routePath}:res`，与服务端 `buildMiniAppEnvelopeAad` 保持一致。
 *
 * @param method HTTP 请求方法名（自动规范化为大写）
 * @param routePath 规范化的 `/api/...` 路由路径
 * @param direction 信封或帧方向（`"req"` 表示请求体，`"res"` 表示响应体）
 * @returns UTF-8 编码的 AAD 字节数组
 */
export function buildMiniAppEnvelopeAad(
  method: string,
  routePath: string,
  direction: "req" | "res"
): Uint8Array<ArrayBuffer> {
  return encodeUtf8Bytes(`${method.toUpperCase()} ${routePath}:${direction}`);
}

/**
 * 使用已导入的 `AES-256-GCM` `CryptoKey` 验证认证标签并解密 `{ iv, payload }` 为严格 UTF-8 字符串。
 *
 * @param cryptoKey 已导入的 256-bit `AES-GCM` 密钥
 * @param encrypted Base64 编码的 `{ iv, payload }` 密文对
 * @param additionalData 可选的 AEAD 附加认证数据字节
 * @returns 解密并经严格 UTF-8 校验后的明文字符串
 */
export async function decryptMiniAppPayload(
  cryptoKey: CryptoKey,
  encrypted: Readonly<MiniAppEncryptedPayload>,
  additionalData?: Uint8Array<ArrayBuffer>
): Promise<string> {
  const iv: Uint8Array<ArrayBuffer> = base64ToBytes(encrypted.iv);
  const cipherBytes: Uint8Array<ArrayBuffer> = base64ToBytes(encrypted.payload);
  if (
    iv.byteLength !== MINI_APP_AES_GCM_IV_BYTES ||
    cipherBytes.byteLength < MINI_APP_AES_GCM_TAG_BYTES
  ) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  let plainBuffer: ArrayBuffer;
  try {
    plainBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: MINI_APP_AES_GCM_TAG_BITS,
        additionalData,
      },
      cryptoKey,
      cipherBytes
    );
  } catch (error: unknown) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE, { cause: error });
  }
  try {
    return STRICT_UTF8_DECODER.decode(plainBuffer);
  } catch (error: unknown) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE, { cause: error });
  }
}

/**
 * 解封滑动续期响应头 `x-mini-app-session-key`（`<ivBase64>.<cipherBase64>`），以新会话令牌作为 AEAD 附加认证数据校验并还原新 64 位十六进制会话密钥。
 *
 * @param currentCryptoKey 本次请求发出时使用的会话 `CryptoKey`
 * @param headerValue `x-mini-app-session-key` 响应头原始文本
 * @param refreshedToken 同一响应头 `x-mini-app-session` 下发的新会话令牌
 * @returns 验证通过的小写 64 位十六进制新会话密钥
 */
export async function unsealRotatedSessionKey(
  currentCryptoKey: CryptoKey,
  headerValue: string,
  refreshedToken: string
): Promise<string> {
  const token: string = headerValue.trim();
  const dotIndex: number = token.indexOf(".");
  if (
    dotIndex <= 0 ||
    dotIndex !== token.lastIndexOf(".") ||
    dotIndex >= token.length - 1 ||
    /\s/u.test(token)
  ) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  const iv: string = token.slice(0, dotIndex);
  const payload: string = token.slice(dotIndex + 1);
  const plainKey: string = await decryptMiniAppPayload(
    currentCryptoKey,
    { iv, payload },
    encodeUtf8Bytes(refreshedToken.trim())
  );
  if (!isValidMiniAppHexKey(plainKey)) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  return plainKey.trim().toLowerCase();
}

/**
 * 将不含前导 `?` 的非空 URL 查询串按 `AES-256-GCM` 封装为紧凑参数值 `<ivBase64>.<cipherBase64>`，
 * 并以 `"${method} ${canonicalApiRoutePath}"` 的 UTF-8 字节作为 AEAD 附加认证数据绑定请求方法与内部路由路径。
 *
 * @param cryptoKey 当前会话的 256-bit `AES-GCM` `CryptoKey`
 * @param rawQuery 不含前导 `?` 的非空原始查询串
 * @param aadText `"${method} ${canonicalApiRoutePath}"` 附加认证数据文本
 * @returns 未经百分号编码的 `<ivBase64>.<cipherBase64>` 封装查询令牌
 */
export async function sealMiniAppQuery(
  cryptoKey: CryptoKey,
  rawQuery: string,
  aadText: string
): Promise<string> {
  if (rawQuery.length === 0 || aadText.length === 0) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  const encrypted: Readonly<MiniAppEncryptedPayload> =
    await encryptMiniAppPayload(cryptoKey, rawQuery, encodeUtf8Bytes(aadText));
  const sealed: string = `${encrypted.iv}.${encrypted.payload}`;
  if (sealed.length > MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH) {
    throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  }
  return sealed;
}
