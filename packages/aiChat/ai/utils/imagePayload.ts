/**
 * 生图结果 base64 载荷的大小门禁、解码与图像文件签名核对。
 */

import {
  IMAGE_GENERATION_MAX_BYTES,
  IMAGE_GENERATION_MAX_ENCODED_CHARS,
  PNG_SIGNATURE,
} from "../../../consts/aiChat/imageGeneration";
import type {
  GeneratedChatImage,
  GeneratedImageDecodeResult,
} from "../../../types/aiChat/imageGeneration";
import type { Base64PayloadDecodeResult } from "../../../types/aiChat/payload";
import { decodeBase64Payload } from "./base64Payload";

/** 核对字节流起始签名是否与声明的图片 MIME 一致。 */
function hasExpectedImageSignature(bytes: Uint8Array, mimeType: GeneratedChatImage["mimeType"]): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value: number, index: number): boolean => bytes[index] === value);
  }
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** 按生图编码与解码大小上限执行 base64 解码。 */
function decodeCheckedBytes(encoded: string): Base64PayloadDecodeResult {
  return decodeBase64Payload({
    encoded,
    maxEncodedChars: IMAGE_GENERATION_MAX_ENCODED_CHARS,
    maxBytes: IMAGE_GENERATION_MAX_BYTES,
  });
}

/**
 * 解码并校验带声明 MIME 的生图 base64 载荷；任一校验未通过时返回 null。
 */
export function decodeGeneratedImage(encoded: string, mimeType: string | undefined): GeneratedChatImage | null {
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") return null;
  const checked: Base64PayloadDecodeResult = decodeCheckedBytes(encoded);
  if (!checked.ok || !hasExpectedImageSignature(checked.bytes, mimeType)) return null;
  return { bytes: checked.bytes, mimeType };
}

/**
 * 解码无声明 MIME 的生图 base64 载荷并按字节签名识别图片类型。
 */
export function decodeGeneratedImageBySignature(encoded: string): GeneratedImageDecodeResult {
  const checked: Base64PayloadDecodeResult = decodeCheckedBytes(encoded);
  if (!checked.ok) return checked;
  if (hasExpectedImageSignature(checked.bytes, "image/png")) {
    return { ok: true, image: { bytes: checked.bytes, mimeType: "image/png" } };
  }
  if (hasExpectedImageSignature(checked.bytes, "image/jpeg")) {
    return { ok: true, image: { bytes: checked.bytes, mimeType: "image/jpeg" } };
  }
  return { ok: false, reason: "byte signature matches neither PNG nor JPEG" };
}
