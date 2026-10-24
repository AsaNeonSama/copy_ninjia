/**
 * OGG/Opus 与 MP3 语音容器的结构校验与整秒时长计算。
 */

import {
  ID3V1_MAGIC,
  ID3V1_TAG_BYTES,
  ID3V2_FOOTER_FLAG,
  ID3V2_HEADER_BYTES,
  ID3V2_MAGIC,
  MP3_FRAME_HEADER_BYTES,
  MP3_MPEG1_BITRATES_KBPS,
  MP3_MPEG1_SAMPLE_RATES,
  MP3_MPEG1_SAMPLES_PER_FRAME,
  MP3_MPEG2_BITRATES_KBPS,
  MP3_MPEG2_SAMPLE_RATES,
  MP3_MPEG2_SAMPLES_PER_FRAME,
  MP3_MPEG25_SAMPLE_RATES,
  OGG_CAPTURE_PATTERN,
  OGG_GRANULE_UNSET_WORD,
  OGG_PAGE_HEADER_BYTES,
  OPUS_GRANULE_RATE,
  OPUS_HEAD_MAGIC,
  OPUS_HEAD_MIN_BYTES,
} from "../../../consts/audio";
import type { VoiceContainerProbeResult } from "../../../types/aiChat/voiceMessage";

/**
 * 判断 bytes 在 offset 处是否匹配给定 ASCII 串；越界时返回 false。
 * @param bytes 待检测的字节流。
 * @param offset 起始字节偏移。
 * @param text 期望匹配的 ASCII 字符串。
 * @returns 匹配时返回 true，越界或字节不符时返回 false。
 */
function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.byteLength) return false;
  for (let index: number = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * 校验单路 OGG/Opus 页序列与 OpusHead 头，并按末个有效 granule position 与 pre-skip 计算向上取整的秒数。
 * @param bytes OGG/Opus 音频容器字节流。
 * @returns 探测成功时返回向上取整的秒数，结构非法时返回失败原因。
 */
export function probeOggOpus(bytes: Uint8Array): VoiceContainerProbeResult {
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset: number = 0;
  let preSkip: number = -1;
  let granule: number = -1;
  while (offset < bytes.byteLength) {
    if (offset + OGG_PAGE_HEADER_BYTES > bytes.byteLength) return { ok: false, reason: "truncated Ogg page" };
    if (!hasAscii(bytes, offset, OGG_CAPTURE_PATTERN)) return { ok: false, reason: "not an Ogg Opus stream" };
    const segments: number = bytes[offset + OGG_PAGE_HEADER_BYTES - 1]!;
    const bodyStart: number = offset + OGG_PAGE_HEADER_BYTES + segments;
    if (bodyStart > bytes.byteLength) return { ok: false, reason: "truncated Ogg page" };
    let bodyLength: number = 0;
    for (let index: number = 0; index < segments; index++) bodyLength += bytes[offset + OGG_PAGE_HEADER_BYTES + index]!;
    if (bodyStart + bodyLength > bytes.byteLength) return { ok: false, reason: "truncated Ogg page" };
    if (preSkip === -1) {
      if (bodyLength < OPUS_HEAD_MIN_BYTES || !hasAscii(bytes, bodyStart, OPUS_HEAD_MAGIC)) {
        return { ok: false, reason: "not an Ogg Opus stream" };
      }
      preSkip = view.getUint16(bodyStart + OPUS_HEAD_MAGIC.length + 2, true);
    }
    const granuleLow: number = view.getUint32(offset + 6, true);
    const granuleHigh: number = view.getUint32(offset + 10, true);
    if (granuleLow !== OGG_GRANULE_UNSET_WORD || granuleHigh !== OGG_GRANULE_UNSET_WORD) {
      if (granuleHigh !== 0) return { ok: false, reason: "invalid Ogg granule position" };
      granule = granuleLow;
    }
    offset = bodyStart + bodyLength;
  }
  if (preSkip === -1) return { ok: false, reason: "not an Ogg Opus stream" };
  if (granule <= preSkip) return { ok: false, reason: "invalid Ogg granule position" };
  return { ok: true, durationSeconds: Math.ceil((granule - preSkip) / OPUS_GRANULE_RATE) };
}

/**
 * 计算开头可选 ID3v2 标签之后的首字节偏移；标签长度字段非法时返回负值。
 * @param bytes MP3 音频字节流。
 * @returns ID3v2 标签结束后的首字节偏移（无标签时为 0）；标签头部或 synchsafe 长度非法时返回 -1。
 */
function id3v2End(bytes: Uint8Array): number {
  if (!hasAscii(bytes, 0, ID3V2_MAGIC)) return 0;
  if (bytes.byteLength < ID3V2_HEADER_BYTES) return -1;
  let size: number = 0;
  for (let index: number = 6; index < ID3V2_HEADER_BYTES; index++) {
    const byte: number = bytes[index]!;
    if (byte >= 0x80) return -1;
    size = size * 0x80 + byte;
  }
  const footer: number = (bytes[5]! & ID3V2_FOOTER_FLAG) === 0 ? 0 : ID3V2_HEADER_BYTES;
  return ID3V2_HEADER_BYTES + size + footer;
}

/**
 * 校验 MPEG Layer III 帧序列并按总样本数与采样率计算向上取整的秒数。
 * @param bytes MP3 音频容器字节流。
 * @returns 探测成功时返回向上取整的秒数，结构非法时返回失败原因。
 */
export function probeMp3(bytes: Uint8Array): VoiceContainerProbeResult {
  let offset: number = id3v2End(bytes);
  if (offset === -1) return { ok: false, reason: "not an MP3 stream" };
  let samples: number = 0;
  let sampleRate: number = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset === ID3V1_TAG_BYTES && hasAscii(bytes, offset, ID3V1_MAGIC)) break;
    if (offset + MP3_FRAME_HEADER_BYTES > bytes.byteLength) return { ok: false, reason: "truncated MP3 frame" };
    const second: number = bytes[offset + 1]!;
    const third: number = bytes[offset + 2]!;
    const version: number = (second >> 3) & 0b11;
    const bitrateIndex: number = third >> 4;
    const rateIndex: number = (third >> 2) & 0b11;
    if (
      bytes[offset] !== 0xFF || (second & 0xE0) !== 0xE0 ||
      version === 0b01 || ((second >> 1) & 0b11) !== 0b01 ||
      bitrateIndex === 0 || bitrateIndex === 0b1111 || rateIndex === 0b11
    ) {
      return { ok: false, reason: "not an MP3 stream" };
    }
    const mpeg1: boolean = version === 0b11;
    const kbps: number = (mpeg1 ? MP3_MPEG1_BITRATES_KBPS : MP3_MPEG2_BITRATES_KBPS)[bitrateIndex]!;
    const rate: number = (mpeg1 ? MP3_MPEG1_SAMPLE_RATES : version === 0b10 ? MP3_MPEG2_SAMPLE_RATES : MP3_MPEG25_SAMPLE_RATES)[rateIndex]!;
    if (sampleRate !== 0 && rate !== sampleRate) return { ok: false, reason: "not an MP3 stream" };
    sampleRate = rate;
    const frameSamples: number = mpeg1 ? MP3_MPEG1_SAMPLES_PER_FRAME : MP3_MPEG2_SAMPLES_PER_FRAME;
    const frameLength: number = Math.floor(frameSamples / 8 * kbps * 1_000 / rate) + ((third >> 1) & 1);
    if (offset + frameLength > bytes.byteLength) return { ok: false, reason: "truncated MP3 frame" };
    samples += frameSamples;
    offset += frameLength;
  }
  if (samples === 0) return { ok: false, reason: "not an MP3 stream" };
  return { ok: true, durationSeconds: Math.ceil(samples / sampleRate) };
}
