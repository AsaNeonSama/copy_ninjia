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
  classifyProviderApiFailure,
  numericErrorStatus,
  providerApiFailureResult,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureResult } from "../ai/utils/mediaSupportError";
import { anthropicStopDetailsJson, countAnthropicWebSearches, messageText } from "./response";
import { anthropicServedModel, createAnthropicClient, logAnthropicFallback, pinnedFallbackIndex } from "./sdkClient";
import type { AnthropicClient, AnthropicRequestResult } from "../../types/aiChat/anthropic";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../types/config";

/** 获取指定能力的 Anthropic 客户端实例。 */
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

/** 判断响应的 `stop_reason` 是否属于不可用的截断状态。 */
function isUnusableStopReason(message: Anthropic.Beta.BetaMessage): boolean {
  return message.stop_reason === "max_tokens" ||
    message.stop_reason === "model_context_window_exceeded";
}

/** Anthropic Messages 调用参数。 */
export interface AnthropicRequestOptions {
  readonly capability: AgentCapability;
  /** 构造非流式 Messages 请求体。 */
  readonly buildBody: () => Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly signal?: AbortSignal;
  /** 会话固定的客户端；缺省时按 capability 获取。 */
  readonly client?: AnthropicClient;
  /** 拒答回退中间件的状态对象；缺省时为本次请求新建。 */
  readonly fallbackState?: BetaFallbackState;
}

/**
 * 调用一次 Anthropic Messages 接口并分类结果：请求异常、拒答或不可用 `stop_reason` 返回失败结果并记录日志；
 * `pause_turn` 按成功返回，交由调用方续发。
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
      logger.error(`${errorLabel} error: ${error.message}`);
      const failure: ProviderApiFailureResult | undefined = providerApiFailureResult(
        classifyProviderApiFailure(numericErrorStatus(error), error.message, capability === "media")
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
  readonly capability: "summary" | "media" | "text";
  readonly buildBody: () => Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
  readonly signal?: AbortSignal;
}

/** 调用 Anthropic Messages 接口并返回清洗后的文本结果及可重试标记。 */
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
