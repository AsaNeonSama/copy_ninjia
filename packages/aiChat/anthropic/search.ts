/**
 * Anthropic 联网检索实现：挂载服务端联网检索工具并处理 `pause_turn` 续写，提取正文、来源与检索次数。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { BetaFallbackState } from "@anthropic-ai/sdk";
import {
  ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS,
  ANTHROPIC_WEB_SEARCH_ERROR_LABEL,
  ANTHROPIC_WEB_SEARCH_MAX_TOKENS,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
} from "../../consts/aiChat/anthropic";
import { requireAgentCapabilityConfig } from "../../config/agent";
import { requestAnthropicMessage } from "./client";
import { anthropicSearchError, anthropicSearchSources, countAnthropicWebSearches, messageText } from "./response";
import { logger } from "../../infra/logger";
import type { AnthropicRequestResult } from "../../types/aiChat/anthropic";
import type {
  AiWebSearchCapability,
  AiWebSearchRequest,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../types/aiChat/provider";

/** 按指定能力执行一次 Anthropic 联网检索。 */
export async function searchAnthropicWeb(
  capability: AiWebSearchCapability,
  request: AiWebSearchRequest
): Promise<AiWebSearchResult> {
  let searchCalls: number = 0;
  let text: string = "";
  const sources: AiWebSearchSource[] = [];
  const fallbackState: BetaFallbackState = new BetaFallbackState();
  let paused: Anthropic.Beta.BetaContentBlockParam[] | null = null;
  for (let continuation: number = 0; ; continuation++) {
    const prefix: Anthropic.Beta.BetaContentBlockParam[] | null = paused;
    const result: AnthropicRequestResult = await requestAnthropicMessage({
      capability,
      buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => {
        const model: string = requireAgentCapabilityConfig(capability).model;
        const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request.query }];
        if (prefix !== null) messages.push({ role: "assistant", content: prefix });
        return {
          model,
          system: request.instruction,
          messages,
          tools: [{ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: ANTHROPIC_WEB_SEARCH_TOOL_NAME, allowed_callers: ["direct"] }],
          max_tokens: ANTHROPIC_WEB_SEARCH_MAX_TOKENS,
        };
      },
      errorLabel: ANTHROPIC_WEB_SEARCH_ERROR_LABEL,
      signal: request.signal,
      fallbackState,
    });
    const searches: number = result.message === undefined ? 0 : countAnthropicWebSearches(result.message);
    searchCalls += searches;

    if (!result.ok) return result.failureKind === "refused" ? { ok: false, searchCalls, refused: true } : { ok: false, searchCalls };
    const searchError: string | undefined = anthropicSearchError(result.message);
    if (searchError !== undefined) {
      logger.error(`${ANTHROPIC_WEB_SEARCH_ERROR_LABEL} tool failed: ${searchError}.`);
      return { ok: false, searchCalls };
    }
    text += messageText(result.message);
    sources.push(...anthropicSearchSources(result.message));
    if (result.message.stop_reason !== "pause_turn") return { ok: true, text, sources, searchCalls };
    if (continuation >= ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS) return { ok: false, searchCalls };
    paused = prefix === null ? result.message.content : [...prefix, ...result.message.content];
  }
}
