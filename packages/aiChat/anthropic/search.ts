/**
 * Anthropic 联网检索实现：挂载服务端联网检索工具并处理 `pause_turn` 续写，提取正文、来源与检索次数。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { BetaFallbackState } from "@anthropic-ai/sdk";
import {
  ANTHROPIC_WEB_SEARCH_ERROR_LABEL,
  ANTHROPIC_WEB_SEARCH_MAX_TOKENS,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
} from "../../consts/aiChat/anthropic";
import { requireAgentCapabilityConfig } from "../../config/agent";
import {
  PAUSE_TURN_CONTINUE,
  requestAnthropicWithPauseTurn,
} from "./pauseTurn";
import type { AnthropicPauseTurnStep, AnthropicRequestFailure } from "./pauseTurn";
import { anthropicSearchError, anthropicSearchSources, messageText } from "./response";
import { logger } from "../../infra/logger";
import type {
  AiWebSearchCapability,
  AiWebSearchRequest,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../types/aiChat/provider";

/**
 * 按指定能力执行一次 Anthropic 联网检索。
 * @param capability 执行联网检索的能力槽位（`"web_search"` 或 `"text"`）。
 * @param request 联网检索请求参数。
 * @returns 联网检索结果：成功时包含汇总正文、引用来源与检索次数；请求失败、工具报错或超过 `pause_turn` 续写上限时返回 `ok: false`（模型拒答时附带 `refused: true`）。
 */
export async function searchAnthropicWeb(
  capability: AiWebSearchCapability,
  request: AiWebSearchRequest
): Promise<AiWebSearchResult> {
  let text: string = "";
  const sources: AiWebSearchSource[] = [];
  const fallbackState: BetaFallbackState = new BetaFallbackState();
  return requestAnthropicWithPauseTurn<AiWebSearchResult>({
    capability,
    errorLabel: ANTHROPIC_WEB_SEARCH_ERROR_LABEL,
    signal: request.signal,
    fallbackState,
    buildBody: (
      prefix: Anthropic.Beta.BetaContentBlockParam[] | null
    ): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => {
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
    onFailure: (failure: AnthropicRequestFailure, searchCalls: number): AiWebSearchResult =>
      failure.failureKind === "refused" ? { ok: false, searchCalls, refused: true } : { ok: false, searchCalls },
    handleMessage: ({ message, webSearchCalls: searchCalls }: AnthropicPauseTurnStep): AiWebSearchResult | typeof PAUSE_TURN_CONTINUE => {
      const searchError: string | undefined = anthropicSearchError(message);
      if (searchError !== undefined) {
        logger.error(`${ANTHROPIC_WEB_SEARCH_ERROR_LABEL} tool failed: ${searchError}.`);
        return { ok: false, searchCalls };
      }
      text += messageText(message);
      sources.push(...anthropicSearchSources(message));
      return message.stop_reason === "pause_turn"
        ? PAUSE_TURN_CONTINUE
        : { ok: true, text, sources, searchCalls };
    },
    onPauseLimitExceeded: (searchCalls: number): AiWebSearchResult => ({ ok: false, searchCalls }),
  });
}
