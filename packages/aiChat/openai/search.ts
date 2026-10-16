/**
 * OpenAI 联网检索实现：挂载服务端 hosted `web_search` 工具调用 Responses API，提取正文、引用来源与检索次数。
 */

import type OpenAI from "openai";
import {
  OPENAI_STORE_RESPONSES,
  OPENAI_WEB_SEARCH_ERROR_LABEL,
  OPENAI_WEB_SEARCH_MAX_TOKENS,
} from "../../consts/aiChat/openai";
import { requireAgentCapabilityConfig } from "../../config/agent";
import { requestOpenAiResult } from "./client";
import { countWebSearchCalls, responseOutputItems, responseOutputText } from "./response";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type {
  AiWebSearchCapability,
  AiWebSearchRequest,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../types/aiChat/provider";

/** 按出现顺序追加一段 output_text 中 `url_citation` 注解的来源。 */
function appendUrlCitations(content: OpenAI.Responses.ResponseOutputText, sources: AiWebSearchSource[]): void {
  for (const annotation of content.annotations) {
    if (annotation.type === "url_citation") sources.push({ title: annotation.title, url: annotation.url });
  }
}

/** 按出现顺序提取响应正文 `url_citation` 注解中的来源。 */
function citedSources(response: OpenAI.Responses.Response): readonly AiWebSearchSource[] {
  const sources: AiWebSearchSource[] = [];
  for (const item of responseOutputItems(response)) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "output_text") appendUrlCitations(content, sources);
    }
  }
  return sources;
}

/** 按指定能力执行一次 OpenAI 联网检索。 */
export async function searchOpenAiWeb(
  capability: AiWebSearchCapability,
  request: AiWebSearchRequest
): Promise<AiWebSearchResult> {
  const result: OpenAiRequestResult = await requestOpenAiResult({
    capability,
    buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => {
      const model: string = requireAgentCapabilityConfig(capability).model;
      return {
        model,
        instructions: request.instruction,
        input: request.query,
        tools: [{ type: "web_search" }],
        max_output_tokens: OPENAI_WEB_SEARCH_MAX_TOKENS,
        store: OPENAI_STORE_RESPONSES,
      };
    },
    errorLabel: OPENAI_WEB_SEARCH_ERROR_LABEL,
    signal: request.signal,
  });
  const response: OpenAI.Responses.Response | undefined = result.response;
  const searchCalls: number = response === undefined ? 0 : countWebSearchCalls(response);

  if (!result.ok) return { ok: false, searchCalls };
  return { ok: true, text: responseOutputText(result.response), sources: citedSources(result.response), searchCalls };
}
