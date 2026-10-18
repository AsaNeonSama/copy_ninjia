/**
 * OpenAI Responses API 的请求收发、用量上报与响应分类。
 */

import OpenAI from "openai";
import { openAiClientCache } from "../../cache/workers/aiChat/openai";
import { capabilityClient } from "../capabilityClient";
import { logger } from "../../infra/logger";
import { reportOpenAiResponsesUsage } from "../../infra/aiCacheUsage";
import {
  OPENAI_REQUEST_MAX_RETRIES,
  OPENAI_REQUEST_TIMEOUTS_MS,
} from "../../consts/aiChat/openai";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import { diagnosticWithDetails } from "../ai/utils/finishDetails";
import {
  classifyProviderApiFailure,
  numericErrorStatus,
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

/** 获取指定能力的本线程 OpenAI 客户端实例。 */
export function getOpenAiClient(capability: AgentCapability): OpenAI {
  return capabilityClient({
    provider: "openai",
    capability,
    holder: openAiClientCache,
    create: (config: ProviderCapabilityConfig<"openai">): OpenAI => new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: OPENAI_REQUEST_TIMEOUTS_MS[capability],
      maxRetries: OPENAI_REQUEST_MAX_RETRIES,
    }),
  });
}

/** OpenAI Responses 调用参数。 */
export interface OpenAiRequestOptions {
  readonly capability: AgentCapability;
  readonly buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly signal?: AbortSignal;
  /** 会话固定的客户端；缺省时按 capability 获取。 */
  readonly client?: OpenAI;
}

/**
 * 调用一次 OpenAI Responses 接口并分类响应：请求异常、拒答或不可用输出时记录日志并返回失败结果。
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
      const status: number | undefined = numericErrorStatus(error);
      logger.error(`${errorLabel} error: ${error.message}`);
      const failure: ProviderApiFailureResult | undefined = providerApiFailureResult(
        classifyProviderApiFailure(status, error.message, capability === "media")
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
  readonly capability: "summary" | "media" | "text";
  readonly buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
  readonly signal?: AbortSignal;
}

/** 调用 OpenAI Responses 接口并返回清洗后的文本结果及可重试标记。 */
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
