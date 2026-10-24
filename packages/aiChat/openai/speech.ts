/**
 * OpenAI 供应商的语音合成入口：按 `agent.tts.speech_protocol` 分派到 OpenAI `audio/speech` 或 xAI `/tts`。
 */

import { OGG_OPUS_MIME_TYPE } from "../../consts/audio";
import {
  OPENAI_SPEECH_ERROR_LABEL,
  OPENAI_SPEECH_REQUEST_ATTEMPTS,
  OPENAI_SPEECH_REQUEST_TIMEOUT_MS,
  OPENAI_SPEECH_RESPONSE_FORMAT,
} from "../../consts/aiChat/openai";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { warnAiUsageUnavailable } from "../../infra/aiCacheUsage";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { readSpeechBody, speechFromDecoded, speechRequestFailed } from "../ai/utils/speechPayload";
import { composeSpeechStyle } from "../ai/utils/speechStyle";
import { getOpenAiClient } from "./client";
import { synthesizeXAiSpeech } from "./xaiSpeech";
import type { AiSpeechRequest } from "../../types/aiChat/provider";
import type { SynthesizedSpeech, SynthesizedSpeechDecodeResult } from "../../types/aiChat/voiceMessage";
import type {
  AgentTtsCapabilityConfig,
  OpenAiAgentTtsCapabilityConfig,
  OpenAiSpeechProtocol,
  XAiAgentTtsCapabilityConfig,
} from "../../types/config";

/**
 * 按 `openai` 协议调用 `audio/speech` 将台词合成为语音。
 * @param tts OpenAI 原生语音合成能力配置。
 * @param request 语音合成请求参数，包含台词正文、语言风格、语气与取消信号。
 * @returns 解码并封装后的语音字节载荷；失败或无有效音频时返回 `null`。
 */
async function synthesizeAudioSpeech(
  tts: OpenAiAgentTtsCapabilityConfig,
  { text, languageStyle, tone, signal }: AiSpeechRequest
): Promise<SynthesizedSpeech | null> {
  const requestSignal: AbortSignal = signalWithTimeout(signal, OPENAI_SPEECH_REQUEST_TIMEOUT_MS);
  let decoded: SynthesizedSpeechDecodeResult;
  try {
    requestSignal.throwIfAborted();
    const response: Response = await raceAbortOrThrow(
      getOpenAiClient("tts").audio.speech.create(
        {
          model: tts.model,
          voice: tts.voice,
          input: text,
          instructions: composeSpeechStyle(tts.style, languageStyle, tone),
          response_format: OPENAI_SPEECH_RESPONSE_FORMAT,
        },
        {
          signal: requestSignal,
          timeout: OPENAI_SPEECH_REQUEST_TIMEOUT_MS,
          maxRetries: OPENAI_SPEECH_REQUEST_ATTEMPTS - 1,
        }
      ).then((response: Response): Response => {
        warnAiUsageUnavailable("tts", "openai", "missing");
        return response;
      }),
      requestSignal
    );
    decoded = await readSpeechBody(response, OGG_OPUS_MIME_TYPE);
  } catch (error: unknown) {
    return speechRequestFailed(OPENAI_SPEECH_ERROR_LABEL, signal, error);
  }
  return speechFromDecoded(OPENAI_SPEECH_ERROR_LABEL, decoded);
}

/**
 * 读取当前 `tts` 配置快照；未配置为 `openai` 供应商时记录错误日志并返回 null。
 * @returns OpenAI 或 xAI 协议的 `tts` 能力配置；未配置或非 `openai` 供应商时返回 `null`。
 */
function openAiTtsConfig(): OpenAiAgentTtsCapabilityConfig | XAiAgentTtsCapabilityConfig | null {
  let config: AgentTtsCapabilityConfig | undefined;
  try {
    config = getAgentDeploymentConfig().tts;
  } catch (error: unknown) {
    logger.error(`Error calling ${OPENAI_SPEECH_ERROR_LABEL}:`, error);
    return null;
  }
  if (config?.provider === "openai") return config;
  logger.error(`Error calling ${OPENAI_SPEECH_ERROR_LABEL}: agent capability "tts" is not configured for the OpenAI provider.`);
  return null;
}

/**
 * 将一句台词合成为语音；配置不可用、请求失败或无可用载荷时返回 null。
 * @param request 语音合成请求参数。
 * @returns 合成后的语音字节载荷；失败或不可用时返回 `null`。
 */
export async function synthesizeOpenAiSpeech(request: AiSpeechRequest): Promise<SynthesizedSpeech | null> {
  const tts: OpenAiAgentTtsCapabilityConfig | XAiAgentTtsCapabilityConfig | null = openAiTtsConfig();
  if (tts === null) return null;
  const protocol: OpenAiSpeechProtocol = tts.speechProtocol;
  switch (tts.speechProtocol) {
    case "openai": return synthesizeAudioSpeech(tts, request);
    case "xai": return synthesizeXAiSpeech(tts, request);
    default: {
      const unhandledConfig: never = tts;
      void unhandledConfig;
      logger.error(`Unsupported OpenAI speech protocol: ${String(protocol)}.`);
      return null;
    }
  }
}
