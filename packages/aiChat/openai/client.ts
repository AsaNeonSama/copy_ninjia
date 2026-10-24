/**
 * OpenAI Responses API 的请求收发、用量上报与响应分类。
 */

import OpenAI from "openai";
import { openAiClientCache } from "../../cache/workers/aiChat/openai";
import { capabilityClient } from "../capabilityClient";
import { logger } from "../../infra/logger";
import { reportOpenAiResponsesUsage } from "../../infra/aiCacheUsage";
import {
  OPENAI_API_BASE_URL,
  OPENAI_REQUEST_MAX_RETRIES,
  OPENAI_REQUEST_TIMEOUTS_MS,
  OPENAI_SDK_LOG_LEVEL,
} from "../../consts/aiChat/openai";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import { diagnosticWithDetails } from "../ai/utils/finishDetails";
import {
  logAndClassifyProviderApiError,
  providerApiFailureResult,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureResult } from "../ai/utils/mediaSupportError";
import {
  abnormalResponseDiagnostic,
  countWebSearchCalls,
  isTruncatedByTokenLimit,
  normalizedFinishReason,
  openAiFinishDetails,
  responseOutputText,
} from "./response";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../types/config";

/**
 * 获取指定能力的本线程 OpenAI 客户端实例。
 * @param capability 目标 AI 能力槽位。
 * @returns 对应能力的缓存或新创建的 OpenAI 客户端。
 */
export function getOpenAiClient(capability: AgentCapability): OpenAI {
  return capabilityClient({
    provider: "openai",
    capability,
    holder: openAiClientCache,
    // 显式给出官方默认 baseURL 与日志级别，并将 organization/project/webhookSecret 置 null，使 SDK 不回退读取
    // OPENAI_BASE_URL / OPENAI_LOG / OPENAI_ORG_ID / OPENAI_PROJECT_ID / OPENAI_WEBHOOK_SECRET 环境变量；
    // 构造参数关不掉的 OPENAI_CUSTOM_HEADERS 由 consts/paths.ts 在加载时拒绝。
    create: (config: ProviderCapabilityConfig<"openai">): OpenAI => new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? OPENAI_API_BASE_URL,
      organization: null,
      project: null,
      webhookSecret: null,
      logLevel: OPENAI_SDK_LOG_LEVEL,
      timeout: OPENAI_REQUEST_TIMEOUTS_MS[capability],
      maxRetries: OPENAI_REQUEST_MAX_RETRIES,
    }),
  });
}

/** OpenAI Responses 调用参数。 */
export interface OpenAiRequestOptions {
  /** 调用对应的 AI 能力槽位。 */
  readonly capability: AgentCapability;
  /** 构造非流式 Responses 请求体的回调。 */
  readonly buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming;
  /** 错误日志中的调用标识。 */
  readonly errorLabel: string;
  /** 外部取消信号。 */
  readonly signal?: AbortSignal;
  /** 会话固定的客户端；缺省时按 capability 获取。 */
  readonly client?: OpenAI;
}

/**
 * 调用一次 OpenAI Responses 接口并分类响应：调用方主动取消时静默返回 `request` 失败，
 * 其他请求异常、拒答（归入 `failureKind: "response"` 且 `finishReason: "refusal"`）或不可用输出时记录日志并返回失败结果。
 * @param options Responses 请求配置参数。
 * @returns 分类后的 OpenAI Responses 请求结果。
 */
export async function requestOpenAiResult({
  capability,
  buildBody,
  errorLabel,
  signal,
  client,
}: OpenAiRequestOptions): Promise<OpenAiRequestResult> {
  let body: OpenAI.Responses.ResponseCreateParamsNonStreaming;
  let response: OpenAI.Responses.Response;
  try {
    signal?.throwIfAborted();
    body = buildBody();
    const requestSignal: AbortSignal = signalWithTimeout(signal, OPENAI_REQUEST_TIMEOUTS_MS[capability]);
    requestSignal.throwIfAborted();
    const model: string = String(body.model);
    response = await raceAbortOrThrow(
      (client ?? getOpenAiClient(capability)).responses.create(body, { signal: requestSignal })
        .then((result: OpenAI.Responses.Response): OpenAI.Responses.Response => {
          reportOpenAiResponsesUsage({ capability, model, usage: result.usage, searchCalls: countWebSearchCalls(result) });
          return result;
        }),
      requestSignal
    );
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      return { ok: false, failureKind: "request" };
    }
    if (error instanceof OpenAI.APIError) {
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

  if (isTruncatedByTokenLimit(response)) {
    logger.error(
      `${errorLabel} response was truncated by max_output_tokens ` +
      `(hasPartialText=${responseOutputText(response).length > 0}, ` +
      `reasoning_tokens=${response.usage?.output_tokens_details?.reasoning_tokens ?? "?"}, ` +
      `max_output_tokens=${body.max_output_tokens ?? "?"}).`
    );
  }

  const abnormal: string | null = abnormalResponseDiagnostic(response);
  if (abnormal) {
    const finishDetails: string | undefined = openAiFinishDetails(response);
    logger.error(`${errorLabel} returned an unusable response: ${diagnosticWithDetails(abnormal, finishDetails)}.`);
    return {
      ok: false,
      failureKind: "response",
      finishReason: normalizedFinishReason(response),
      finishDetails,
      response,
    };
  }
  return { ok: true, response };
}

/** OpenAI 无状态文本调用参数。 */
export interface OpenAiTextRequestOptions {
  /** 调用对应的无状态文本或媒体能力槽位。 */
  readonly capability: "summary" | "media" | "text";
  /** 构造非流式 Responses 请求体的回调。 */
  readonly buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming;
  /** 错误日志中的调用标识。 */
  readonly errorLabel: string;
  /** 对模型输出文本做清洗规范化的函数。 */
  readonly normalize: (text: string) => string;
  /** 外部取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 调用 OpenAI Responses 接口并返回清洗后的文本结果及可重试标记。
 * @param options 无状态文本调用参数。
 * @returns 清洗后的文本生成结果及失败可重试标记。
 */
export async function requestOpenAiTextResult({
  capability,
  buildBody,
  errorLabel,
  normalize,
  signal,
}: OpenAiTextRequestOptions): Promise<AiTextResult> {
  const result: OpenAiRequestResult = await requestOpenAiResult({
    capability,
    buildBody,
    errorLabel,
    signal,
  });
  if (signal?.aborted === true) return { ok: false, retryable: false };
  if (!result.ok) return classifyAiTextFailure(result.failureKind, capability);
  const text: string = normalize(responseOutputText(result.response));
  return finalizeAiTextResult(text);
}
