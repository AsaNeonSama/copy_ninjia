/**
 * Anthropic Messages（beta 端点）的广告检测传输层（官方 @anthropic-ai/sdk）。
 * 提示词拼装与 JSON 收窄由 workers/antiRaid/adDetect/classifier.ts 负责。
 *
 * 系统提示词分段携带判定规则与部署示例（params.instructions，配置缓存断点）及系统事实（params.fact）；
 * 输出经 `output_config.format`（json_schema）约束为 AD_DETECT_JSON_SCHEMA。客户端构造、拒答回退、
 * 用量上报与回退诊断复用 aiProviders/anthropic/sdkClient.ts，单例持有于 cache/workers/antiRaid/anthropic.ts。
 */

import Anthropic, { BetaFallbackState } from "@anthropic-ai/sdk";
import { adDetectStopping } from "../../../../cache/workers/antiRaid/adDetect";
import { adDetectAnthropicClientHolder } from "../../../../cache/workers/antiRaid/anthropic";
import { logger } from "../../../../infra/logger";
import { reportAnthropicUsage } from "../../../../infra/aiCacheUsage";
import { anthropicStopDetailsJson, messageText } from "../../../../aiProviders/anthropic/response";
import {
  anthropicServedModel,
  createAnthropicClient,
  logAnthropicFallback,
  pinnedFallbackIndex,
} from "../../../../aiProviders/anthropic/sdkClient";
import { getAdDetectAgentConfig } from "../../../../config/agent";
import {
  AD_DETECT_ANTHROPIC_REQUEST_MAX_RETRIES,
  AD_DETECT_ANTHROPIC_REQUEST_TIMEOUT_MS,
  AD_DETECT_JSON_SCHEMA,
} from "../../../../consts/antiRaid/adDetect";
import { requestAdDetectJsonWithRetry } from "./emptyBodyRetry";
import type { AnthropicClient } from "../../../../types/aiChat/anthropic";
import type { AdDetectAgentConfig } from "../../../../types/config";
import type { AdDetectJsonRequestParams } from "../../../../types/antiRaid/adDetect";

/**
 * 取得线程内唯一 Anthropic 广告检测客户端（构造见 createAnthropicClient）。
 * @returns Anthropic 广告检测客户端包装实例。
 */
function getAdDetectAnthropicClient(): AnthropicClient {
  const config: AdDetectAgentConfig = getAdDetectAgentConfig();
  if (config.provider !== "anthropic") {
    throw new Error('Agent capability "ad_detect" is not configured for the Anthropic provider.');
  }
  adDetectAnthropicClientHolder.current ??= createAnthropicClient(config, {
    timeoutMs: AD_DETECT_ANTHROPIC_REQUEST_TIMEOUT_MS,
    maxRetries: AD_DETECT_ANTHROPIC_REQUEST_MAX_RETRIES,
  });
  return adDetectAnthropicClientHolder.current;
}

/** 一次尝试的结果；null 表示请求失败且已经记日志。 */
interface AnthropicAdDetectAttempt {
  /** 模型正文；空串表示这一轮什么都没产出。 */
  readonly body: string;
  /** 拒答收尾（配置了 fallback_model 时回退模型也拒答）。 */
  readonly refused: boolean;
  /** 额度用尽或上下文超长收尾，正文不可用。 */
  readonly unusable: boolean;
  /** 实际服务本次响应的模型 ID。 */
  readonly model: string;
  /** 响应结束原因（`stop_reason`）；缺失时为 null。 */
  readonly stopReason: string | null;
  /** `stop_details` 去掉回退额度令牌后的诊断串（见 aiProviders/anthropic/response.ts 的 anthropicStopDetailsJson）；没有详情时为 null。 */
  readonly stopDetails: string | null;
}

/**
 * 发一次请求并收窄结果；异常就地归一成 null。本次请求改道到回退模型时按 logAnthropicFallback 记一条 warn。
 * @param params 结构化广告判定请求参数。
 * @returns 单次尝试结果；请求异常时返回 null。
 */
async function attemptAnthropicAdDetectJson({
  model,
  instructions,
  fact,
  userContent,
  maxOutputTokens,
  errorLabel,
}: AdDetectJsonRequestParams): Promise<AnthropicAdDetectAttempt | null> {
  const fallbackState: BetaFallbackState = new BetaFallbackState();
  const indexBefore: number = pinnedFallbackIndex(fallbackState);
  let client: AnthropicClient | undefined;
  try {
    client = getAdDetectAnthropicClient();
    const message: Anthropic.Beta.BetaMessage = await client.sdk.beta.messages.create({
      model,
      max_tokens: maxOutputTokens,
      system: [
        { type: "text", text: instructions, cache_control: { type: "ephemeral" } },
        { type: "text", text: fact },
      ],
      messages: [{ role: "user", content: userContent }],
      output_config: {
        format: {
          type: "json_schema",
          schema: AD_DETECT_JSON_SCHEMA,
        },
      },
    }, { fallbackState });
    reportAnthropicUsage({ capability: "ad_detect", model: anthropicServedModel(client, model, fallbackState), usage: message.usage });
    logAnthropicFallback({ errorLabel, client, requestedModel: model, indexBefore, fallbackState, message });
    return {
      body: messageText(message),
      refused: message.stop_reason === "refusal",
      unusable: message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded",
      model: message.model,
      stopReason: message.stop_reason ?? null,
      stopDetails: anthropicStopDetailsJson(message) ?? null,
    };
  } catch (error: unknown) {
    if (client !== undefined) {
      logAnthropicFallback({ errorLabel, client, requestedModel: model, indexBefore, fallbackState, message: undefined });
    }
    if (error instanceof Anthropic.APIError) {
      logger.error(
        "Ad detection API request failed.",
        { errorLabel, errorMessage: error.message }
      );
    } else {
      logger.error("Ad detection request failed:", { errorLabel }, error);
    }
    return null;
  }
}

/**
 * 发一次要求 JSON 输出的 Messages 请求。拒答立即放弃，不重采样；成功响应正文为空、被截断或上下文超长时按
 * AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS 有界重采样；请求异常已经由 SDK 重试过，不在业务层叠加。
 * @param params 结构化广告判定请求参数。
 * @returns 可用的模型 JSON 响应正文；拒答、重试耗尽或请求失败时返回 null。
 */
export async function requestAnthropicAdDetectJson(
  params: AdDetectJsonRequestParams
): Promise<string | null> {
  return requestAdDetectJsonWithRetry<AnthropicAdDetectAttempt>({
    attemptRequest: (): Promise<AnthropicAdDetectAttempt | null> => attemptAnthropicAdDetectJson(params),
    extractUsableBody: (result: AnthropicAdDetectAttempt): string | null =>
      !result.refused && !result.unusable && result.body.trim().length > 0 ? result.body : null,
    canRetry: (result: AnthropicAdDetectAttempt): boolean => !result.refused,
    shouldContinue: (): boolean => !adDetectStopping.current,
    logExhausted: (result: AnthropicAdDetectAttempt, attempts: number): void => {
      logger.error(
        "Ad detection request produced no usable body.",
        {
          errorLabel: params.errorLabel,
          attempts,
          model: result.model,
          stopReason: result.stopReason,
          stopDetails: result.stopDetails,
          hasPartialText: result.body.length > 0,
          maxTokens: params.maxOutputTokens,
        }
      );
    },
  });
}
