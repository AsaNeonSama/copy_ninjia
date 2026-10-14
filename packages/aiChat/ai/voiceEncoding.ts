/**
 * 将供应商合成的语音转换为 Telegram sendVoice 可用的音频容器：
 * OGG/Opus 与 MP3 校验容器结构并计算时长后直接封装，WAV 解析为单声道 PCM 后分块编码为 OGG/Opus。
 */

import opus from "@audio/encode-opus";
import type { StreamEncoder } from "@audio/encode-opus";
import { MP3_MIME_TYPE, OGG_OPUS_MIME_TYPE, WAV_MIME_TYPES } from "../../consts/audio";
import { logger } from "../../infra/logger";
import {
  VOICE_MP3_FILE_NAME,
  VOICE_OGG_FILE_NAME,
  VOICE_OPUS_APPLICATION,
  VOICE_OPUS_BITRATE_KBPS,
  VOICE_OPUS_COMPLEXITY,
  VOICE_OPUS_ENCODE_CHUNK_SECONDS,
} from "../../consts/aiChat/voiceMessage";
import { probeMp3, probeOggOpus } from "./utils/voiceContainer";
import { decodeWavPcm } from "./utils/wavPcm";
import type {
  SynthesizedSpeech,
  VoiceContainerProbeResult,
  VoiceEncodeResult,
  WavPcmDecodeResult,
} from "../../types/aiChat/voiceMessage";

/** 剥离 MIME 参数并转为小写类型本体。 */
function mimeEssence(mimeType: string): string {
  const separator: number = mimeType.indexOf(";");
  return (separator === -1 ? mimeType : mimeType.slice(0, separator)).trim().toLowerCase();
}

/**
 * 将已通过容器探测的直发音频复制为独占字节缓冲并附上时长与文件名。
 */
function directVoice(bytes: Uint8Array, probe: VoiceContainerProbeResult, fileName: string): VoiceEncodeResult {
  if (!probe.ok) return probe;
  return { ok: true, voice: { bytes: bytes.slice(), durationSeconds: probe.durationSeconds, fileName } };
}

/**
 * 按 VOICE_OPUS_ENCODE_CHUNK_SECONDS 分块将单声道 PCM 编码为 OGG 页，块间让出事件循环。
 */
async function encodePcmInChunks(
  encoder: StreamEncoder,
  samples: Float32Array,
  sampleRate: number
): Promise<Uint8Array[]> {
  const step: number = Math.max(1, Math.round(sampleRate * VOICE_OPUS_ENCODE_CHUNK_SECONDS));
  const pages: Uint8Array[] = [];
  for (let start: number = 0; start < samples.length; start += step) {
    pages.push(encoder.encode([samples.subarray(start, Math.min(samples.length, start + step))]));
    await Bun.sleep(0);
  }
  return pages;
}

/**
 * 将合成语音校验或编码为 Telegram 语音消息载荷。
 */
export async function encodeVoiceMessage(speech: SynthesizedSpeech): Promise<VoiceEncodeResult> {
  const mimeType: string = mimeEssence(speech.mimeType);
  if (mimeType === OGG_OPUS_MIME_TYPE) return directVoice(speech.bytes, probeOggOpus(speech.bytes), VOICE_OGG_FILE_NAME);
  if (mimeType === MP3_MIME_TYPE) return directVoice(speech.bytes, probeMp3(speech.bytes), VOICE_MP3_FILE_NAME);
  if (!WAV_MIME_TYPES.includes(mimeType)) return { ok: false, reason: "unsupported speech mime type" };
  const pcm: WavPcmDecodeResult = decodeWavPcm(speech.bytes);
  if (!pcm.ok) return pcm;
  let pages: Uint8Array[];
  try {
    const encoder: StreamEncoder = await opus({
      sampleRate: pcm.sampleRate,
      channels: 1,
      bitrate: VOICE_OPUS_BITRATE_KBPS,
      application: VOICE_OPUS_APPLICATION,
      complexity: VOICE_OPUS_COMPLEXITY,
    });
    try {
      pages = await encodePcmInChunks(encoder, pcm.samples, pcm.sampleRate);
      pages.push(encoder.flush());
    } finally {
      encoder.free();
    }
  } catch (error: unknown) {
    logger.error("Voice message Opus encoding failed:", error);
    return { ok: false, reason: "opus encoder failed" };
  }
  const bytes: Uint8Array<ArrayBuffer> = Bun.concatArrayBuffers(pages, Number.POSITIVE_INFINITY, true);
  return {
    ok: true,
    voice: {
      bytes,
      durationSeconds: Math.ceil(pcm.samples.length / pcm.sampleRate),
      fileName: VOICE_OGG_FILE_NAME,
    },
  };
}
