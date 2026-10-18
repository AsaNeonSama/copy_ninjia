/**
 * xAI 语音合成协议实现：调用 `/tts` 端点并将返回的音频体解码为语音载荷。
 */

import { MP3_MIME_TYPE } from "../../consts/audio";
import {
  OPENAI_SPEECH_REQUEST_ATTEMPTS,
  OPENAI_SPEECH_REQUEST_TIMEOUT_MS,
  XAI_API_BASE_URL,
  XAI_SPEECH_BIT_RATE,
  XAI_SPEECH_CODEC,
  XAI_SPEECH_ENDPOINT_PATH,
  XAI_SPEECH_ERROR_BODY_MAX_BYTES,
  XAI_SPEECH_ERROR_LABEL,
  XAI_SPEECH_RETRY_BASE_DELAY_MS,
  XAI_SPEECH_SAMPLE_RATE,
} from "../../consts/aiChat/openai";
import { warnAiUsageUnavailable } from "../../infra/aiCacheUsage";
import { signalWithTimeout } from "../../libs/abortSignal";
import { discardResponseBody, readBoundedResponseText } from "../../libs/boundedResponse";
import { sleep } from "../../libs/sleep";
import { readSpeechBody, speechFromDecoded, speechRequestFailed } from "../ai/utils/speechPayload";
import type { AiSpeechRequest } from "../../types/aiChat/provider";
import type { SynthesizedSpeech, SynthesizedSpeechDecodeResult } from "../../types/aiChat/voiceMessage";
import type { XAiAgentTtsCapabilityConfig } from "../../types/config";

/** 根据 `baseUrl`（缺省取 `XAI_API_BASE_URL`）解析 `/tts` 端点 URL。 */
function xAiSpeechUrl(baseUrl: string | undefined): URL {
  const base: string = baseUrl ?? XAI_API_BASE_URL;
  return new URL(XAI_SPEECH_ENDPOINT_PATH, base.endsWith("/") ? base : `${base}/`);
}

/** 判断 HTTP 状态码是否属于可重试的瞬时故障。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 计算第 `attempt` 次失败后的指数退避时长。 */
function retryDelayMs(attempt: number): number {
  return XAI_SPEECH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

/** 将非成功 HTTP 响应封装为带状态码与有界响应体的 Error。 */
async function httpStatusError(response: Response): Promise<Error> {
  const detail: string | null = await readBoundedResponseText(response, XAI_SPEECH_ERROR_BODY_MAX_BYTES);
  return new Error(`HTTP ${response.status}: ${detail ?? `error body exceeds ${XAI_SPEECH_ERROR_BODY_MAX_BYTES} bytes`}`);
}

/** 发送 `/tts` 请求并在可重试故障下按指数退避重试，直至返回成功响应或抛错。 */
async function requestXAiSpeech(
  tts: XAiAgentTtsCapabilityConfig,
  text: string,
  signal: AbortSignal
): Promise<Response> {
  const url: URL = xAiSpeechUrl(tts.baseUrl);
  const body: string = JSON.stringify({
    text,
    voice_id: tts.voice,
    language: tts.language,
    output_format: { codec: XAI_SPEECH_CODEC, sample_rate: XAI_SPEECH_SAMPLE_RATE, bit_rate: XAI_SPEECH_BIT_RATE },
  });
  for (let attempt: number = 1; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${tts.apiKey}`, "content-type": "application/json" },
        body,
        redirect: "manual",
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted || attempt >= OPENAI_SPEECH_REQUEST_ATTEMPTS) throw error;
      await sleep(retryDelayMs(attempt), signal);
      continue;
    }
    if (response.ok) return response;
    if (!isRetryableStatus(response.status) || attempt >= OPENAI_SPEECH_REQUEST_ATTEMPTS) {
      throw await httpStatusError(response);
    }
    await discardResponseBody(response);
    await sleep(retryDelayMs(attempt), signal);
  }
}

/** 按 `xai` 协议将一句台词合成为语音；请求失败或响应体无效时返回 null。 */
export async function synthesizeXAiSpeech(
  tts: XAiAgentTtsCapabilityConfig,
  { text, signal }: AiSpeechRequest
): Promise<SynthesizedSpeech | null> {
  const requestSignal: AbortSignal = signalWithTimeout(signal, OPENAI_SPEECH_REQUEST_TIMEOUT_MS);
  let decoded: SynthesizedSpeechDecodeResult;
  try {
    const response: Response = await requestXAiSpeech(tts, text, requestSignal);
    warnAiUsageUnavailable("tts", "openai", "missing");
    decoded = await readSpeechBody(response, MP3_MIME_TYPE);
  } catch (error: unknown) {
    return speechRequestFailed(XAI_SPEECH_ERROR_LABEL, signal, error);
  }
  return speechFromDecoded(XAI_SPEECH_ERROR_LABEL, decoded);
}
