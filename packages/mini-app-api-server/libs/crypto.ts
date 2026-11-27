import { MINI_APP_SHA256_HEX_PATTERN } from "../../consts/miniApp";
import {
  MINI_APP_AES_GCM_ALGORITHM,
  MINI_APP_AES_GCM_IV_BYTES,
  MINI_APP_AES_GCM_TAG_BITS,
  MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH,
  MINI_APP_SESSION_KEY_BITS,
} from "../../consts/miniAppCrypto";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import type {
  MiniAppEncryptedEnvelope,
  MiniAppEncryptedPayload,
} from "../../types/miniApp/configs";

/** 模块内复用的 UTF-8 编码器。 */
const UTF8_ENCODER: TextEncoder = new TextEncoder();

/** 模块内复用的严格 UTF-8 解码器（拒绝畸形字节序列）。 */
const STRICT_UTF8_DECODER: TextDecoder = new TextDecoder("utf-8", {
  fatal: true,
});

/** `decryptMiniAppText` 解密 AES-256-GCM 密文片段的入参。 */
export interface DecryptMiniAppTextOptions {
  /** 已导入的 AES-256-GCM 对称密钥。 */
  readonly cryptoKey: CryptoKey;
  /** 待解密的 IV 与密文片段。 */
  readonly encrypted: Readonly<MiniAppEncryptedPayload>;
  /** 可选的附加认证数据（AAD），必须与加密时完全一致。 */
  readonly additionalData?: Uint8Array<ArrayBuffer>;
}

/** `decryptMiniAppBinary` 解密原始二进制 AES-256-GCM 帧的入参。 */
export interface DecryptMiniAppBinaryOptions {
  /** 已导入的 AES-256-GCM 对称密钥。 */
  readonly cryptoKey: CryptoKey;
  /** 形如 `[12 字节 IV || AES-256-GCM 密文+16 字节标签]` 的二进制帧。 */
  readonly encryptedBytes: Uint8Array;
  /** 可选的附加认证数据（AAD），必须与加密时完全一致。 */
  readonly additionalData?: Uint8Array<ArrayBuffer>;
}

/**
 * 将任意 `Uint8Array` 视图转为底层缓冲严格属于 `ArrayBuffer` 的切片，供 Web Crypto API 无拷贝或安全复制使用。
 * @param bytes 待转换的字节视图。
 * @returns 底层为 `ArrayBuffer` 的 `Uint8Array`。
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
 * 生成指定字节长度的密码学安全随机小写十六进制字符串。
 * @param byteLength 随机字节长度。
 * @returns `byteLength * 2` 位小写十六进制字符串。
 */
export function generateMiniAppRandomHex(byteLength: number): string {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes.toHex();
}

/**
 * 严格解码标准 RFC 4648 Base64 字符串为 `Uint8Array<ArrayBuffer>`；含任何空白字符、URL-safe 字符、缺失填充或非零填充残位时返回 `null`。
 * @param raw 待解码的 Base64 字符串。
 * @returns 解码后的字节数组，格式非法时返回 `null`。
 */
export function decodeMiniAppBase64Bytes(raw: string): Uint8Array<ArrayBuffer> | null {
  if (raw.length === 0 || /\s/u.test(raw)) {
    return null;
  }
  try {
    return Uint8Array.fromBase64(raw, {
      alphabet: "base64",
      lastChunkHandling: "strict",
    });
  } catch (_error: unknown) {
    return null;
  }
}

/**
 * 将 64 位十六进制（256-bit）密钥导入为不可导出的 Web Crypto `AES-GCM` `CryptoKey`，并在导入后擦除临时密钥缓冲。
 * @param hexKey 64 位十六进制原始密钥字符串。
 * @returns 可用于 `encrypt` 与 `decrypt` 的 `CryptoKey`。
 */
export async function importMiniAppAesGcmKey(hexKey: string): Promise<CryptoKey> {
  if (!MINI_APP_SHA256_HEX_PATTERN.test(hexKey)) {
    throw new Error("Invalid 256-bit hex key.");
  }
  const rawKey: Uint8Array<ArrayBuffer> = Uint8Array.fromHex(hexKey);
  try {
    return await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: MINI_APP_AES_GCM_ALGORITHM, length: MINI_APP_SESSION_KEY_BITS },
      false,
      ["encrypt", "decrypt"]
    );
  } finally {
    rawKey.fill(0);
  }
}

/**
 * 使用给定的 256-bit `AES-GCM` `CryptoKey` 与随机 12 字节 IV 加密 UTF-8 文本。
 * @param cryptoKey 已导入的 `AES-GCM` 对称密钥。
 * @param plaintext 待加密的 UTF-8 明文字符串。
 * @param additionalData 可选的附加认证数据（AAD）。
 * @returns Base64 编码的 `{ iv, payload }` 载荷。
 */
async function encryptMiniAppText(
  cryptoKey: CryptoKey,
  plaintext: string,
  additionalData?: Uint8Array<ArrayBuffer>
): Promise<Readonly<MiniAppEncryptedPayload>> {
  const iv: Uint8Array<ArrayBuffer> = new Uint8Array(MINI_APP_AES_GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const plainBytes: Uint8Array<ArrayBuffer> = UTF8_ENCODER.encode(plaintext);
  const cipherBuffer: ArrayBuffer = await crypto.subtle.encrypt(
    {
      name: MINI_APP_AES_GCM_ALGORITHM,
      iv,
      tagLength: MINI_APP_AES_GCM_TAG_BITS,
      additionalData,
    },
    cryptoKey,
    plainBytes
  );
  return {
    iv: iv.toBase64(),
    payload: new Uint8Array(cipherBuffer).toBase64(),
  };
}

/**
 * 使用给定的 256-bit `AES-GCM` `CryptoKey` 加密 UTF-8 文本并包装为标准传输信封。
 * @param cryptoKey 已导入的 `AES-GCM` 对称密钥。
 * @param plaintext 待加密的 UTF-8 明文字符串。
 * @param additionalData 可选的附加认证数据（AAD）。
 * @returns 带 `encrypted: true` 标记的 `MiniAppEncryptedEnvelope`。
 */
export async function encryptMiniAppEnvelope(
  cryptoKey: CryptoKey,
  plaintext: string,
  additionalData?: Uint8Array<ArrayBuffer>
): Promise<Readonly<MiniAppEncryptedEnvelope>> {
  const encrypted: Readonly<MiniAppEncryptedPayload> = await encryptMiniAppText(
    cryptoKey,
    plaintext,
    additionalData
  );
  return {
    encrypted: true,
    iv: encrypted.iv,
    payload: encrypted.payload,
  };
}

/**
 * 解密并校验 AES-256-GCM `{ iv, payload }` 片段；IV 长度不符、密文短于认证标签、标签校验失败或非严格 UTF-8 时统一返回 `null`。
 * @param options 对称密钥、密文片段与可选 AAD。
 * @returns 解密还原的 UTF-8 明文字符串；校验失败时返回 `null`。
 */
export async function decryptMiniAppText({
  cryptoKey,
  encrypted,
  additionalData,
}: Readonly<DecryptMiniAppTextOptions>): Promise<string | null> {
  const iv: Uint8Array<ArrayBuffer> | null = decodeMiniAppBase64Bytes(encrypted.iv);
  if (iv?.byteLength !== MINI_APP_AES_GCM_IV_BYTES) {
    return null;
  }
  const cipherBytes: Uint8Array<ArrayBuffer> | null = decodeMiniAppBase64Bytes(
    encrypted.payload
  );
  const minTagBytes: number = MINI_APP_AES_GCM_TAG_BITS / 8;
  if (cipherBytes === null || cipherBytes.byteLength < minTagBytes) {
    return null;
  }
  try {
    const plainBuffer: ArrayBuffer = await crypto.subtle.decrypt(
      {
        name: MINI_APP_AES_GCM_ALGORITHM,
        iv,
        tagLength: MINI_APP_AES_GCM_TAG_BITS,
        additionalData,
      },
      cryptoKey,
      cipherBytes
    );
    return STRICT_UTF8_DECODER.decode(new Uint8Array(plainBuffer));
  } catch (_error: unknown) {
    return null;
  }
}

/**
 * 严格校验未知 JSON 值是否为仅含 `{ iv: string, payload: string }` 且不含空白字符的加密载荷结构。
 * @param raw 待校验的未知值。
 * @returns 校验通过时返回只读载荷对象，否则返回 `null`。
 */
export function parseMiniAppEncryptedPayload(
  raw: unknown
): Readonly<MiniAppEncryptedPayload> | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ["iv", "payload"])) {
    return null;
  }
  if (
    typeof raw.iv !== "string" ||
    raw.iv.length === 0 ||
    /\s/u.test(raw.iv) ||
    typeof raw.payload !== "string" ||
    raw.payload.length === 0 ||
    /\s/u.test(raw.payload)
  ) {
    return null;
  }
  return {
    iv: raw.iv,
    payload: raw.payload,
  };
}

/**
 * 严格校验未知 JSON 值是否为仅含 `{ encrypted: true, iv: string, payload: string }` 且不含空白字符的传输信封结构。
 * @param raw 待校验的未知值。
 * @returns 校验通过时返回只读信封对象，否则返回 `null`。
 */
export function parseMiniAppEncryptedEnvelope(
  raw: unknown
): Readonly<MiniAppEncryptedEnvelope> | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ["encrypted", "iv", "payload"]) ||
    raw.encrypted !== true
  ) {
    return null;
  }
  if (
    typeof raw.iv !== "string" ||
    raw.iv.length === 0 ||
    /\s/u.test(raw.iv) ||
    typeof raw.payload !== "string" ||
    raw.payload.length === 0 ||
    /\s/u.test(raw.payload)
  ) {
    return null;
  }
  return {
    encrypted: true,
    iv: raw.iv,
    payload: raw.payload,
  };
}

/**
 * 校验并解封 URL 查询参数 `e` 解码后的 `<ivBase64>.<cipherBase64>` 令牌，核验长度上限、唯一分隔点与 `${method} ${canonicalApiRoutePath}` AAD 绑定。
 * @param cryptoKey 会话 256-bit `AES-GCM` 对称密钥。
 * @param sealedQuery URL 查询参数 `e` 解码后的 `<ivBase64>.<cipherBase64>` 字符串。
 * @param aadText 期望匹配的请求上下文 AAD 文本（`${method} ${canonicalApiRoutePath}`）。
 * @returns 解密还原的原始查询串（不含前导 `?`）；为空、超限、畸形、篡改或 AAD 不匹配时返回 `null`。
 */
export async function unsealMiniAppQuery(
  cryptoKey: CryptoKey,
  sealedQuery: string,
  aadText: string
): Promise<string | null> {
  if (
    sealedQuery.length === 0 ||
    sealedQuery.length > MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH
  ) {
    return null;
  }
  const dotIndex: number = sealedQuery.indexOf(".");
  if (
    dotIndex <= 0 ||
    dotIndex >= sealedQuery.length - 1 ||
    sealedQuery.includes(".", dotIndex + 1)
  ) {
    return null;
  }
  const iv: string = sealedQuery.slice(0, dotIndex);
  const payload: string = sealedQuery.slice(dotIndex + 1);
  return decryptMiniAppText({
    cryptoKey,
    encrypted: { iv, payload },
    additionalData: UTF8_ENCODER.encode(aadText),
  });
}

/**
 * 将滑动续期新签发的 256-bit 会话密钥用当前请求匹配的旧会话密钥执行 AES-256-GCM 封装（AAD 绑定新 `sessionToken`），
 * 编码为 `<ivBase64>.<cipherBase64>` 供 `X-Mini-App-Session-Key` 响应头安全下发。
 * @param currentCryptoKey 当前请求所持旧会话密钥对应的 `CryptoKey`。
 * @param nextSessionKey 新签发的 64 位小写十六进制会话密钥。
 * @param nextSessionToken 新签发的 64 位小写十六进制会话令牌。
 * @returns 形如 `<ivBase64>.<cipherBase64>` 的加密密钥信封串。
 */
export async function sealRotatedMiniAppSessionKey(
  currentCryptoKey: CryptoKey,
  nextSessionKey: string,
  nextSessionToken: string
): Promise<string> {
  const sealed: Readonly<MiniAppEncryptedPayload> = await encryptMiniAppText(
    currentCryptoKey,
    nextSessionKey,
    UTF8_ENCODER.encode(nextSessionToken)
  );
  return `${sealed.iv}.${sealed.payload}`;
}

/**
 * 解密并校验紧凑二进制 AES-256-GCM 帧（`[12 字节 IV || 密文 + 16 字节认证标签]`）；长度不足、标签校验失败或 AAD 不匹配时统一返回 `null`。
 * @param options 对称密钥、二进制密文帧与可选 AAD。
 * @returns 解密还原的原始字节数组；校验失败时返回 `null`。
 */
export async function decryptMiniAppBinary({
  cryptoKey,
  encryptedBytes,
  additionalData,
}: Readonly<DecryptMiniAppBinaryOptions>): Promise<Uint8Array<ArrayBuffer> | null> {
  const minTagBytes: number = MINI_APP_AES_GCM_TAG_BITS / 8;
  if (encryptedBytes.byteLength < MINI_APP_AES_GCM_IV_BYTES + minTagBytes) {
    return null;
  }
  const view: Uint8Array<ArrayBuffer> = toArrayBufferView(encryptedBytes);
  const iv: Uint8Array<ArrayBuffer> = view.subarray(0, MINI_APP_AES_GCM_IV_BYTES);
  const cipherBytes: Uint8Array<ArrayBuffer> = view.subarray(
    MINI_APP_AES_GCM_IV_BYTES
  );
  try {
    const plainBuffer: ArrayBuffer = await crypto.subtle.decrypt(
      {
        name: MINI_APP_AES_GCM_ALGORITHM,
        iv,
        tagLength: MINI_APP_AES_GCM_TAG_BITS,
        additionalData,
      },
      cryptoKey,
      cipherBytes
    );
    return new Uint8Array(plainBuffer);
  } catch (_error: unknown) {
    return null;
  }
}

/**
 * 构造 Mini App 已认证业务路由加密信封或二进制上传帧的固定方向绑定 AEAD 附加认证数据（AAD）UTF-8 字节序列。
 * 格式：`${METHOD} ${routePath}:req` 或 `${METHOD} ${routePath}:res`，与前端 `buildMiniAppEnvelopeAad` 保持一致。
 * @param method HTTP 请求方法名（规范化为大写）。
 * @param routePath 规范化的 API 路由路径。
 * @param direction 信封或帧方向（`"req"` 或 `"res"`）。
 * @returns UTF-8 编码的 AAD 字节数组。
 */
export function buildMiniAppEnvelopeAad(
  method: string,
  routePath: string,
  direction: "req" | "res"
): Uint8Array<ArrayBuffer> {
  return UTF8_ENCODER.encode(`${method.toUpperCase()} ${routePath}:${direction}`);
}
