/**
 * Gemini 侧的生图：调独立图片模型按 GEMINI_IMAGE_SIZE 生成一张图片，文本段与思考中间图一律忽略。
 * 有参考图时同一个 user 轮次先放提示词，再按顺序放每张参考图的内联数据。
 * 载荷校验（base64 规范性、大小上限、文件签名）走 aiChat/ai/utils/imagePayload.ts（Gemini 与 OpenAI 共用）。
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

function extractGeneratedImage(data: GenerateContentResponse): GeneratedChatImage | null {
  const candidate: Candidate | undefined = data.candidates?.[0];
  // 只有明确 STOP 的 candidate 才可发送；其它收尾原因即使带有 payload 也拒绝。
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

/** 提示词在前、参考图按顺序在后的单个 user 轮次。 */
function referenceContents(prompt: string, referenceImages: readonly VisionImage[]): GenerateContentParameters["contents"] {
  const parts: Part[] = [{ text: prompt }];
  for (const referenceImage of referenceImages) {
    parts.push({ inlineData: { mimeType: referenceImage.mime, data: referenceImage.bytes.toBase64() } });
  }
  return [{ role: "user", parts }];
}

/** 调 Gemini 生图模型按 GEMINI_IMAGE_SIZE 生成一张图片；无可用载荷时返回 null。 */
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
