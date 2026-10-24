/**
 * Gemini 语音合成实现：通过 Interactions API 调用 TTS 模型生成音频并上报用量。
 */

import type { GoogleGenAI, Interactions } from "@google/genai";
import {
  GEMINI_SPEECH_ERROR_LABEL,
  GEMINI_SPEECH_REQUEST_ATTEMPTS,
  GEMINI_SPEECH_REQUEST_TIMEOUT_MS,
  GEMINI_SPEECH_TEMPERATURE,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { reportGeminiInteractionUsage } from "../../infra/aiCacheUsage";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { decodeSynthesizedSpeech, speechFromDecoded, speechRequestFailed } from "../ai/utils/speechPayload";
import { composeSpeechStyle } from "../ai/utils/speechStyle";
import { getGeminiClient } from "./client";
import type { AiSpeechRequest } from "../../types/aiChat/provider";
import type { SynthesizedSpeech } from "../../types/aiChat/voiceMessage";
import type { AgentTtsCapabilityConfig } from "../../types/config";

/** 语音合成的 `generation_config` 结构。 */
interface SpeechGenerationConfig {
  readonly speech_config: readonly { readonly voice: string }[];
  readonly temperature: number;
}

/**
 * 构造携带指定音色与采样温度的 `generation_config`。
 * @param voice 部署配置指定的预置音色名称。
 * @returns Interactions API 所需的 `GenerationConfig` 对象。
 */
function speechGenerationConfig(voice: string): Interactions.GenerationConfig {
  const config: SpeechGenerationConfig = {
    speech_config: [{ voice }],
    temperature: GEMINI_SPEECH_TEMPERATURE,
  };
  return config as unknown as Interactions.GenerationConfig;
}

/** `interactions.create` 返回的音频载荷与用量信息。 */
interface SpeechInteractionOutput {
  readonly output_audio?: { readonly data?: string | undefined; readonly mime_type?: string | undefined } | undefined;
  readonly usage?: Interactions.Usage | undefined;
}

/**
 * 构造携带台词与朗读风格注解的文本块。
 * @param text 待朗读的台词正文。
 * @param style 拼接后的朗读风格指令。
 * @returns 带 `speech_metadata` 注解的 Interactions 文本块。
 */
function speechTextContent(text: string, style: string): Interactions.TextContent {
  return { type: "text", text, annotations: [{ type: "speech_metadata", style }] };
}

/**
 * 将一句台词合成为语音；无可用音频载荷时返回 null。
 * @param request 语音合成请求参数，包含台词正文、语言风格、语气与取消信号。
 * @returns 合成并封装后的语音字节载荷；失败或无音频输出时返回 `null`。
 */
export async function synthesizeGeminiSpeech({
  text,
  languageStyle,
  tone,
  signal,
}: AiSpeechRequest): Promise<SynthesizedSpeech | null> {
  let interaction: SpeechInteractionOutput;
  const requestSignal: AbortSignal = signalWithTimeout(signal, GEMINI_SPEECH_REQUEST_TIMEOUT_MS);
  try {
    requestSignal.throwIfAborted();
    const client: GoogleGenAI = getGeminiClient("tts");
    const tts: AgentTtsCapabilityConfig | undefined = getAgentDeploymentConfig().tts;
    if (tts?.provider !== "google") throw new Error('Agent capability "tts" is not configured for the Google provider.');
    interaction = await raceAbortOrThrow(
      client.interactions.create(
        {
          model: tts.model,
          input: [{
            type: "user_input",
            content: [speechTextContent(text, composeSpeechStyle(tts.style, languageStyle, tone))],
          }],
          response_format: { type: "audio" },
          generation_config: speechGenerationConfig(tts.voice),
        },
        {
          timeout: GEMINI_SPEECH_REQUEST_TIMEOUT_MS,
          maxRetries: GEMINI_SPEECH_REQUEST_ATTEMPTS - 1,
          signal: requestSignal,
        }
      ).then((response: SpeechInteractionOutput): SpeechInteractionOutput => {
        reportGeminiInteractionUsage({ capability: "tts", model: tts.model, usage: response.usage });
        return response;
      }),
      requestSignal
    );
  } catch (error: unknown) {
    return speechRequestFailed(GEMINI_SPEECH_ERROR_LABEL, signal, error);
  }

  const encoded: string | undefined = interaction.output_audio?.data;
  if (encoded === undefined) {
    logger.error(`${GEMINI_SPEECH_ERROR_LABEL} returned no audio payload.`);
    return null;
  }
  return speechFromDecoded(
    GEMINI_SPEECH_ERROR_LABEL,
    decodeSynthesizedSpeech(encoded, interaction.output_audio?.mime_type)
  );
}
