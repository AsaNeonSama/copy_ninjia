/**
 * Anthropic SDK 客户端构造、实际服务模型名解析与拒答回退日志辅助。
 */

import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { BetaFallbackState } from "@anthropic-ai/sdk";
import { ANTHROPIC_API_BASE_URL, ANTHROPIC_SDK_LOG_LEVEL } from "../../consts/aiChat/anthropic";
import { logger } from "../../infra/logger";
import { anthropicFallbackSummary } from "./response";
import type { AnthropicClient } from "../../types/aiChat/anthropic";
import type { AnthropicAgentCapabilityConfig } from "../../types/config";

/** createAnthropicClient 的 SDK 构造参数。 */
export interface AnthropicClientOptions {
  /** 单次请求超时时间（毫秒）。 */
  readonly timeoutMs: number;
  /** SDK 自动重试次数（不含首次请求）。 */
  readonly maxRetries: number;
}

/**
 * 按能力配置构造 Anthropic 客户端；配置了 `fallbackModel` 时挂载拒答回退中间件。
 * @param config Anthropic 能力配置。
 * @param options SDK 超时与重试参数。
 * @returns 封装了 SDK 实例与可选回退模型名的客户端对象。
 */
export function createAnthropicClient(
  config: AnthropicAgentCapabilityConfig,
  { timeoutMs, maxRetries }: AnthropicClientOptions
): AnthropicClient {
  return {
    // 显式给出官方默认 baseURL 与日志级别，使 SDK 不回退读取 ANTHROPIC_BASE_URL / ANTHROPIC_LOG 环境变量；
    // 构造参数关不掉的 ANTHROPIC_CUSTOM_HEADERS 由 consts/paths.ts 在加载时拒绝。
    sdk: new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? ANTHROPIC_API_BASE_URL,
      logLevel: ANTHROPIC_SDK_LOG_LEVEL,
      timeout: timeoutMs,
      maxRetries,
      middleware: config.fallbackModel === undefined
        ? undefined
        : [betaRefusalFallbackMiddleware([{ model: config.fallbackModel }])],
    }),
    fallbackModel: config.fallbackModel,
  };
}

/**
 * 读取 `fallbackState` 当前钉住的回退链下标；未触发回退时返回负数。
 * @param fallbackState 拒答回退中间件状态对象。
 * @returns 已钉住的回退链下标；未触发回退时返回 `-1`。
 */
export function pinnedFallbackIndex(fallbackState: BetaFallbackState): number {
  return fallbackState.index ?? -1;
}

/**
 * 解析本次请求实际服务方模型名：已固定到回退项时返回 `fallbackModel`，否则返回 `requestedModel`。
 * @param client Anthropic 客户端对象。
 * @param requestedModel 请求体中声明的主模型名。
 * @param fallbackState 拒答回退中间件状态对象。
 * @returns 实际处理本次请求的模型名称。
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
  /** 错误日志前缀标签。 */
  readonly errorLabel: string;
  /** 本次请求使用的 Anthropic 客户端。 */
  readonly client: AnthropicClient;
  /** 请求体中指定的主模型名。 */
  readonly requestedModel: string;
  /** 本次调用发出前的 `pinnedFallbackIndex`。 */
  readonly indexBefore: number;
  /** 拒答回退中间件状态对象。 */
  readonly fallbackState: BetaFallbackState;
  /** 本次调用返回的响应；请求抛错时为 undefined。 */
  readonly message: Anthropic.Beta.BetaMessage | undefined;
}

/**
 * 当本次请求在拒答后首次改道至回退模型时记录告警日志。
 * @param options 回退日志记录参数。
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
