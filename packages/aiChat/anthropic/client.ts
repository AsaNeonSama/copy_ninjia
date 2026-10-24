/**
 * Anthropic Messages API 的请求收发、用量上报与响应分类。
 */

import Anthropic, { BetaFallbackState } from "@anthropic-ai/sdk";
import { anthropicClientCache } from "../../cache/workers/aiChat/anthropic";
import { capabilityClient } from "../capabilityClient";
import { logger } from "../../infra/logger";
import { reportAnthropicUsage } from "../../infra/aiCacheUsage";
import {
  ANTHROPIC_REQUEST_MAX_RETRIES,
  ANTHROPIC_REQUEST_TIMEOUTS_MS,
} from "../../consts/aiChat/anthropic";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import { diagnosticWithDetails } from "../ai/utils/finishDetails";
import {
  logAndClassifyProviderApiError,
  providerApiFailureResult,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureResult } from "../ai/utils/mediaSupportError";
import { anthropicStopDetailsJson, countAnthropicWebSearches, messageText } from "./response";
import { anthropicServedModel, createAnthropicClient, logAnthropicFallback, pinnedFallbackIndex } from "./sdkClient";
import type { AnthropicClient, AnthropicRequestResult } from "../../types/aiChat/anthropic";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../types/config";

/**
 * 获取指定能力的 Anthropic 客户端实例。
 * @param capability 目标 AI 能力槽位。
 * @returns 对应能力的缓存或新创建的 Anthropic 客户端。
 */
export function getAnthropicClient(capability: AgentCapability): AnthropicClient {
  return capabilityClient({
    provider: "anthropic",
    capability,
    holder: anthropicClientCache,
    create: (config: ProviderCapabilityConfig<"anthropic">): AnthropicClient => createAnthropicClient(config, {
      timeoutMs: ANTHROPIC_REQUEST_TIMEOUTS_MS[capability],
      maxRetries: ANTHROPIC_REQUEST_MAX_RETRIES,
    }),
  });
}

/**
 * 判断响应的 `stop_reason` 是否属于不可用的截断状态。
 * @param message Anthropic Beta Messages 响应对象。
 * @returns 若因达到输出上限或超出上下文窗口而截断则返回 `true`，否则返回 `false`。
 */
function isUnusableStopReason(message: Anthropic.Beta.BetaMessage): boolean {
  return message.stop_reason === "max_tokens" ||
    message.stop_reason === "model_context_window_exceeded";
}

/** Anthropic Messages 调用参数。 */
export interface AnthropicRequestOptions {
  /** 调用对应的 AI 能力槽位。 */
  readonly capability: AgentCapability;
  /** 构造非流式 Messages 请求体。 */
  readonly buildBody: () => Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  /** 错误与告警日志前缀标签。 */
  readonly errorLabel: string;
  /** 外部取消信号。 */
  readonly signal?: AbortSignal;
  /** 会话固定的客户端；缺省时按 capability 获取。 */
  readonly client?: AnthropicClient;
  /** 拒答回退中间件的状态对象；缺省时为本次请求新建。 */
  readonly fallbackState?: BetaFallbackState;
}

/**
 * 调用一次 Anthropic Messages 接口并分类结果：调用方主动取消时静默返回 `request` 失败，
 * 其他请求异常、拒答或不可用 `stop_reason` 记录日志并返回对应失败结果；`pause_turn` 按成功返回，交由调用方续发。
 * @param options 请求配置参数。
 * @returns 分类后的 Anthropic Messages 请求结果。
 */
export async function requestAnthropicMessage({
  capability,
  buildBody,
  errorLabel,
  signal,
  client,
  fallbackState = new BetaFallbackState(),
}: AnthropicRequestOptions): Promise<AnthropicRequestResult> {
  const indexBefore: number = pinnedFallbackIndex(fallbackState);
  let requestClient: AnthropicClient | undefined;
  let requestedModel: string | undefined;
  let message: Anthropic.Beta.BetaMessage;
  try {
    signal?.throwIfAborted();
    const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = buildBody();
    const sentClient: AnthropicClient = client ?? getAnthropicClient(capability);
    requestClient = sentClient;
    requestedModel = body.model;
    const requestSignal: AbortSignal = signalWithTimeout(signal, ANTHROPIC_REQUEST_TIMEOUTS_MS[capability]);
    requestSignal.throwIfAborted();
    message = await raceAbortOrThrow(
      sentClient.sdk.beta.messages.create(body, { signal: requestSignal, fallbackState })
        .then((result: Anthropic.Beta.BetaMessage): Anthropic.Beta.BetaMessage => {
          reportAnthropicUsage({
            capability,
            model: anthropicServedModel(sentClient, body.model, fallbackState),
            usage: result.usage,
            searchCalls: countAnthropicWebSearches(result),
          });
          return result;
        }),
      requestSignal
    );
  } catch (error: unknown) {
    if (signal?.aborted === true) return { ok: false, failureKind: "request" };
    if (requestClient !== undefined && requestedModel !== undefined) {
      logAnthropicFallback({ errorLabel, client: requestClient, requestedModel, indexBefore, fallbackState, message: undefined });
    }
    if (error instanceof Anthropic.APIError) {
      const failure: ProviderApiFailureResult | undefined = providerApiFailureResult(
        logAndClassifyProviderApiError({
          error,
          errorLabel,
          isMediaCapability: capability === "media",
        })
      );
      if (failure !== undefined) return failure;
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return { ok: false, failureKind: "request" };
  }
  logAnthropicFallback({ errorLabel, client: requestClient, requestedModel, indexBefore, fallbackState, message });
  const refused: boolean = message.stop_reason === "refusal";
  if (refused || isUnusableStopReason(message)) {
    const stopDetails: string | undefined = anthropicStopDetailsJson(message);
    logger.error(
      `${errorLabel} returned an unusable response: ` +
      `${diagnosticWithDetails(`model=${message.model}, stop_reason=${message.stop_reason}`, stopDetails)} ` +
      `(hasPartialText=${messageText(message).length > 0}).`
    );
    return {
      ok: false,
      failureKind: refused ? "refused" : "response",
      stopReason: message.stop_reason ?? undefined,
      stopDetails,
      message,
    };
  }
  return { ok: true, message };
}

/** Anthropic 无状态文本调用参数。 */
export interface AnthropicTextRequestOptions {
  /** 调用对应的无状态文本或媒体能力槽位。 */
  readonly capability: "summary" | "media" | "text";
  /** 构造非流式 Messages 请求体的回调。 */
  readonly buildBody: () => Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  /** 错误与告警日志前缀标签。 */
  readonly errorLabel: string;
  /** 对模型输出文本做清洗规范化的函数。 */
  readonly normalize: (text: string) => string;
  /** 外部取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 调用 Anthropic Messages 接口并返回清洗后的文本结果及可重试标记。
 * @param options 无状态文本调用参数。
 * @returns 清洗后的文本生成结果及失败可重试标记。
 */
export async function requestAnthropicTextResult({
  capability,
  buildBody,
  errorLabel,
  normalize,
  signal,
}: AnthropicTextRequestOptions): Promise<AiTextResult> {
  const result: AnthropicRequestResult = await requestAnthropicMessage({ capability, buildBody, errorLabel, signal });
  if (signal?.aborted === true) return { ok: false, retryable: false };
  if (!result.ok) return classifyAiTextFailure(result.failureKind, capability);
  return finalizeAiTextResult(normalize(messageText(result.message)));
}
