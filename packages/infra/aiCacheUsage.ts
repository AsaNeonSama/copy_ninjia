/**
 * 模型请求用量的校验与上报边界：适配各供应商响应结构并投递至本线程用量出口（cache/perThread/aiCacheUsage.ts）。
 */

import { aiCacheUsageSink, aiUsageWarningKeys } from "../cache/perThread/aiCacheUsage";
import { logger } from "./logger";
import { isPlainRecord } from "../libs/record";
import type { AiCacheCapability, AiCacheUsage, AiUsageUnavailableReason, AiUsageWarningKey } from "../types/aiCache";
import type { AgentProvider } from "../types/config";
import type { GenerateContentResponseUsageMetadata, Interactions } from "@google/genai";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

/** reportAiCacheUsage 的入参；token 数按供应商原样传入，由本函数校验。 */
export interface AiCacheUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 供应商标识。 */
  readonly provider: AgentProvider;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** 供应商返回的总输入 token 数。 */
  readonly inputTokens: unknown;
  /** 命中缓存的输入 token；undefined 表示供应商未提供缓存用量。 */
  readonly cachedInputTokens: unknown;
  /** 写入缓存的输入 token；缺省或 undefined 表示供应商未提供缓存写入用量。 */
  readonly cacheWriteInputTokens?: unknown;
  /** 供应商返回的总输出 token 数。 */
  readonly outputTokens: unknown;
  /** 同一响应的实际检索次数；缺省表示无检索。 */
  readonly searchCalls?: number;
}

/**
 * 判定值是否为合法的非负安全整数 token 计数。
 * @param value 待校验的候选值。
 * @returns 为非负安全整数时返回 true，否则返回 false。
 */
function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 校验并累加 Gemini 提示词与工具入参 token；任一值非法时返回 NaN，否则 promptTokenCount 缺省时返回 undefined。
 * @param prompt 提示词 token 数（含缓存命中部分）。
 * @param toolUse 工具执行结果回灌给模型的输入 token 数。
 * @returns 累加后的输入 token 总数；prompt 未提供且 toolUse 合法时返回 undefined，任一值非法时返回 NaN。
 */
function geminiInputTokens(prompt: unknown, toolUse: unknown): number | undefined {
  if (toolUse !== undefined && !isTokenCount(toolUse)) return Number.NaN;
  if (prompt === undefined) return undefined;
  if (!isTokenCount(prompt)) return Number.NaN;
  return prompt + (toolUse ?? 0);
}

/**
 * 校验并累加正文与思考 token；两者均缺省时返回 undefined，任一非法时返回 NaN。
 * @param output 候选正文输出 token 数。
 * @param thoughts 思考过程 token 数。
 * @returns 累加后的输出 token 总数；均未提供时返回 undefined，任一值非法时返回 NaN。
 */
function geminiOutputTokens(output: unknown, thoughts: unknown): number | undefined {
  if (output === undefined && thoughts === undefined) return undefined;
  if (output !== undefined && !isTokenCount(output)) return Number.NaN;
  if (thoughts !== undefined && !isTokenCount(thoughts)) return Number.NaN;
  return (output ?? 0) + (thoughts ?? 0);
}

/**
 * 安装或卸载本线程的用量上报出口并重置告警去重集合。
 * @param sink 接收已校验用量记录的回调；传入 null 时卸载当前出口。
 */
export function installAiCacheUsageSink(sink: ((usage: AiCacheUsage) => void) | null): void {
  aiCacheUsageSink.current = sink;
  aiUsageWarningKeys.clear();
}

/**
 * 按能力、供应商与原因去重记录一次用量不可用告警。
 * @param capability 调用所属的 AI 能力域。
 * @param provider 供应商标识。
 * @param reason 用量不可用的分类原因。
 */
export function warnAiUsageUnavailable(
  capability: AiCacheCapability,
  provider: AgentProvider,
  reason: AiUsageUnavailableReason
): void {
  const key: AiUsageWarningKey = `${capability}/${provider}/${reason}`;
  if (aiUsageWarningKeys.has(key)) return;
  aiUsageWarningKeys.add(key);
  logger.warn(`AI token usage unavailable: capability=${capability}, provider=${provider}, reason=${reason}.`);
}

/**
 * 校验并上报单次请求的 token 与检索用量。
 * @param params 待校验的原始 token 与检索用量字段。
 */
export function reportAiCacheUsage({
  capability,
  provider,
  model,
  inputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  outputTokens,
  searchCalls = 0,
}: AiCacheUsageReport): void {
  if (!isTokenCount(searchCalls)) warnAiUsageUnavailable(capability, provider, "invalid");
  const searches: number | undefined = isTokenCount(searchCalls) && searchCalls > 0 ? searchCalls : undefined;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    warnAiUsageUnavailable(capability, provider,
      inputTokens === undefined || outputTokens === undefined ? "missing" : "invalid");
    if (searches !== undefined) reportAiSearchUsage({ capability, provider, model, searchCalls: searches });
    return;
  }
  let cached: number | null = null;
  if (cachedInputTokens !== undefined) {
    if (!isTokenCount(cachedInputTokens) || cachedInputTokens > inputTokens) {
      warnAiUsageUnavailable(capability, provider, "invalid");
      if (searches !== undefined) reportAiSearchUsage({ capability, provider, model, searchCalls: searches });
      return;
    }
    cached = cachedInputTokens;
  }
  if (cacheWriteInputTokens !== undefined &&
    (!isTokenCount(cacheWriteInputTokens) || cacheWriteInputTokens > inputTokens - (cached ?? 0))) {
    warnAiUsageUnavailable(capability, provider, "invalid");
    if (searches !== undefined) reportAiSearchUsage({ capability, provider, model, searchCalls: searches });
    return;
  }
  deliverAiUsage({
    kind: "tokens",
    timestamp: Date.now(),
    capability,
    provider,
    model,
    inputTokens,
    cachedInputTokens: cached,
    cacheWriteInputTokens,
    outputTokens,
    searchCalls: searches,
  });
}

/**
 * 将已校验的用量记录投递给本线程出口；出口缺失或抛错时记录对应告警。
 * @param usage 已通过校验的用量事件。
 */
function deliverAiUsage(usage: AiCacheUsage): void {
  const sink: ((usage: AiCacheUsage) => void) | null = aiCacheUsageSink.current;
  if (sink === null) {
    warnAiUsageUnavailable(usage.capability, usage.provider, "sink");
    return;
  }
  try {
    sink(usage);
  } catch (error: unknown) {
    void error;
    warnAiUsageUnavailable(usage.capability, usage.provider, "transport");
  }
}

/** reportAiCostUsage 的入参。 */
export interface AiCostUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 供应商标识。 */
  readonly provider: AgentProvider;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** 本次请求的费用（单位为 USD tick）。 */
  readonly costInUsdTicks: unknown;
}

/**
 * 校验并上报单次按费用计量的请求。
 * @param params 待校验的按费用计量上报参数。
 */
export function reportAiCostUsage({ capability, provider, model, costInUsdTicks }: AiCostUsageReport): void {
  if (!isTokenCount(costInUsdTicks)) {
    warnAiUsageUnavailable(capability, provider, costInUsdTicks === undefined ? "missing" : "invalid");
    return;
  }
  deliverAiUsage({
    kind: "cost",
    timestamp: Date.now(),
    capability,
    provider,
    model,
    costInUsdTicks,
  });
}

/** reportAiSearchUsage 的入参。 */
export interface AiSearchUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 供应商标识。 */
  readonly provider: AgentProvider;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** 本次请求实际执行的联网检索次数。 */
  readonly searchCalls: number;
}

/**
 * 无有效 token 时单独校验并上报检索次数；零次忽略。
 * @param params 待校验的联网检索次数上报参数。
 */
export function reportAiSearchUsage({ capability, provider, model, searchCalls }: AiSearchUsageReport): void {
  if (!isTokenCount(searchCalls)) {
    warnAiUsageUnavailable(capability, provider, "invalid");
    return;
  }
  if (searchCalls === 0) return;
  deliverAiUsage({
    kind: "search",
    timestamp: Date.now(),
    capability,
    provider,
    model,
    searchCalls,
  });
}

/** reportXAiUsage 的入参。 */
export interface XAiUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** xAI 响应携带的原始 usage 字段。 */
  readonly usage: unknown;
}

/**
 * 上报 xAI 响应的用量：优先按 input_tokens/output_tokens 计入 token，两者均缺省时按 cost_in_usd_ticks 计入费用。
 * @param params xAI 响应的用量上报参数。
 */
export function reportXAiUsage({ capability, model, usage }: XAiUsageReport): void {
  if (usage !== undefined && !isPlainRecord(usage)) {
    warnAiUsageUnavailable(capability, "openai", "invalid");
    return;
  }
  const inputTokens: unknown = usage?.input_tokens ?? undefined;
  const outputTokens: unknown = usage?.output_tokens ?? undefined;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    const details: unknown = usage?.input_tokens_details;
    reportAiCacheUsage({
      capability,
      provider: "openai",
      model,
      inputTokens,
      cachedInputTokens: isPlainRecord(details) ? details.cached_tokens : undefined,
      outputTokens,
    });
    return;
  }
  reportAiCostUsage({ capability, provider: "openai", model, costInUsdTicks: usage?.cost_in_usd_ticks });
}

/** reportAnthropicUsage 的入参。 */
export interface AnthropicUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** Anthropic Messages 响应中的 usage 对象。 */
  readonly usage: Anthropic.Beta.BetaUsage | undefined;
  /** 同一响应的实际检索次数；缺省表示无检索。 */
  readonly searchCalls?: number;
}

/**
 * 上报 Anthropic Messages 响应用量，将 input_tokens、cache_creation_input_tokens 与 cache_read_input_tokens 折算为总输入与缓存分量。
 * @param params Anthropic Messages 响应的用量上报参数。
 */
export function reportAnthropicUsage({ capability, model, usage, searchCalls = 0 }: AnthropicUsageReport): void {
  if (usage !== undefined && (usage === null || typeof usage !== "object" || Array.isArray(usage))) {
    warnAiUsageUnavailable(capability, "anthropic", "invalid");
    reportAiSearchUsage({ capability, provider: "anthropic", model, searchCalls });
    return;
  }
  const input: number | undefined = usage?.input_tokens;
  const creation: number | null | undefined = usage?.cache_creation_input_tokens;
  const read: number | null | undefined = usage?.cache_read_input_tokens;
  if ((input !== undefined && !isTokenCount(input)) ||
    (creation !== undefined && creation !== null && !isTokenCount(creation)) ||
    (read !== undefined && read !== null && !isTokenCount(read))) {
    warnAiUsageUnavailable(capability, "anthropic", "invalid");
    reportAiSearchUsage({ capability, provider: "anthropic", model, searchCalls });
    return;
  }
  reportAiCacheUsage({
    capability,
    provider: "anthropic",
    model,
    inputTokens: typeof input === "number" ? input + (creation ?? 0) + (read ?? 0) : input,
    cachedInputTokens: read ?? undefined,
    cacheWriteInputTokens: creation ?? undefined,
    outputTokens: usage?.output_tokens,
    searchCalls,
  });
}

/**
 * 提取 OpenAI 响应中的缓存命中 token（优先读取 details.cached_tokens，回退读取顶层 prompt_cache_hit_tokens）。
 * @param usage OpenAI 响应的顶层 usage 对象。
 * @param details 输入或提示词 token 的细分详情对象。
 * @returns 原始缓存命中 token 字段值；未提供时返回 undefined。
 */
function openAiCachedTokens(usage: object | undefined, details: object | null | undefined): unknown {
  if (usage === undefined) return undefined;
  const cached: unknown = (details as { cached_tokens?: unknown } | null | undefined)?.cached_tokens;
  if (cached !== undefined) return cached;
  return (usage as Readonly<Record<string, unknown>>).prompt_cache_hit_tokens;
}

/**
 * 提取 OpenAI 响应 details 中的缓存写入 token（cache_write_tokens）。
 * @param details 输入或提示词 token 的细分详情对象。
 * @returns 原始缓存写入 token 字段值；未提供时返回 undefined。
 */
function openAiCacheWriteTokens(details: object | null | undefined): unknown {
  return (details as { cache_write_tokens?: unknown } | null | undefined)?.cache_write_tokens;
}

/** reportOpenAiResponsesUsage 的入参。 */
export interface OpenAiResponsesUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** OpenAI Responses 响应中的 usage 对象。 */
  readonly usage: OpenAI.Responses.ResponseUsage | undefined;
  /** 同一响应的实际检索次数。 */
  readonly searchCalls: number;
}

/**
 * 上报 OpenAI Responses 响应用量。
 * @param params OpenAI Responses 响应的用量上报参数。
 */
export function reportOpenAiResponsesUsage({ capability, model, usage, searchCalls }: OpenAiResponsesUsageReport): void {
  reportAiCacheUsage({
    capability,
    provider: "openai",
    model,
    inputTokens: usage?.input_tokens,
    cachedInputTokens: openAiCachedTokens(usage, usage?.input_tokens_details),
    cacheWriteInputTokens: openAiCacheWriteTokens(usage?.input_tokens_details),
    outputTokens: usage?.output_tokens,
    searchCalls,
  });
}

/** reportOpenAiChatUsage 的入参。 */
export interface OpenAiChatUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** OpenAI Chat Completions 响应中的 usage 对象。 */
  readonly usage: OpenAI.CompletionUsage | undefined;
}

/**
 * 上报 OpenAI Chat Completions 响应用量。
 * @param params OpenAI Chat Completions 响应的用量上报参数。
 */
export function reportOpenAiChatUsage({ capability, model, usage }: OpenAiChatUsageReport): void {
  reportAiCacheUsage({
    capability,
    provider: "openai",
    model,
    inputTokens: usage?.prompt_tokens,
    cachedInputTokens: openAiCachedTokens(usage, usage?.prompt_tokens_details),
    cacheWriteInputTokens: openAiCacheWriteTokens(usage?.prompt_tokens_details),
    outputTokens: usage?.completion_tokens,
  });
}

/** reportGeminiUsage 的入参。 */
export interface GeminiUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** Gemini generateContent 响应中的 usageMetadata 对象。 */
  readonly usage: GenerateContentResponseUsageMetadata | undefined;
  /** 同一响应的实际检索次数；缺省表示无检索。 */
  readonly searchCalls?: number;
}

/**
 * 上报 Gemini generateContent 响应用量（输入合并 promptTokenCount 与 toolUsePromptTokenCount，未返回 cachedContentTokenCount 时按零命中计入）。
 * @param params Gemini generateContent 响应的用量上报参数。
 */
export function reportGeminiUsage({ capability, model, usage, searchCalls = 0 }: GeminiUsageReport): void {
  if (usage === undefined) {
    warnAiUsageUnavailable(capability, "google", "missing");
    reportAiSearchUsage({ capability, provider: "google", model, searchCalls });
    return;
  }
  if (usage === null || typeof usage !== "object" || Array.isArray(usage) || usage.cachedContentTokenCount === null) {
    warnAiUsageUnavailable(capability, "google", "invalid");
    reportAiSearchUsage({ capability, provider: "google", model, searchCalls });
    return;
  }
  reportAiCacheUsage({
    capability,
    provider: "google",
    model,
    inputTokens: geminiInputTokens(usage.promptTokenCount, usage.toolUsePromptTokenCount),
    cachedInputTokens: usage.cachedContentTokenCount ?? 0,
    outputTokens: geminiOutputTokens(usage.candidatesTokenCount, usage.thoughtsTokenCount),
    searchCalls,
  });
}

/** reportGeminiInteractionUsage 的入参。 */
export interface GeminiInteractionUsageReport {
  /** 调用所属的 AI 能力域。 */
  readonly capability: AiCacheCapability;
  /** 本次请求实际使用的模型名。 */
  readonly model: string;
  /** Gemini Interactions 响应中的 usage 对象。 */
  readonly usage: Interactions.Usage | undefined;
}

/**
 * 上报 Gemini Interactions 响应用量。
 * @param params Gemini Interactions 响应的用量上报参数。
 */
export function reportGeminiInteractionUsage({ capability, model, usage }: GeminiInteractionUsageReport): void {
  if (usage !== undefined && (usage === null || typeof usage !== "object" || Array.isArray(usage))) {
    warnAiUsageUnavailable(capability, "google", "invalid");
    return;
  }
  reportAiCacheUsage({
    capability,
    provider: "google",
    model,
    inputTokens: usage?.total_input_tokens,
    cachedInputTokens: usage?.total_cached_tokens,
    outputTokens: geminiOutputTokens(usage?.total_output_tokens, usage?.total_thought_tokens),
  });
}
