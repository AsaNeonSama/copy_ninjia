/**
 * Gemini 联网检索实现：挂载服务端 `googleSearch` 工具调用 `generateContent`，提取正文、来源与检索次数。
 */

import {
  GEMINI_WEB_SEARCH_ERROR_LABEL,
  GEMINI_WEB_SEARCH_MAX_TOKENS,
} from "../../consts/aiChat/gemini";
import { requireAgentCapabilityConfig } from "../../config/agent";
import { requestGeminiResult } from "./client";
import { countGoogleSearchCalls, responseText } from "./response";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type {
  AiWebSearchCapability,
  AiWebSearchRequest,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../types/aiChat/provider";

/**
 * 按出现顺序提取首个 candidate `groundingChunks` 中的网页来源。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 汇总的联网检索网页来源只读数组。
 */
function groundedSources(data: GenerateContentResponse): readonly AiWebSearchSource[] {
  const sources: AiWebSearchSource[] = [];
  for (const chunk of data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const url: string | undefined = chunk.web?.uri;
    if (url === undefined || url.length === 0) continue;
    sources.push({ title: chunk.web?.title ?? url, url });
  }
  return sources;
}

/**
 * 按指定能力执行一次 Gemini 联网检索。
 * @param capability 执行联网检索的能力槽位（`"web_search"` 或 `"text"`）。
 * @param request 联网检索请求参数。
 * @returns 联网检索结果：成功时包含汇总正文、网页来源与 Google Search 调用次数；请求或响应异常时返回 `{ ok: false, searchCalls }`。
 */
export async function searchGeminiWeb(
  capability: AiWebSearchCapability,
  request: AiWebSearchRequest
): Promise<AiWebSearchResult> {
  const result: GeminiRequestResult = await requestGeminiResult({
    capability,
    buildBody: (): GenerateContentParameters => {
      const model: string = requireAgentCapabilityConfig(capability).model;
      return {
        model,
        contents: [{ role: "user", parts: [{ text: request.query }] }],
        config: {
          systemInstruction: request.instruction,
          tools: [{ googleSearch: {} }],
          maxOutputTokens: GEMINI_WEB_SEARCH_MAX_TOKENS,
          abortSignal: request.signal,
        },
      };
    },
    errorLabel: GEMINI_WEB_SEARCH_ERROR_LABEL,
  });
  const response: GenerateContentResponse | undefined = result.response;
  const searchCalls: number = response === undefined ? 0 : countGoogleSearchCalls(response);

  if (!result.ok) return { ok: false, searchCalls };
  return {
    ok: true,
    text: responseText(result.response) ?? "",
    sources: groundedSources(result.response),
    searchCalls,
  };
}
