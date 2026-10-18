/**
 * 语音编码：WAV → OGG/Opus 用真实 libopus WASM 编码，核对 OGG 页结构、OpusHead 声明的
 * 原始输入采样率与收尾页的 granule 时长，分块编码的各页内容与整段一次编码逐字节相同，块间
 * 让出事件循环；OGG/Opus 与 MP3 校验后原样透传（独占字节副本、时长、
 * 文件名）；不支持的 MIME、WAV 解析与容器校验失败原样带回原因；编码器抛错时记原始错误并
 * 归一成失败原因；编码器初始化或块间让出期间 signal 中止时不再编码剩余块并返回 aborted。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { mp3Frames } from "../../helpers/mp3";
import { sineWav, wav } from "../../helpers/wav";
import type { VoiceEncodeResult } from "../../../packages/types/aiChat/voiceMessage";
import type opus from "@audio/encode-opus";
import { OPUS_HEAD_MAGIC } from "../../../packages/consts/audio";

const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { encodeVoiceMessage } = await import("../../../packages/aiChat/ai/voiceEncoding");
const { decodeWavPcm } = await import("../../../packages/aiChat/ai/utils/wavPcm");
const {
  VOICE_MP3_FILE_NAME,
  VOICE_OGG_FILE_NAME,
  VOICE_OPUS_APPLICATION,
  VOICE_OPUS_BITRATE_KBPS,
  VOICE_OPUS_COMPLEXITY,
  VOICE_OPUS_ENCODE_CHUNK_SECONDS,
} = await import("../../../packages/consts/aiChat/voiceMessage");
const { MP3_MIME_TYPE, OGG_OPUS_MIME_TYPE } = await import("../../../packages/consts/audio");

interface OggPage {
  readonly headerType: number;
  readonly granule: bigint;
  readonly body: Uint8Array;
}

function oggPages(bytes: Uint8Array): OggPage[] {
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages: OggPage[] = [];
  let offset: number = 0;
  while (offset < bytes.byteLength) {
    expect(new TextDecoder().decode(bytes.subarray(offset, offset + 4))).toBe("OggS");
    const segments: number = bytes[offset + 26]!;
    let length: number = 0;
    for (let index: number = 0; index < segments; index++) length += bytes[offset + 27 + index]!;
    const bodyStart: number = offset + 27 + segments;
    pages.push({
      headerType: bytes[offset + 5]!,
      granule: view.getBigInt64(offset + 6, true),
      body: bytes.subarray(bodyStart, bodyStart + length),
    });
    offset = bodyStart + length;
  }
  return pages;
}

beforeEach(() => {
  loggerError.mockClear();
});

describe("encodeVoiceMessage", () => {
  test("WAV 编码成 OGG/Opus：首页 OpusHead 带原始采样率、末页 EOS，granule 对应原始时长", async () => {
    const sampleRate: number = 24_000;
    const result: VoiceEncodeResult = await encodeVoiceMessage({
      bytes: sineWav(sampleRate, 1.5),
      mimeType: "audio/wav",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voice.durationSeconds).toBe(2);

    const pages: OggPage[] = oggPages(result.voice.bytes);
    const head: Uint8Array = pages[0]!.body;
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe(OPUS_HEAD_MAGIC);
    expect(head[9]).toBe(1);
    const headView: DataView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(headView.getUint32(12, true)).toBe(sampleRate);
    expect(new TextDecoder().decode(pages[1]!.body.subarray(0, 8))).toBe("OpusTags");

    const last: OggPage = pages.at(-1)!;
    expect(last.headerType & 0x04).toBe(0x04);
    const preSkip: number = headView.getUint16(10, true);
    expect(Number(last.granule) - preSkip).toBe(1.5 * 48_000);
  });

  test.each([24_000, 22_050, 16_000, 48_000])(
    "%i Hz 分块编码的各页内容与整段一次编码逐字节相同",
    async (sampleRate: number) => {
      const bytes: Uint8Array = sineWav(sampleRate, VOICE_OPUS_ENCODE_CHUNK_SECONDS * 3.3);
      const pcm = decodeWavPcm(bytes);
      if (!pcm.ok) throw new Error(pcm.reason);
      // 整段一次交给依赖作为对照；页头的流序列号每个编码器随机，只比 granule、页类型与页内容。
      const realOpus: typeof opus = (await import("@audio/encode-opus")).default;
      const encoder = await realOpus({
        sampleRate,
        channels: 1,
        bitrate: VOICE_OPUS_BITRATE_KBPS,
        application: VOICE_OPUS_APPLICATION,
        complexity: VOICE_OPUS_COMPLEXITY,
      });
      const whole: Uint8Array = encoder.encode([pcm.samples]);
      const tail: Uint8Array = encoder.flush();
      encoder.free();
      const reference: Uint8Array = new Uint8Array(whole.byteLength + tail.byteLength);
      reference.set(whole);
      reference.set(tail, whole.byteLength);

      const result: VoiceEncodeResult = await encodeVoiceMessage({ bytes, mimeType: "audio/wav" });
      if (!result.ok) throw new Error(result.reason);

      const pageContents = (pages: OggPage[]): readonly [bigint, number, Uint8Array][] =>
        pages.map((page: OggPage): [bigint, number, Uint8Array] => [page.granule, page.headerType, page.body]);
      expect(pageContents(oggPages(result.voice.bytes))).toEqual(pageContents(oggPages(reference)));
    }
  );

  test("多块编码期间让出事件循环", async () => {
    const order: string[] = [];
    setImmediate((): void => {
      order.push("immediate");
    });
    const encoding: Promise<VoiceEncodeResult> = encodeVoiceMessage({
      bytes: sineWav(24_000, VOICE_OPUS_ENCODE_CHUNK_SECONDS * 3),
      mimeType: "audio/wav",
    }).then((result: VoiceEncodeResult): VoiceEncodeResult => {
      order.push("encoded");
      return result;
    });
    expect((await encoding).ok).toBe(true);
    expect(order).toEqual(["immediate", "encoded"]);
  });

  test("MIME 带参数与大小写差异时按类型本体判定", async () => {
    const result: VoiceEncodeResult = await encodeVoiceMessage({
      bytes: sineWav(16_000, 0.2),
      mimeType: "Audio/X-WAV; codec=pcm",
    });
    expect(result.ok && result.voice.durationSeconds).toBe(1);
  });

  test("WAV 编码结果带 OGG 文件名", async () => {
    const result: VoiceEncodeResult = await encodeVoiceMessage({ bytes: sineWav(24_000, 0.2), mimeType: "audio/wav" });
    expect(result.ok && result.voice.fileName).toBe(VOICE_OGG_FILE_NAME);
  });

  test("OGG/Opus 校验后原样透传：独占字节副本、granule 时长与 OGG 文件名", async () => {
    const encoded: VoiceEncodeResult = await encodeVoiceMessage({ bytes: sineWav(24_000, 1.5), mimeType: "audio/wav" });
    if (!encoded.ok) throw new Error(encoded.reason);
    const padded: Uint8Array = new Uint8Array(encoded.voice.bytes.byteLength + 3);
    padded.set(encoded.voice.bytes, 3);
    const source: Uint8Array = padded.subarray(3);
    const result: VoiceEncodeResult = await encodeVoiceMessage({ bytes: source, mimeType: `${OGG_OPUS_MIME_TYPE}; codecs=opus` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voice.bytes).toEqual(encoded.voice.bytes);
    expect(result.voice.bytes.byteOffset).toBe(0);
    expect(result.voice.bytes.byteLength).toBe(result.voice.bytes.buffer.byteLength);
    expect(result.voice.durationSeconds).toBe(2);
    expect(result.voice.fileName).toBe(VOICE_OGG_FILE_NAME);
  });

  test("MP3 校验后原样透传，带 MP3 文件名", async () => {
    // 42 帧 × 576 / 24000 = 1.008 秒。
    const mp3: Uint8Array<ArrayBuffer> = mp3Frames(42);
    const result: VoiceEncodeResult = await encodeVoiceMessage({ bytes: mp3, mimeType: MP3_MIME_TYPE });
    expect(result).toEqual({ ok: true, voice: { bytes: mp3, durationSeconds: 2, fileName: VOICE_MP3_FILE_NAME } });
    expect(result.ok && result.voice.bytes.buffer).not.toBe(mp3.buffer);
  });

  test("OGG/Opus 与 MP3 容器校验失败带原因返回", async () => {
    await expect(encodeVoiceMessage({ bytes: sineWav(24_000, 0.1), mimeType: OGG_OPUS_MIME_TYPE }))
      .resolves.toEqual({ ok: false, reason: "not an Ogg Opus stream" });
    await expect(encodeVoiceMessage({ bytes: mp3Frames(2).subarray(1), mimeType: MP3_MIME_TYPE }))
      .resolves.toEqual({ ok: false, reason: "not an MP3 stream" });
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("非 WAV 容器与 WAV 解析失败带原因返回，不调用编码器", async () => {
    await expect(encodeVoiceMessage({ bytes: sineWav(24_000, 0.1), mimeType: "audio/mp3" }))
      .resolves.toEqual({ ok: false, reason: "unsupported speech mime type" });
    await expect(encodeVoiceMessage({ bytes: wav([]), mimeType: "audio/wav" }))
      .resolves.toEqual({ ok: false, reason: "missing fmt chunk" });
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe("encodeVoiceMessage 编码器失败", () => {
  test("编码器抛错时记原始错误并返回 opus encoder failed", async () => {
    // 模块命名空间是活绑定，mock 之后会跟着变；先取出真实函数值再替换。
    const realOpus: typeof opus = (await import("@audio/encode-opus")).default;
    const failure: Error = new Error("wasm trap");
    mock.module("@audio/encode-opus", () => ({
      default: async (): Promise<unknown> => {
        throw failure;
      },
    }));
    try {
      await expect(encodeVoiceMessage({ bytes: sineWav(24_000, 0.1), mimeType: "audio/wav" }))
        .resolves.toEqual({ ok: false, reason: "opus encoder failed" });
      expect(loggerError).toHaveBeenCalledWith("Voice message Opus encoding failed:", failure);
    } finally {
      // 恢复真实导出，随机顺序下其余用例仍走真实编码器。
      mock.module("@audio/encode-opus", () => ({ default: realOpus }));
    }
  });
});

describe("encodeVoiceMessage 取消", () => {
  /** 被测 WAV 的分块数：时长取 VOICE_OPUS_ENCODE_CHUNK_SECONDS 的 CHUNKS 倍。 */
  const CHUNKS: number = 3;

  /**
   * 用真实编码器包一层计数：abortAt 为 "create" 时编码器建好即中止，为数字时第 abortAt 块编码后中止；
   * 交回编码结果、实际编码块数与编码器是否已释放。
   */
  async function encodeAbortingAt(
    abortAt: "create" | number
  ): Promise<{ result: VoiceEncodeResult; encodedChunks: number; freed: boolean }> {
    const realOpus: typeof opus = (await import("@audio/encode-opus")).default;
    const controller: AbortController = new AbortController();
    let encodedChunks: number = 0;
    let freed: boolean = false;
    mock.module("@audio/encode-opus", () => ({
      default: async (options: Parameters<typeof opus>[0]) => {
        const encoder = await realOpus(options);
        if (abortAt === "create") controller.abort();
        return {
          encode: (channels: Float32Array[]): Uint8Array => {
            const page: Uint8Array = encoder.encode(channels);
            if (++encodedChunks === abortAt) controller.abort();
            return page;
          },
          flush: (): Uint8Array => encoder.flush(),
          free: (): void => {
            freed = true;
            encoder.free();
          },
        };
      },
    }));
    try {
      const result: VoiceEncodeResult = await encodeVoiceMessage(
        { bytes: sineWav(24_000, VOICE_OPUS_ENCODE_CHUNK_SECONDS * CHUNKS), mimeType: "audio/wav" },
        controller.signal
      );
      return { result, encodedChunks, freed };
    } finally {
      mock.module("@audio/encode-opus", () => ({ default: realOpus }));
    }
  }

  test.each([
    { when: "编码器初始化期间", abortAt: "create", encodedChunks: 0 },
    { when: "第 1 块编码后的让出期间", abortAt: 1, encodedChunks: 1 },
    { when: "最后一块编码后的让出期间", abortAt: CHUNKS, encodedChunks: CHUNKS },
  ] as const)("$when中止：不再编码剩余块、释放编码器并返回 aborted，不记错误", async ({ abortAt, encodedChunks }) => {
    expect(await encodeAbortingAt(abortAt)).toEqual({ result: { ok: false, reason: "aborted" }, encodedChunks, freed: true });
    expect(loggerError).not.toHaveBeenCalled();
  });
});
