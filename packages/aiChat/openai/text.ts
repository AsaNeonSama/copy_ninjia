/**
 * OpenAI 侧的纯文本生成、结构化 JSON 生成、视觉描述与语音转写。
 */

import OpenAI, { toFile } from "openai";
import type { Uploadable } from "openai";
import {
  OPENAI_JSON_MAX_TOKENS,
  OPENAI_CHAT_SUMMARY_MAX_TOKENS,
  OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS,
  OPENAI_REQUEST_TIMEOUTS_MS,
  OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS,
  OPENAI_STORE_RESPONSES,
} from "../../consts/aiChat/openai";
import { VOICE_OGG_FILE_NAME } from "../../consts/aiChat/voiceMessage";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { reportAiCacheUsage, warnAiUsageUnavailable } from "../../infra/aiCacheUsage";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import type { AiRequestFailureKind } from "../ai/utils/textResult";
import { logAndClassifyProviderApiError } from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureKind } from "../ai/utils/mediaSupportError";
import { getOpenAiClient, requestOpenAiTextResult } from "./client";
import type {
  AiJsonRequest,
  AiTextRequest,
  AiTextResult,
  AiVisionRequest,
  AiVoiceRequest,
} from "../../types/aiChat/provider";

/**
 * 使用 `summary` 能力生成摘要文本。
 * @param request 摘要文本生成请求参数。
 * @returns 清洗后的摘要文本结果。
 */
export function generateOpenAiText(request: AiTextRequest): Promise<AiTextResult> {
  return requestOpenAiTextResult({
    capability: "summary",
    buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().summary.model,
      instructions: request.systemPrompt,
      input: request.userContent,
      max_output_tokens: request.purpose === "chatSummary"
        ? OPENAI_CHAT_SUMMARY_MAX_TOKENS
        : OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS,
      store: OPENAI_STORE_RESPONSES,
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}

/**
 * 使用 `text` 能力生成 JSON 对象格式的结构化文本。
 * @param request 结构化 JSON 生成请求参数。
 * @returns 去除首尾空白后的 JSON 文本结果。
 */
export function generateOpenAiJson(request: AiJsonRequest): Promise<AiTextResult> {
  return requestOpenAiTextResult({
    capability: "text",
    buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().text.model,
      instructions: request.systemPrompt,
      input: request.userContent,
      text: { format: { type: "json_object" } },
      max_output_tokens: OPENAI_JSON_MAX_TOKENS,
      store: OPENAI_STORE_RESPONSES,
    }),
    errorLabel: request.errorLabel,
    normalize: (text: string): string => text.trim(),
    signal: request.signal,
  });
}

/**
 * 使用 `media` 能力对 data URI 内联图片生成视觉描述。
 * @param request 视觉描述生成请求参数。
 * @returns 清洗后的图片描述文本结果。
 */
export function describeOpenAiVision(request: AiVisionRequest): Promise<AiTextResult> {
  return requestOpenAiTextResult({
    capability: "media",
    buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().media.model,
      instructions: request.prompt,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:${request.image.mime};base64,${request.image.bytes.toBase64()}`,
              detail: "auto",
            },
          ],
        },
      ],
      max_output_tokens: OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS,
      store: OPENAI_STORE_RESPONSES,
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}

/**
 * 检查语音转写请求的取消信号是否已触发。
 * @param request 语音转写请求参数。
 * @returns 已取消时返回 `true`，否则返回 `false`。
 */
function isVoiceRequestAborted(request: AiVoiceRequest): boolean {
  return request.signal?.aborted === true;
}

/**
 * 使用 `media` 能力调用 `audio.transcriptions` 进行语音转写并分类错误。
 * @param request 语音转写请求参数。
 * @returns 清洗后的语音转写文本结果及失败可重试标记。
 */
export async function transcribeOpenAiVoice(request: AiVoiceRequest): Promise<AiTextResult> {
  if (isVoiceRequestAborted(request)) return { ok: false, retryable: false };
  try {
    const model: string = getAgentDeploymentConfig().media.model;
    const upload: Uploadable = await toFile(request.clip.bytes, VOICE_OGG_FILE_NAME, {
      type: request.clip.mime,
    });
    if (isVoiceRequestAborted(request)) return { ok: false, retryable: false };
    const requestSignal: AbortSignal = signalWithTimeout(
      request.signal,
      OPENAI_REQUEST_TIMEOUTS_MS.media
    );
    requestSignal.throwIfAborted();
    const response: OpenAI.Audio.Transcriptions.TranscriptionCreateResponse =
      await raceAbortOrThrow(
        getOpenAiClient("media").audio.transcriptions.create(
          {
            file: upload,
            model,
            prompt: request.prompt,
            response_format: "json",
          },
          { signal: requestSignal }
        ).then((result: OpenAI.Audio.Transcriptions.TranscriptionCreateResponse): OpenAI.Audio.Transcriptions.TranscriptionCreateResponse => {
          if (result.usage?.type === "duration") {
            warnAiUsageUnavailable("media", "openai", "duration");
          } else {
            reportAiCacheUsage({
              capability: "media", provider: "openai", model,
              inputTokens: result.usage?.input_tokens,
              cachedInputTokens: undefined,
              outputTokens: result.usage?.output_tokens,
            });
          }
          return result;
        }),
        requestSignal
      );
    return finalizeAiTextResult(request.normalize(response.text));
  } catch (error: unknown) {
    if (isVoiceRequestAborted(request)) return { ok: false, retryable: false };
    let failureKind: AiRequestFailureKind = "request";
    if (error instanceof OpenAI.APIError) {
      const providerFailure: ProviderApiFailureKind = logAndClassifyProviderApiError({
        error,
        errorLabel: request.errorLabel,
        isMediaCapability: true,
      });
      if (providerFailure !== "endpointFailure") failureKind = providerFailure;
    } else {
      logger.error(`Error calling ${request.errorLabel}:`, error);
    }
    return classifyAiTextFailure(failureKind, "media");
  }
}
