/**
 * 语音合成响应载荷的解码、有界流式读取与失败日志收尾。
 */

import {
  VOICE_SPEECH_MAX_BYTES,
  VOICE_SPEECH_MAX_ENCODED_CHARS,
} from "../../../consts/aiChat/voiceMessage";
import { logger } from "../../../infra/logger";
import { readBoundedResponseBytes } from "../../../libs/boundedResponse";
import type { BoundedResponseResult } from "../../../libs/boundedResponse";
import type { Base64PayloadDecodeResult } from "../../../types/aiChat/payload";
import type { SynthesizedSpeech, SynthesizedSpeechDecodeResult } from "../../../types/aiChat/voiceMessage";
import { decodeBase64Payload } from "./base64Payload";

/**
 * 校验音频 MIME 前缀并按语音大小上限解码 base64 音频载荷。
 * @param encoded 待解码的 base64 音频字符串。
 * @param mimeType 供应商声明的音频 MIME 类型。
 * @returns 解码后的合成音频载荷或带原因的失败结果。
 */
export function decodeSynthesizedSpeech(
  encoded: string,
  mimeType: string | undefined
): SynthesizedSpeechDecodeResult {
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/")) {
    return { ok: false, reason: "missing audio mime type" };
  }
  const decoded: Base64PayloadDecodeResult = decodeBase64Payload({
    encoded,
    maxEncodedChars: VOICE_SPEECH_MAX_ENCODED_CHARS,
    maxBytes: VOICE_SPEECH_MAX_BYTES,
  });
  if (!decoded.ok) return decoded;
  return { ok: true, speech: { bytes: decoded.bytes, mimeType } };
}

/**
 * 按 VOICE_SPEECH_MAX_BYTES 上限流式读取二进制音频响应体并绑定指定 MIME。
 * @param response 供应商返回的 HTTP 响应对象。
 * @param mimeType 音频容器 MIME 类型。
 * @returns 读取完成的合成音频载荷或超限失败结果。
 */
export async function readSpeechBody(response: Response, mimeType: string): Promise<SynthesizedSpeechDecodeResult> {
  const body: BoundedResponseResult = await readBoundedResponseBytes(response, VOICE_SPEECH_MAX_BYTES);
  if (!body.ok) return { ok: false, reason: "audio body exceeds the size limit" };
  return { ok: true, speech: { bytes: body.bytes, mimeType } };
}

/**
 * 合成请求失败收尾：未中止时记录错误日志，恒返回 null。
 * @param label 供应商请求诊断标签。
 * @param signal 可选取消信号。
 * @param error 捕获到的未知错误。
 * @returns 恒为 null。
 */
export function speechRequestFailed(label: string, signal: AbortSignal | undefined, error: unknown): null {
  if (signal?.aborted !== true) logger.error(`Error calling ${label}:`, error);
  return null;
}

/**
 * 载荷解码结果收尾：成功时返回音频对象，不可用时记录错误日志并返回 null。
 * @param label 供应商请求诊断标签。
 * @param decoded 合成音频载荷解码结果。
 * @returns 合成音频对象；解码失败时返回 null。
 */
export function speechFromDecoded(label: string, decoded: SynthesizedSpeechDecodeResult): SynthesizedSpeech | null {
  if (decoded.ok) return decoded.speech;
  logger.error(`${label} returned an unusable audio payload: ${decoded.reason}.`);
  return null;
}
