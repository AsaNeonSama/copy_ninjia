/**
 * Google GenAI 协议的广告检测传输层；提示词拼装与 JSON 收窄由 workers/antiRaid/adDetect/classifier.ts 负责。
 *
 * 系统指令携带判定规则与部署示例（params.instructions），用户消息依次携带系统事实（params.fact）与待判定正文，
 * 保持前缀稳定以复用 Gemini 服务端隐式缓存。
 */

import { ApiError, GoogleGenAI } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import { adDetectStopping } from "../../../../cache/workers/antiRaid/adDetect";
import { adDetectGoogleClientHolder } from "../../../../cache/workers/antiRaid/google";
import { getAdDetectAgentConfig } from "../../../../config/agent";
import {
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
  AD_DETECT_JSON_SCHEMA,
} from "../../../../consts/antiRaid/adDetect";
import { requestAdDetectJsonWithRetry } from "./emptyBodyRetry";
import { GEMINI_API_BASE_URL, GEMINI_SAFETY_SETTINGS } from "../../../../consts/aiChat/gemini";
import { logger } from "../../../../infra/logger";
import { reportGeminiUsage } from "../../../../infra/aiCacheUsage";
import { abnormalFinishDiagnostic, geminiFinishDetails } from "../../../../aiProviders/gemini/response";
import type { AdDetectAgentConfig } from "../../../../types/config";
import type { AdDetectJsonRequestParams } from "../../../../types/antiRaid/adDetect";
import type { GeminiAbnormalFinishReason } from "../../../../types/aiChat/gemini";

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

/** 一次请求成功后的结果。 */
interface GoogleAdDetectAttempt {
  /** 去掉首尾空白的正文；收尾异常或没产出时为空串。 */
  readonly body: string;
  /** 收尾异常的分类原因（来自 aiProviders/gemini/response.ts 的 abnormalFinishDiagnostic）；正常收尾时为 null。 */
  readonly abnormalReason: GeminiAbnormalFinishReason | null;
  /** 首个 candidate 的原始 `finishReason`；无 candidate 或缺省时为 null。 */
  readonly finishReason: string | null;
  /** Gemini 收尾详情 JSON 串（来自 aiProviders/gemini/response.ts 的 geminiFinishDetails）；没有详情时为 null。 */
  readonly finishDetails: string | null;
}

/**
 * 发一次结构化 JSON 请求并收窄结果；始终携带完整系统指令以依赖服务端隐式前缀缓存，异常时记日志并返回 null。
 * @param params 结构化广告判定请求参数。
 * @returns 单次尝试结果；请求异常时返回 null。
 */
async function attemptGoogleAdDetectJson({
  model,
  instructions,
  fact,
  userContent,
  maxOutputTokens,
  errorLabel,
}: AdDetectJsonRequestParams): Promise<GoogleAdDetectAttempt | null> {
  try {
    const response: GenerateContentResponse = await getAdDetectGoogleClient().models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: fact }, { text: userContent }] }],
      config: {
        systemInstruction: instructions,
        safetySettings: [...GEMINI_SAFETY_SETTINGS],
        maxOutputTokens,
        responseMimeType: "application/json",
        responseJsonSchema: AD_DETECT_JSON_SCHEMA,
      },
    });
    reportGeminiUsage({ capability: "ad_detect", model, usage: response.usageMetadata });
    const finishReason: string | null = response.candidates?.[0]?.finishReason ?? null;
    const abnormalReason: GeminiAbnormalFinishReason | null = abnormalFinishDiagnostic(response);
    if (abnormalReason !== null) {
      return { body: "", abnormalReason, finishReason, finishDetails: geminiFinishDetails(response) ?? null };
    }
    return { body: response.text?.trim() ?? "", abnormalReason: null, finishReason, finishDetails: null };
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      logger.error(
        "Ad detection API request failed.",
        { errorLabel, status: error.status, errorMessage: error.message }
      );
    } else {
      logger.error("Ad detection request failed:", { errorLabel }, error);
    }
    return null;
  }
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
  return requestAdDetectJsonWithRetry<GoogleAdDetectAttempt>({
    attemptRequest: (): Promise<GoogleAdDetectAttempt | null> => attemptGoogleAdDetectJson(params),
    extractUsableBody: (result: GoogleAdDetectAttempt): string | null =>
      result.body.length > 0 ? result.body : null,
    shouldContinue: (): boolean => !adDetectStopping.current,
    logExhausted: (result: GoogleAdDetectAttempt, attempts: number): void => {
      logger.error(
        "Ad detection request returned no usable body.",
        {
          errorLabel: params.errorLabel,
          attempts,
          abnormalReason: result.abnormalReason,
          finishReason: result.finishReason,
          finishDetails: result.finishDetails,
        }
      );
    },
  });
}
