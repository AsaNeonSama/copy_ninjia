/**
 * 模型返回的 base64 载荷公共解码门禁：校验字符集规范性、编码态与解码态体积上限并执行单次解码。
 */

import type {
  Base64PayloadDecodeResult,
} from "../../../types/aiChat/payload";
import { BASE64_NON_ALPHABET_PATTERN } from "../../../consts/aiChat/payload";

/** 校验无换行标准 base64 的长度对齐与末尾填充规范。 */
function isCanonicalBase64(encoded: string): boolean {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return false;
  const padding: number = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const firstNonAlphabet: number = encoded.search(BASE64_NON_ALPHABET_PATTERN);
  return firstNonAlphabet === (padding === 0 ? -1 : encoded.length - padding);
}

export interface DecodeBase64PayloadOptions {
  /** 待解码的无换行标准 base64 字符串。 */
  readonly encoded: string;
  /** 编码态字符数上限。 */
  readonly maxEncodedChars: number;
  /** 解码后的字节数上限。 */
  readonly maxBytes: number;
}

/**
 * 校验编码态长度、base64 规范性与解码态字节上限，通过后返回解码字节。
 */
export function decodeBase64Payload({
  encoded,
  maxEncodedChars,
  maxBytes,
}: DecodeBase64PayloadOptions): Base64PayloadDecodeResult {
  if (typeof encoded !== "string" || encoded.length === 0) {
    return { ok: false, reason: "empty payload" };
  }
  if (encoded.length > maxEncodedChars) {
    return { ok: false, reason: "encoded payload exceeds the size limit" };
  }
  if (!isCanonicalBase64(encoded)) {
    return { ok: false, reason: "payload is not canonical base64" };
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(encoded, {
      alphabet: "base64",
      lastChunkHandling: "strict",
    });
  } catch (error: unknown) {
    void error;
    return { ok: false, reason: "payload is not canonical base64" };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    return { ok: false, reason: "decoded payload is empty or exceeds the size limit" };
  }
  return { ok: true, bytes };
}
