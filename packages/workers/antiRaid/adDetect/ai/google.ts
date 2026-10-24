/**
 * Google GenAI 协议的广告检测传输层；提示词拼装与 JSON 收窄由 workers/antiRaid/adDetect/classifier.ts 负责。
 *
 * 系统指令携带判定规则与部署示例（params.instructions），用户消息依次携带系统事实（params.fact）与待判定正文。
 * 显式缓存可用时经 AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE（见 infra/geminiContextCache.ts）引用 cachedContent；
 * 若缓存引用被端点拒绝（isGeminiContextCacheRejection），释放缓存登记并回退为带 systemInstruction 的完整请求重发。
 */

import { ApiError, GoogleGenAI } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import { adDetectGoogleClientHolder } from "../../../../cache/workers/antiRaid/google";
import { antiRaidDispatchSignal } from "../../../../cache/workers/antiRaid/tasks";
import {
  adDetectGeminiCacheContent,
  adDetectGeminiContextCache,
} from "../../../../cache/workers/antiRaid/geminiContextCache";
import { getAdDetectAgentConfig } from "../../../../config/agent";
import {
  AD_DETECT_GEMINI_CACHE_DISPLAY_NAME_PREFIX,
  AD_DETECT_GEMINI_CACHE_ERROR_LABEL,
  AD_DETECT_GEMINI_CACHE_MAX_SLOTS,
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
  AD_DETECT_JSON_SCHEMA,
} from "../../../../consts/antiRaid/adDetect";
import { GEMINI_API_BASE_URL } from "../../../../consts/aiChat/gemini";
import { logger } from "../../../../infra/logger";
import { reportGeminiUsage } from "../../../../infra/aiCacheUsage";
import { abnormalFinishDiagnostic, geminiFinishDetails } from "../../../../aiChat/gemini/response";
import { diagnosticWithDetails } from "../../../../aiChat/ai/utils/finishDetails";
import {
  acquireGeminiContextCache,
  createGeminiContextCacheRegistry,
  geminiContextCacheContent,
  isGeminiContextCacheRejection,
  releaseGeminiContextCache,
} from "../../../../infra/geminiContextCache";
import type { AdDetectAgentConfig } from "../../../../types/config";
import type { AdDetectJsonRequestParams } from "../../../../types/antiRaid/adDetect";
import type {
  GeminiContextCacheContent,
  GeminiContextCacheRegistry,
  GeminiContextCacheScope,
} from "../../../../types/geminiContextCache";

/**
 * 取得 Anti-Raid Worker 内唯一的 Google 广告检测客户端。
 * @returns Google GenAI 客户端实例。
 */
function getAdDetectGoogleClient(): GoogleGenAI {
  const config: AdDetectAgentConfig = getAdDetectAgentConfig();
  if (config.provider !== "google") {
    throw new Error('Agent capability "ad_detect" is not configured for the Google provider.');
  }
  adDetectGoogleClientHolder.current ??= new GoogleGenAI({
    apiKey: config.apiKey,
    enterprise: false,
    httpOptions: {
      baseUrl: config.baseUrl ?? GEMINI_API_BASE_URL,
      timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: AD_DETECT_GOOGLE_REQUEST_ATTEMPTS },
    },
  });
  return adDetectGoogleClientHolder.current;
}

/**
 * ad_detect 的显式缓存 scope：缓存内容只有「判定规则 + 部署示例」，登记表按当下
 * ad_detect 客户端初始化；后台请求使用 Anti-Raid Worker 的尽力而为派发信号，停机后
 * 随之取消；创建的输入 token 以 ad_detect 能力上报。
 */
export const AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE: Readonly<GeminiContextCacheScope> = {
  registry(): GeminiContextCacheRegistry {
    adDetectGeminiContextCache.current ??= createGeminiContextCacheRegistry(getAdDetectGoogleClient());
    return adDetectGeminiContextCache.current;
  },
  model(): string {
    return getAdDetectAgentConfig().model;
  },
  signal: antiRaidDispatchSignal,
  displayNamePrefix: AD_DETECT_GEMINI_CACHE_DISPLAY_NAME_PREFIX,
  maxSlots: AD_DETECT_GEMINI_CACHE_MAX_SLOTS,
  capability: "ad_detect",
  errorLabel: AD_DETECT_GEMINI_CACHE_ERROR_LABEL,
};

/**
 * 本次要缓存的内容；模型与系统指令都没变时直接复用已算好的指纹。
 * @param model Gemini 模型名。
 * @param instructions 系统指令文本（判定规则 + 部署示例）。
 * @returns 带指纹的显式上下文缓存内容描述符。
 */
function cacheContentOf(model: string, instructions: string): GeminiContextCacheContent {
  const cached: GeminiContextCacheContent | null = adDetectGeminiCacheContent.current;
  if (cached !== null && cached.model === model && cached.systemInstruction === instructions) return cached;
  const content: GeminiContextCacheContent = geminiContextCacheContent({ model, systemInstruction: instructions });
  adDetectGeminiCacheContent.current = content;
  return content;
}

/**
 * 发一次 generateContent；cachedContent 非空时引用显式缓存、不带系统指令。
 * @param params 结构化广告判定请求参数。
 * @param cachedContent 显式上下文缓存资源名；未使用缓存时为 null。
 * @returns Gemini `generateContent` 响应 Promise。
 */
function generateAdDetectContent(
  { model, instructions, fact, userContent, maxOutputTokens }: AdDetectJsonRequestParams,
  cachedContent: string | null
): Promise<GenerateContentResponse> {
  return getAdDetectGoogleClient().models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: fact }, { text: userContent }] }],
    config: {
      cachedContent: cachedContent ?? undefined,
      systemInstruction: cachedContent === null ? instructions : undefined,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseJsonSchema: AD_DETECT_JSON_SCHEMA,
    },
  });
}

/**
 * 记录 Google 广告检测调用异常日志。
 * @param errorLabel 日志错误标签。
 * @param error 捕获到的异常对象。
 */
function logGoogleFailure(errorLabel: string, error: unknown): void {
  if (error instanceof ApiError) {
    logger.error(`${errorLabel} failed: ${error.status} ${error.message}`);
  } else {
    logger.error(`Error calling ${errorLabel}:`, error);
  }
}

/** 一次请求成功后的结果。 */
interface GoogleAdDetectAttempt {
  /** 去掉首尾空白的正文；收尾异常或没产出时为空串。 */
  readonly body: string;
  /**
   * 收尾异常的诊断串：aiChat/gemini/response.ts 的 abnormalFinishDiagnostic 连同 geminiFinishDetails；
   * 正常收尾时为 null。
   */
  readonly abnormal: string | null;
}

/**
 * 发一次结构化 JSON 请求；undefined 表示请求失败且已经记日志。
 * @param params 结构化广告判定请求参数。
 * @returns 单次尝试结果；请求失败时返回 undefined。
 */
async function attemptGoogleJson(params: AdDetectJsonRequestParams): Promise<GoogleAdDetectAttempt | undefined> {
  let cachedContent: string | null = null;
  let response: GenerateContentResponse;
  try {
    cachedContent = acquireGeminiContextCache(
      AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE,
      (): GeminiContextCacheContent => cacheContentOf(params.model, params.instructions)
    );
    response = await generateAdDetectContent(params, cachedContent);
  } catch (error: unknown) {
    logGoogleFailure(params.errorLabel, error);
    if (cachedContent === null || !isGeminiContextCacheRejection(error)) return undefined;
    releaseGeminiContextCache(AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE, cachedContent);
    try {
      response = await generateAdDetectContent(params, null);
    } catch (retryError: unknown) {
      logGoogleFailure(params.errorLabel, retryError);
      return undefined;
    }
  }
  reportGeminiUsage({ capability: "ad_detect", model: params.model, usage: response.usageMetadata });
  const abnormal: string | null = abnormalFinishDiagnostic(response);
  if (abnormal !== null) return { body: "", abnormal: diagnosticWithDetails(abnormal, geminiFinishDetails(response)) };
  return { body: response.text?.trim() ?? "", abnormal: null };
}

/**
 * 收尾异常或空正文时有界重试，耗尽后连同最后一次的收尾原因与详情记一条日志；请求异常已经由
 * SDK 按配置重试，不在这里叠加。
 * @param params 结构化广告判定请求参数。
 * @returns 可用的模型 JSON 响应正文；重试耗尽或请求失败时返回 null。
 */
export async function requestGoogleAdDetectJson(
  params: AdDetectJsonRequestParams
): Promise<string | null> {
  for (let attempt: number = 1; attempt <= AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS; attempt++) {
    const result: GoogleAdDetectAttempt | undefined = await attemptGoogleJson(params);
    if (result === undefined) return null;
    if (result.body.length > 0) return result.body;
    if (attempt < AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS) continue;
    logger.error(`${params.errorLabel} returned no usable body in ${attempt} attempt(s) (${result.abnormal ?? "empty body"}).`);
  }
  return null;
}
