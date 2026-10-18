import { FinishReason, ToolType } from "@google/genai";
import type { Candidate, GenerateContentResponse, Part } from "@google/genai";
import { finishDetailsJson } from "../ai/utils/finishDetails";

/**
 * Gemini `generateContent` 响应解析辅助：提取首个 candidate 的正文、异常收尾诊断与详情、以及 Google Search 调用次数。
 */

function firstCandidate(data: GenerateContentResponse): Candidate | undefined {
  return data.candidates?.[0];
}

function responseParts(data: GenerateContentResponse): readonly Part[] {
  return firstCandidate(data)?.content?.parts ?? [];
}

/**
 * 拼接首个 candidate 中全部非 `thought` 文本 part；无任何文本 part 时返回 undefined。
 */
export function responseText(data: GenerateContentResponse): string | undefined {
  let text: string = "";
  let hasTextPart: boolean = false;
  for (const part of responseParts(data)) {
    if (typeof part.text !== "string" || part.thought === true) continue;
    hasTextPart = true;
    text += part.text;
  }
  return hasTextPart ? text : undefined;
}

/** 检查首个 candidate 是否存在且以 `STOP` 正常收尾；异常时返回诊断字符串，正常时返回 null。 */
export function abnormalFinishDiagnostic(data: GenerateContentResponse): string | null {
  const candidate: Candidate | undefined = firstCandidate(data);
  if (!candidate) return "no candidates";
  const finishReason: FinishReason | undefined = candidate.finishReason;
  if (finishReason === undefined) return "missing finishReason";
  if (finishReason !== FinishReason.STOP) return `finishReason=${finishReason}`;
  return null;
}

/** 序列化响应的收尾诊断详情（有 candidate 时取 `finishMessage` 与 `safetyRatings`，无 candidate 时取 `promptFeedback`）。 */
export function geminiFinishDetails(data: GenerateContentResponse): string | undefined {
  const candidate: Candidate | undefined = firstCandidate(data);
  if (!candidate) {
    return data.promptFeedback === undefined ? undefined : finishDetailsJson({ promptFeedback: data.promptFeedback });
  }
  if (candidate.finishMessage === undefined && candidate.safetyRatings === undefined) return undefined;
  return finishDetailsJson({ finishMessage: candidate.finishMessage, safetyRatings: candidate.safetyRatings });
}

/** 统计首个 candidate 中服务端执行的 Google Search 调用次数。 */
export function countGoogleSearchCalls(data: GenerateContentResponse): number {
  let explicitCalls: number = 0;
  for (const part of responseParts(data)) {
    if (part.toolCall?.toolType === ToolType.GOOGLE_SEARCH_WEB) explicitCalls++;
  }
  if (explicitCalls > 0) return explicitCalls;

  return firstCandidate(data)?.groundingMetadata?.webSearchQueries?.length ?? 0;
}
