/**
 * Gemini 生图实现：组装提示词与参考图并调用生图模型，提取并校验首个有效图片载荷。
 */

import { FinishReason } from "@google/genai";
import type { Blob as GenAiBlob, Candidate, GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import {
  GEMINI_IMAGE_ERROR_LABEL,
  GEMINI_IMAGE_SIZE,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { decodeGeneratedImage } from "../ai/utils/imagePayload";
import { requestGeminiResult } from "./client";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type { AiImageRequest } from "../../types/aiChat/provider";
import type { GeneratedChatImage } from "../../types/aiChat/imageGeneration";
import type { VisionImage } from "../../types/media";

/**
 * 从响应首个以 `STOP` 结束的 candidate 中提取并解码第一张非思考内联图片。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 解码并校验通过的生成图片载荷；无有效图片时返回 `null`。
 */
function extractGeneratedImage(data: GenerateContentResponse): GeneratedChatImage | null {
  const candidate: Candidate | undefined = data.candidates?.[0];
  if (candidate?.finishReason !== FinishReason.STOP) return null;
  const parts: Part[] = candidate.content?.parts ?? [];
  for (const part of parts) {
    if (part.thought === true || !part.inlineData) continue;
    const { data: encoded, mimeType }: GenAiBlob = part.inlineData;
    if (typeof encoded !== "string") continue;
    const image: GeneratedChatImage | null = decodeGeneratedImage(encoded, mimeType);
    if (image) return image;
  }
  return null;
}

/**
 * 构造提示词在前、参考图按顺序在后的单个 user 轮次。
 * @param prompt 生图文字提示词。
 * @param referenceImages 按顺序排列的参考图列表。
 * @returns 包含文字与内联参考图的单轮 `contents` 参数。
 */
function referenceContents(prompt: string, referenceImages: readonly VisionImage[]): GenerateContentParameters["contents"] {
  const parts: Part[] = [{ text: prompt }];
  for (const referenceImage of referenceImages) {
    parts.push({ inlineData: { mimeType: referenceImage.mime, data: referenceImage.bytes.toBase64() } });
  }
  return [{ role: "user", parts }];
}

/**
 * 调用 Gemini 生图模型生成一张图片；无可用载荷时返回 null。
 * @param request 生图请求参数，包含提示词、画幅比例、参考图与取消信号。
 * @returns 生成的图片载荷；失败或无有效图片时返回 `null`。
 */
export async function generateGeminiImage({
  prompt,
  aspectRatio,
  referenceImages,
  signal,
}: AiImageRequest): Promise<GeneratedChatImage | null> {
  const contents: GenerateContentParameters["contents"] = referenceImages.length > 0
    ? referenceContents(prompt, referenceImages)
    : prompt;
  const result: GeminiRequestResult = await requestGeminiResult({
    capability: "image",
    buildBody: (): GenerateContentParameters => {
      const model: string | undefined = getAgentDeploymentConfig().image?.model;
      if (model === undefined) throw new Error('Agent capability "image" is not configured.');
      return {
        model,
        contents,
        config: {
          abortSignal: signal,
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio, imageSize: GEMINI_IMAGE_SIZE },
        },
      };
    },
    errorLabel: GEMINI_IMAGE_ERROR_LABEL,
  });
  return result.ok ? extractGeneratedImage(result.response) : null;
}
