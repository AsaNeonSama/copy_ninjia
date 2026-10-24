/**
 * Gemini `generateContent` 响应解析辅助：提取首个 candidate 的正文、异常收尾诊断与详情、以及 Google Search 调用次数。
 */

import { FinishReason, ToolType } from "@google/genai";
import type { Candidate, GenerateContentResponse, Part } from "@google/genai";
import { finishDetailsJson } from "../ai/utils/finishDetails";

/**
 * 提取响应中的首个 candidate。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 首个 candidate；无候选项时返回 `undefined`。
 */
function firstCandidate(data: GenerateContentResponse): Candidate | undefined {
  return data.candidates?.[0];
}

/**
 * 提取首个 candidate 的内容分片列表。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 首个 candidate 的 `Part` 只读数组；缺失时返回空数组。
 */
function responseParts(data: GenerateContentResponse): readonly Part[] {
  return firstCandidate(data)?.content?.parts ?? [];
}

/**
 * 拼接首个 candidate 中全部非 `thought` 文本 part；无任何文本 part 时返回 undefined。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 拼接后的正文字符串；不含非思考文本分片时返回 `undefined`。
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

/**
 * 检查首个 candidate 是否存在且以 `STOP` 正常收尾；异常时返回诊断字符串，正常时返回 null。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 异常收尾的简短诊断字符串；以 `STOP` 正常收尾时返回 `null`。
 */
export function abnormalFinishDiagnostic(data: GenerateContentResponse): string | null {
  const candidate: Candidate | undefined = firstCandidate(data);
  if (!candidate) return "no candidates";
  const finishReason: FinishReason | undefined = candidate.finishReason;
  if (finishReason === undefined) return "missing finishReason";
  if (finishReason !== FinishReason.STOP) return `finishReason=${finishReason}`;
  return null;
}

/**
 * 序列化响应的收尾诊断详情（有 candidate 时取 `finishMessage` 与 `safetyRatings`，无 candidate 时取 `promptFeedback`）。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 序列化后的诊断详情 JSON 字符串；无可用诊断字段时返回 `undefined`。
 */
export function geminiFinishDetails(data: GenerateContentResponse): string | undefined {
  const candidate: Candidate | undefined = firstCandidate(data);
  if (!candidate) {
    return data.promptFeedback === undefined ? undefined : finishDetailsJson({ promptFeedback: data.promptFeedback });
  }
  if (candidate.finishMessage === undefined && candidate.safetyRatings === undefined) return undefined;
  return finishDetailsJson({ finishMessage: candidate.finishMessage, safetyRatings: candidate.safetyRatings });
}

/**
 * 统计首个 candidate 中服务端执行的 Google Search 调用次数：优先统计内容分片中的显式 `GOOGLE_SEARCH_WEB` 工具调用，
 * 若无显式调用分片则回退取 `groundingMetadata.webSearchQueries` 的条数。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 本次响应计入的 Google Search 检索次数。
 */
export function countGoogleSearchCalls(data: GenerateContentResponse): number {
  let explicitCalls: number = 0;
  for (const part of responseParts(data)) {
    if (part.toolCall?.toolType === ToolType.GOOGLE_SEARCH_WEB) explicitCalls++;
  }
  if (explicitCalls > 0) return explicitCalls;

  return firstCandidate(data)?.groundingMetadata?.webSearchQueries?.length ?? 0;
}
