/**
 * `web_search` 函数工具执行器：调用 web_search 能力模型发起单轮检索，将结论与去重来源裁剪到
 * WEB_SEARCH_RESULT_MAX_CHARS 与 WEB_SEARCH_MAX_SOURCES 内交回模型。检索模型拒答时返回
 * WEB_SEARCH_REFUSED_TEXT 并标记不可重试；其余失败返回 WEB_SEARCH_FAILED_TEXT。
 * 预算边界见 docs/cn/04-invariants.md。
 */

import {
  WEB_SEARCH_FAILED_TEXT,
  WEB_SEARCH_MAX_SOURCES,
  WEB_SEARCH_REFUSED_TEXT,
  WEB_SEARCH_QUERY_MAX_CHARS,
  WEB_SEARCH_RESULT_MAX_CHARS,
  WEB_SEARCH_RESULT_NOTICE,
  WEB_SEARCH_SOURCE_TITLE_MAX_CHARS,
  WEB_SEARCH_SOURCES_HEADING,
} from "../../../consts/aiChat/tools";
import { WEB_SEARCH_EXECUTOR_INSTRUCTION } from "../../../consts/aiChat/prompts/search";
import { currentTimeSentence } from "../timeSentence";
import { WEB_SEARCH_TIME_LABEL } from "../../../consts/aiChat/prompts/researchTime";
import { logger } from "../../../infra/logger";
import { sanitizeInline, truncateAtClauseBoundary, truncateInline } from "../../../libs/text";
import { parseStringField } from "../utils/toolArgs";
import { toolError } from "../utils/toolResult";
import type {
  AiWebSearchFacade,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../../types/aiChat/provider";
import type { WebSearchToolExecutor, WebSearchToolOutcome } from "../../../types/aiChat/replies";

/** 解析检索问题参数；非空且不超过 WEB_SEARCH_QUERY_MAX_CHARS 时返回，否则返回 null。 */
function parseQuery(argumentsJson: string): string | null {
  const query: string | null = parseStringField(argumentsJson, "query")?.trim() ?? null;
  if (query === null || query.length > WEB_SEARCH_QUERY_MAX_CHARS) return null;
  return query;
}

/**
 * 将检索结论与去重来源裁剪为紧凑正文：首行为提示语，末尾为去重后的编号来源列表
 * （最多 WEB_SEARCH_MAX_SOURCES 条且不超过总长上限的一半），结论在剩余额度内按子句边界截断。
 */
export function formatWebSearchResult(text: string, sources: readonly AiWebSearchSource[]): string {
  const lines: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const source of sources) {
    if (lines.length === WEB_SEARCH_MAX_SOURCES) break;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    const title: string = truncateInline(sanitizeInline(source.title), WEB_SEARCH_SOURCE_TITLE_MAX_CHARS);
    lines.push(`${lines.length + 1}. ${title} ${source.url}`);
  }
  let footer: string = "";
  while (lines.length > 0) {
    footer = `\n${WEB_SEARCH_SOURCES_HEADING}\n${lines.join("\n")}`;
    if (footer.length <= WEB_SEARCH_RESULT_MAX_CHARS / 2) break;
    lines.pop();
    footer = "";
  }
  const head: string = `${WEB_SEARCH_RESULT_NOTICE}\n`;
  return head + truncateAtClauseBoundary(text, WEB_SEARCH_RESULT_MAX_CHARS - head.length - footer.length) + footer;
}

/** 创建单轮回复的 web_search 执行器，统计并限制单轮调用次数。 */
export function createWebSearchExecutor(
  provider: AiWebSearchFacade,
  maxCallsPerUse: number,
  signal: AbortSignal | undefined
): WebSearchToolExecutor {
  let calls: number = 0;

  function failed(reason: string, searchCalls: number): WebSearchToolOutcome {
    if (signal?.aborted !== true) {
      logger.error(`AI reply web_search tool returned "${WEB_SEARCH_FAILED_TEXT}" to the model: ${reason}.`);
    }
    return { result: toolError(WEB_SEARCH_FAILED_TEXT), searchCalls };
  }

  function refused(searchCalls: number): WebSearchToolOutcome {
    if (signal?.aborted !== true) {
      logger.error(`AI reply web_search tool returned "${WEB_SEARCH_REFUSED_TEXT}" to the model: the search model refused the request.`);
    }
    return { result: toolError(WEB_SEARCH_REFUSED_TEXT, { retryable: false }), searchCalls };
  }

  return async (argumentsJson: string): Promise<WebSearchToolOutcome> => {
    calls++;
    if (calls > maxCallsPerUse) {
      return failed(`the per-reply limit of ${maxCallsPerUse} web_search calls was exceeded`, 0);
    }
    const query: string | null = parseQuery(argumentsJson);
    if (query === null) return failed("the arguments were not a valid query", 0);
    const response: AiWebSearchResult = await provider.searchWeb({
      instruction: WEB_SEARCH_EXECUTOR_INSTRUCTION,
      query: `${query}\n${currentTimeSentence(WEB_SEARCH_TIME_LABEL)}`,
      signal,
    });
    if (!response.ok) {
      return response.refused === true
        ? refused(response.searchCalls)
        : failed("the search request failed", response.searchCalls);
    }
    if (response.searchCalls === 0) return failed("the endpoint answered without searching", 0);
    const text: string = response.text.trim();
    if (text.length === 0) return failed("the search returned no text", response.searchCalls);
    return {
      result: JSON.stringify({ result: formatWebSearchResult(text, response.sources) }),
      searchCalls: response.searchCalls,
    };
  };
}
