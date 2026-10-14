import type Anthropic from "@anthropic-ai/sdk";
import { finishDetailsJson } from "../ai/utils/finishDetails";
import type { AiFunctionCall, AiWebSearchSource } from "../../types/aiChat/provider";

/**
 * Anthropic Messages 响应解析辅助：提取文本、函数调用、检索次数与来源、回退摘要及脱敏收尾详情。
 */

/** 拼接响应中全部 `text` 块的正文。 */
export function messageText(message: Anthropic.Beta.BetaMessage): string {
  let text: string = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/** 提取响应中的自定义工具调用列表。 */
export function toolUseCalls(message: Anthropic.Beta.BetaMessage): readonly AiFunctionCall[] {
  const calls: AiFunctionCall[] = [];
  for (const block of message.content) {
    if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, argumentsJson: JSON.stringify(block.input) });
  }
  return calls;
}

/**
 * 统计响应中已执行的服务端联网检索次数：优先取 `usage.server_tool_use.web_search_requests`，
 * 缺失时统计成功的 `web_search_tool_result` 块数。
 */
export function countAnthropicWebSearches(message: Anthropic.Beta.BetaMessage): number {
  const reported: number | undefined = message.usage?.server_tool_use?.web_search_requests;
  if (typeof reported === "number") return reported;
  let calls: number = 0;
  for (const block of message.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) calls++;
  }
  return calls;
}

/** 提取响应中联网检索工具的错误码；无错误时返回 undefined。 */
export function anthropicSearchError(message: Anthropic.Beta.BetaMessage): string | undefined {
  for (const block of message.content) {
    if (block.type === "web_search_tool_result" && !Array.isArray(block.content)) return block.content.error_code;
  }
  return undefined;
}

/**
 * 按出现顺序提取正文引用与检索结果块中的来源链接。
 */
export function anthropicSearchSources(message: Anthropic.Beta.BetaMessage): readonly AiWebSearchSource[] {
  const sources: AiWebSearchSource[] = [];
  for (const block of message.content) {
    if (block.type !== "text") continue;
    for (const citation of block.citations ?? []) {
      if (citation.type === "web_search_result_location") sources.push({ title: citation.title ?? citation.url, url: citation.url });
    }
  }
  for (const block of message.content) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content) sources.push({ title: result.title, url: result.url });
  }
  return sources;
}

/** 提取响应中 `fallback` 块的改道诊断摘要；未发生改道时返回 undefined。 */
export function anthropicFallbackSummary(message: Anthropic.Beta.BetaMessage): string | undefined {
  for (const block of message.content) {
    if (block.type !== "fallback") continue;
    return `from=${block.from.model}, to=${block.to.model}, trigger=${finishDetailsJson(block.trigger) ?? "null"}, ` +
      `fallback_credit=${finishDetailsJson(message.usage?.fallback_credit) ?? "null"}`;
  }
  return undefined;
}

/** 剥离 `fallback_credit_token` 后将 `stop_details` 序列化为 JSON 字符串。 */
export function anthropicStopDetailsJson(message: Anthropic.Beta.BetaMessage): string | undefined {
  const details: Anthropic.Beta.BetaRefusalStopDetails | null | undefined = message.stop_details;
  if (details === null || details === undefined) return undefined;
  return finishDetailsJson("fallback_credit_token" in details ? { ...details, fallback_credit_token: undefined } : details);
}
