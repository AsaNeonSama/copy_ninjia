/**
 * Gemini `generateContent` 的请求收发、用量上报与响应分类。
 */

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type { Candidate, GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { geminiClientCache } from "../../cache/workers/aiChat/gemini";
import { logger } from "../../infra/logger";
import { reportGeminiUsage } from "../../infra/aiCacheUsage";
import { capabilityClient } from "../capabilityClient";
import {
  GEMINI_API_BASE_URL,
  GEMINI_REQUEST_RETRY_ATTEMPTS,
  GEMINI_REQUEST_TIMEOUTS_MS,
  GEMINI_SAFETY_SETTINGS,
} from "../../consts/aiChat/gemini";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import { diagnosticWithDetails } from "../ai/utils/finishDetails";
import {
  logAndClassifyProviderApiError,
  providerApiFailureResult,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureResult } from "../ai/utils/mediaSupportError";
import { abnormalFinishDiagnostic, countGoogleSearchCalls, geminiFinishDetails, responseText } from "./response";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../types/config";

/**
 * 获取指定能力的本线程 Gemini 客户端实例。
 * @param capability 目标 AI 能力槽位。
 * @returns 对应能力的缓存或新创建的 GoogleGenAI 客户端。
 */
export function getGeminiClient(capability: AgentCapability): GoogleGenAI {
  return capabilityClient({
    provider: "google",
    capability,
    holder: geminiClientCache,
    // 显式置 enterprise: false 并给出官方默认 baseUrl，使 SDK 不回退读取
    // GOOGLE_GENAI_USE_ENTERPRISE / GOOGLE_GENAI_USE_VERTEXAI 与 GOOGLE_GEMINI_BASE_URL 环境变量。
    create: (config: ProviderCapabilityConfig<"google">): GoogleGenAI => new GoogleGenAI({
      apiKey: config.apiKey,
      enterprise: false,
      httpOptions: {
        baseUrl: config.baseUrl ?? GEMINI_API_BASE_URL,
        timeout: GEMINI_REQUEST_TIMEOUTS_MS[capability],
        retryOptions: { attempts: GEMINI_REQUEST_RETRY_ATTEMPTS },
      },
    }),
  });
}

/** `generateContent` 调用参数。 */
export interface GeminiRequestOptions {
  /** 调用对应的 AI 能力槽位。 */
  readonly capability: AgentCapability;
  /** 构造 `GenerateContentParameters` 请求体。 */
  readonly buildBody: () => GenerateContentParameters;
  /** 错误日志中的调用标识。 */
  readonly errorLabel: string;
  /** 会话固定的客户端；缺省时按 capability 获取。 */
  readonly client?: GoogleGenAI;
}

/**
 * 调用一次 `generateContent` 接口并分类响应：调用方主动取消时静默返回 `request` 失败，
 * 其他请求异常或 candidate 收尾异常时记录日志并返回失败结果。
 * @param options `generateContent` 请求配置参数。
 * @returns 分类后的 Gemini 请求结果。
 */
export async function requestGeminiResult({
  capability,
  buildBody,
  errorLabel,
  client,
}: GeminiRequestOptions): Promise<GeminiRequestResult> {
  let body: GenerateContentParameters | undefined;
  let data: GenerateContentResponse;
  try {
    body = buildBody();
    body.config?.abortSignal?.throwIfAborted();
    const requestSignal: AbortSignal = signalWithTimeout(
      body.config?.abortSignal,
      GEMINI_REQUEST_TIMEOUTS_MS[capability]
    );
    requestSignal.throwIfAborted();
    const model: string = String(body.model);
    data = await raceAbortOrThrow((client ?? getGeminiClient(capability)).models.generateContent({
      ...body,
      config: {
        ...body.config,
        safetySettings: [...GEMINI_SAFETY_SETTINGS],
        abortSignal: requestSignal,
      },
    }).then((response: GenerateContentResponse): GenerateContentResponse => {
      reportGeminiUsage({ capability, model, usage: response.usageMetadata, searchCalls: countGoogleSearchCalls(response) });
      return response;
    }), requestSignal);
  } catch (error: unknown) {
    if (body?.config?.abortSignal?.aborted === true) {
      return { ok: false, failureKind: "request" };
    }
    if (error instanceof ApiError) {
      const failure: ProviderApiFailureResult | undefined = providerApiFailureResult(
        logAndClassifyProviderApiError({
          error,
          errorLabel,
          isMediaCapability: capability === "media",
          includeStatusInLog: true,
        })
      );
      if (failure !== undefined) return failure;
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return { ok: false, failureKind: "request" };
  }

  const candidate: Candidate | undefined = data.candidates?.[0];
  if (candidate?.finishReason === FinishReason.MAX_TOKENS) {
    logger.error(
      `${errorLabel} response was truncated by maxOutputTokens ` +
      `(hasPartialText=${!!responseText(data)}, ` +
      `thoughts_tokens=${data.usageMetadata?.thoughtsTokenCount ?? "?"}, ` +
      `max_output_tokens=${body?.config?.maxOutputTokens ?? "?"}).`
    );
  }

  const abnormal: string | null = abnormalFinishDiagnostic(data);
  if (abnormal) {
    const finishDetails: string | undefined = geminiFinishDetails(data);
    logger.error(`${errorLabel} returned an unusable response: ${diagnosticWithDetails(abnormal, finishDetails)}.`);
    return {
      ok: false,
      failureKind: "response",
      finishReason: candidate?.finishReason,
      finishDetails,
      response: data,
    };
  }
  return { ok: true, response: data };
}

/** Gemini 无状态文本调用参数。 */
export interface GeminiTextRequestOptions {
  /** 调用对应的无状态文本或媒体能力槽位。 */
  readonly capability: "summary" | "media" | "text";
  /** 构造 `GenerateContentParameters` 请求体的回调。 */
  readonly buildBody: () => GenerateContentParameters;
  /** 错误日志中的调用标识。 */
  readonly errorLabel: string;
  /** 对模型输出文本做清洗规范化的函数。 */
  readonly normalize: (text: string) => string;
  /** 外部取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 调用 `generateContent` 并返回清洗后的文本结果及可重试标记。
 * @param options 无状态文本调用参数。
 * @returns 清洗后的文本生成结果及失败可重试标记。
 */
export async function requestGeminiTextResult({
  capability,
  buildBody,
  errorLabel,
  normalize,
  signal,
}: GeminiTextRequestOptions): Promise<AiTextResult> {
  const result: GeminiRequestResult = await requestGeminiResult({ capability, buildBody, errorLabel });
  if (signal?.aborted === true) return { ok: false, retryable: false };
  if (!result.ok) {
    return classifyAiTextFailure(result.failureKind, capability);
  }
  const text: string = normalize(responseText(result.response) ?? "");
  return finalizeAiTextResult(text);
}
