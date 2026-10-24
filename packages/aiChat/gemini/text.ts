/**
 * Gemini 侧的纯文本生成、结构化 JSON 生成、视觉描述与语音转写。
 */

import {
  GEMINI_JSON_MAX_TOKENS,
  GEMINI_CHAT_SUMMARY_MAX_TOKENS,
  GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS,
  GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
  GEMINI_SUMMARY_TEMPERATURE,
  GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { requestGeminiTextResult } from "./client";
import type { GenerateContentParameters } from "@google/genai";
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
export function generateGeminiText(request: AiTextRequest): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "summary",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().summary.model,
      contents: [{ role: "user", parts: [{ text: request.userContent }] }],
      config: {
        systemInstruction: request.systemPrompt,
        abortSignal: request.signal,
        temperature: GEMINI_SUMMARY_TEMPERATURE,
        maxOutputTokens: request.purpose === "chatSummary"
          ? GEMINI_CHAT_SUMMARY_MAX_TOKENS
          : GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
      },
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}

/**
 * 使用 `text` 能力按给定 JSON Schema 生成结构化 JSON 文本。
 * @param request 结构化 JSON 生成请求参数。
 * @returns 去除首尾空白后的 JSON 文本结果。
 */
export function generateGeminiJson(request: AiJsonRequest): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "text",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().text.model,
      contents: [{ role: "user", parts: [{ text: request.userContent }] }],
      config: {
        systemInstruction: request.systemPrompt,
        abortSignal: request.signal,
        responseMimeType: "application/json",
        responseJsonSchema: request.jsonSchema,
        maxOutputTokens: GEMINI_JSON_MAX_TOKENS,
      },
    }),
    errorLabel: request.errorLabel,
    normalize: (text: string): string => text.trim(),
    signal: request.signal,
  });
}

interface InlineMediaPrompt {
  /** 媒体数据的 MIME 类型。 */
  readonly mime: string;
  /** 媒体原始字节载荷。 */
  readonly bytes: Uint8Array;
  /** 随附的文字提示词。 */
  readonly prompt: string;
  /** 最大输出 token 上限。 */
  readonly maxOutputTokens: number;
  /** 错误日志标签。 */
  readonly errorLabel: string;
  /** 外部取消信号。 */
  readonly signal?: AbortSignal;
  /** 输出文本清洗规范化函数。 */
  readonly normalize: AiVisionRequest["normalize"];
}

/**
 * 发送携带内联媒体与文字指令的 `media` 能力请求。
 * @param params 内联媒体描述或转写请求参数。
 * @returns 清洗后的媒体处理文本结果。
 */
function requestInlineMediaText({
  mime,
  bytes,
  prompt,
  maxOutputTokens,
  errorLabel,
  signal,
  normalize,
}: InlineMediaPrompt): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "media",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().media.model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: bytes.toBase64() } },
            { text: prompt },
          ],
        },
      ],
      config: { maxOutputTokens, abortSignal: signal },
    }),
    errorLabel,
    normalize,
    signal,
  });
}

/**
 * 使用 `media` 能力对内联图片生成视觉描述。
 * @param request 视觉描述生成请求参数。
 * @returns 清洗后的图片描述文本结果。
 */
export function describeGeminiVision(request: AiVisionRequest): Promise<AiTextResult> {
  return requestInlineMediaText({
    mime: request.image.mime,
    bytes: request.image.bytes,
    prompt: request.prompt,
    maxOutputTokens: GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS,
    errorLabel: request.errorLabel,
    signal: request.signal,
    normalize: request.normalize,
  });
}

/**
 * 使用 `media` 能力对内联音频生成语音转写文本。
 * @param request 语音转写请求参数。
 * @returns 清洗后的语音转写文本结果。
 */
export function transcribeGeminiVoice(request: AiVoiceRequest): Promise<AiTextResult> {
  return requestInlineMediaText({
    mime: request.clip.mime,
    bytes: request.clip.bytes,
    prompt: request.prompt,
    maxOutputTokens: GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS,
    errorLabel: request.errorLabel,
    signal: request.signal,
    normalize: request.normalize,
  });
}
