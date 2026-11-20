/**
 * Gemini `generateContent` 的请求收发、用量上报与响应分类。
 */

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type { Candidate, GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { geminiClientCache } from "../../../cache/workers/aiChat/gemini";
import { logger } from "../../../infra/logger";
import { reportGeminiUsage } from "../../../infra/aiCacheUsage";
import { capabilityClient } from "../capabilityClient";
import {
  GEMINI_API_BASE_URL,
  GEMINI_REQUEST_RETRY_ATTEMPTS,
  GEMINI_REQUEST_TIMEOUTS_MS,
  GEMINI_SAFETY_SETTINGS,
} from "../../../consts/aiChat/gemini";
import { runWithTimeoutSignal } from "../../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import { handleProviderRequestError } from "../ai/utils/mediaSupportError";
import { abnormalFinishDiagnostic, countGoogleSearchCalls, geminiFinishDetails, responseText } from "../../../aiProviders/gemini/response";
import type { GeminiAbnormalFinishReason, GeminiRequestResult } from "../../../types/aiChat/gemini";
import type { AiTextResult } from "../../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../../types/config";

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
    const requestBody: GenerateContentParameters = body;
    const model: string = String(requestBody.model);
    data = await runWithTimeoutSignal({
      signal: requestBody.config?.abortSignal,
      timeoutMs: GEMINI_REQUEST_TIMEOUTS_MS[capability],
      run: (requestSignal: AbortSignal): Promise<GenerateContentResponse> =>
        (client ?? getGeminiClient(capability)).models.generateContent({
          ...requestBody,
          config: {
            ...requestBody.config,
            safetySettings: [...GEMINI_SAFETY_SETTINGS],
            abortSignal: requestSignal,
          },
        }).then((response: GenerateContentResponse): GenerateContentResponse => {
          reportGeminiUsage({ capability, model, usage: response.usageMetadata, searchCalls: countGoogleSearchCalls(response) });
          return response;
        }),
    });
  } catch (error: unknown) {
    if (body?.config?.abortSignal?.aborted === true) {
      return { ok: false, failureKind: "request" };
    }
    return handleProviderRequestError({
      error,
      provider: "google",
      apiError: error instanceof ApiError ? error : null,
      errorLabel,
      isMediaCapability: capability === "media",
    });
  }

  const candidate: Candidate | undefined = data.candidates?.[0];
  if (candidate?.finishReason === FinishReason.MAX_TOKENS) {
    logger.error("Gemini API response was truncated by maxOutputTokens.", {
      errorLabel,
      hasPartialText: Boolean(responseText(data)),
      thoughtsTokens: data.usageMetadata?.thoughtsTokenCount ?? null,
      maxOutputTokens: body?.config?.maxOutputTokens ?? null,
    });
  }

  const reason: GeminiAbnormalFinishReason | null = abnormalFinishDiagnostic(data);
  if (reason !== null) {
    const finishDetails: string | undefined = geminiFinishDetails(data);
    logger.error("Gemini API returned an unusable response.", {
      errorLabel,
      reason,
      finishReason: candidate?.finishReason ?? null,
      ...(finishDetails !== undefined ? { finishDetails } : {}),
    });
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
