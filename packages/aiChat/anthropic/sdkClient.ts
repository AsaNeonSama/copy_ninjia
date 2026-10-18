/**
 * Anthropic SDK 客户端构造、实际服务模型名解析与拒答回退日志辅助。
 */

import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { BetaFallbackState } from "@anthropic-ai/sdk";
import { logger } from "../../infra/logger";
import { anthropicFallbackSummary } from "./response";
import type { AnthropicClient } from "../../types/aiChat/anthropic";
import type { AnthropicAgentCapabilityConfig } from "../../types/config";

/** createAnthropicClient 的 SDK 构造参数。 */
export interface AnthropicClientOptions {
  readonly timeoutMs: number;
  /** SDK 自动重试次数（不含首次请求）。 */
  readonly maxRetries: number;
}

/**
 * 按能力配置构造 Anthropic 客户端；配置了 `fallbackModel` 时挂载拒答回退中间件。
 */
export function createAnthropicClient(
  config: AnthropicAgentCapabilityConfig,
  { timeoutMs, maxRetries }: AnthropicClientOptions
): AnthropicClient {
  return {
    sdk: new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      defaultHeaders: config.headers,
      timeout: timeoutMs,
      maxRetries,
      middleware: config.fallbackModel === undefined
        ? undefined
        : [betaRefusalFallbackMiddleware([{ model: config.fallbackModel }])],
    }),
    fallbackModel: config.fallbackModel,
  };
}

/** 读取 `fallbackState` 当前钉住的回退链下标；未触发回退时返回负数。 */
export function pinnedFallbackIndex(fallbackState: BetaFallbackState): number {
  return fallbackState.index ?? -1;
}

/**
 * 解析本次请求实际服务方模型名：已固定到回退项时返回 `fallbackModel`，否则返回 `requestedModel`。
 */
export function anthropicServedModel(
  client: AnthropicClient,
  requestedModel: string,
  fallbackState: BetaFallbackState
): string {
  return pinnedFallbackIndex(fallbackState) < 0 || client.fallbackModel === undefined
    ? requestedModel
    : client.fallbackModel;
}

/** logAnthropicFallback 的入参。 */
export interface LogAnthropicFallbackOptions {
  readonly errorLabel: string;
  readonly client: AnthropicClient;
  readonly requestedModel: string;
  /** 本次调用发出前的 `pinnedFallbackIndex`。 */
  readonly indexBefore: number;
  readonly fallbackState: BetaFallbackState;
  /** 本次调用返回的响应；请求抛错时为 undefined。 */
  readonly message: Anthropic.Beta.BetaMessage | undefined;
}

/**
 * 当本次请求在拒答后首次改道至回退模型时记录告警日志。
 */
export function logAnthropicFallback({
  errorLabel,
  client,
  requestedModel,
  indexBefore,
  fallbackState,
  message,
}: LogAnthropicFallbackOptions): void {
  const summary: string | undefined = message === undefined ? undefined : anthropicFallbackSummary(message);
  if (summary !== undefined) {
    logger.warn(`${errorLabel} fell back after a refusal: ${summary}.`);
    return;
  }
  if (indexBefore >= 0 || pinnedFallbackIndex(fallbackState) < 0) return;
  const route: string = `from=${requestedModel}, to=${client.fallbackModel}`;
  logger.warn(message === undefined
    ? `${errorLabel} fell back after a refusal: ${route}; the fallback request did not complete.`
    : `${errorLabel} fell back after a refusal: ${route}; the fallback model returned stop_reason=${message.stop_reason}.`);
}
