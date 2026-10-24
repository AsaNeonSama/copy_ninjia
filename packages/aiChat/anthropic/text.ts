/**
 * Anthropic 侧的纯文本生成、结构化 JSON 生成与视觉描述。
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_CHAT_SUMMARY_MAX_TOKENS,
  ANTHROPIC_JSON_MAX_TOKENS,
  ANTHROPIC_MEDIA_DESCRIPTION_MAX_TOKENS,
  ANTHROPIC_STICKER_PACK_SUMMARY_MAX_TOKENS,
} from "../../consts/aiChat/anthropic";
import { getAgentDeploymentConfig } from "../../config/agent";
import { requestAnthropicTextResult } from "./client";
import type {
  AiJsonRequest,
  AiTextRequest,
  AiTextResult,
  AiVisionRequest,
} from "../../types/aiChat/provider";

/**
 * 使用 `summary` 能力生成摘要文本。
 * @param request 摘要文本生成请求参数。
 * @returns 清洗后的摘要文本结果。
 */
export function generateAnthropicText(request: AiTextRequest): Promise<AiTextResult> {
  return requestAnthropicTextResult({
    capability: "summary",
    buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().summary.model,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userContent }],
      max_tokens: request.purpose === "chatSummary"
        ? ANTHROPIC_CHAT_SUMMARY_MAX_TOKENS
        : ANTHROPIC_STICKER_PACK_SUMMARY_MAX_TOKENS,
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
export function generateAnthropicJson(request: AiJsonRequest): Promise<AiTextResult> {
  return requestAnthropicTextResult({
    capability: "text",
    buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().text.model,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userContent }],
      output_config: { format: { type: "json_schema", schema: request.jsonSchema } },
      max_tokens: ANTHROPIC_JSON_MAX_TOKENS,
    }),
    errorLabel: request.errorLabel,
    normalize: (text: string): string => text.trim(),
    signal: request.signal,
  });
}

/**
 * 使用 `media` 能力对内联 base64 图片生成视觉描述。
 * @param request 视觉描述生成请求参数。
 * @returns 清洗后的图片描述文本结果。
 */
export function describeAnthropicVision(request: AiVisionRequest): Promise<AiTextResult> {
  return requestAnthropicTextResult({
    capability: "media",
    buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().media.model,
      system: request.prompt,
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "base64", media_type: request.image.mime, data: request.image.bytes.toBase64() },
        }],
      }],
      max_tokens: ANTHROPIC_MEDIA_DESCRIPTION_MAX_TOKENS,
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}
