/**
 * OpenAI 兼容 chat completions 的广告检测底层收发（官方 openai SDK）。
 * 本文件只管发请求、记错误日志，不认识任何业务语义；提示词拼装与 JSON 收窄由
 * workers/antiRaid/adDetect/classifier.ts 负责。
 *
 * 超时与瞬时失败重试由 SDK 内建。客户端是 Anti-Raid Worker 的线程内单例，
 * Worker 崩溃重建后由 cache/workers/antiRaid/openai.ts 的空 holder 重建。
 */

import OpenAI from "openai";
import { finishDetailsJson } from "../../../../aiProviders/finishDetails";
import { isExplicitUnsupportedMediaError, numericErrorStatus } from "../../../../aiProviders/mediaSupportError";
import { adDetectStopping } from "../../../../cache/workers/antiRaid/adDetect";
import { adDetectOpenAiClientHolder } from "../../../../cache/workers/antiRaid/openai";
import { logger } from "../../../../infra/logger";
import { reportOpenAiChatUsage } from "../../../../infra/aiCacheUsage";
import { errorMessage } from "../../../../libs/errorMessage";
import { getAdDetectAgentConfig } from "../../../../config/agent";
import {
  AD_DETECT_OPENAI_REQUEST_MAX_RETRIES,
  AD_DETECT_OPENAI_REQUEST_TIMEOUT_MS,
} from "../../../../consts/antiRaid/adDetect/limits";
import { formatAdDetectAttachmentLabel } from "../../../../consts/antiRaid/adDetect/prompts";
import { requestAdDetectJsonWithRetry } from "./emptyBodyRetry";
import { OPENAI_API_BASE_URL, OPENAI_SDK_LOG_LEVEL } from "../../../../consts/aiChat/openai";
import type { AdDetectAgentConfig } from "../../../../types/config";
import type {
  AdDetectJsonRequestParams,
  AdDetectMediaAttachment,
  AdDetectProviderResult,
} from "../../../../types/antiRaid/adDetect";

/**
 * 取得线程内唯一 OpenAI 兼容广告检测客户端。
 * @returns OpenAI 兼容客户端实例。
 */
function getAdDetectOpenAiClient(): OpenAI {
  const config: AdDetectAgentConfig = getAdDetectAgentConfig();
  if (config.provider !== "openai") {
    throw new Error('Agent capability "ad_detect" is not configured for the OpenAI provider.');
  }
  adDetectOpenAiClientHolder.current ??= new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl ?? OPENAI_API_BASE_URL,
    organization: null,
    project: null,
    webhookSecret: null,
    logLevel: OPENAI_SDK_LOG_LEVEL,
    timeout: AD_DETECT_OPENAI_REQUEST_TIMEOUT_MS,
    maxRetries: AD_DETECT_OPENAI_REQUEST_MAX_RETRIES,
  });
  return adDetectOpenAiClientHolder.current;
}

/** 一次尝试的结果；null 表示请求失败且已经记日志。 */
interface OpenAiAdDetectAttempt {
  /** 模型正文；空串表示这一轮什么都没产出。 */
  readonly body: string;
  /** 出现非空 `message.refusal`（拒答内容，禁止重采样）。 */
  readonly refused: boolean;
  /** 原样的 `finish_reason`；`length` 表示额度用尽、正文多半只有半截。choices 为空或缺失时为 null。 */
  readonly finishReason: string | null;
  /** `message.refusal` 的诊断串 `{ refusal }`（见 aiProviders/finishDetails.ts）；没有拒答时为 null。 */
  readonly finishDetails: string | null;
  /** 本次响应消耗的推理 token 数；兼容端点未返回时为 null。 */
  readonly reasoningTokens: number | null;
}

/**
 * 组装 OpenAI chat completions 的 user 消息 content：无附件时保持纯字符串以兼容纯文本代理端点，
 * 有附件时使用图文分块数组。
 * @param userContent 待判定消息串文本。
 * @param attachments 可选的视觉附件列表。
 * @returns 纯字符串或图文分块数组。
 */
function buildOpenAiUserContent(
  userContent: string,
  attachments: readonly AdDetectMediaAttachment[] | undefined
): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  if (attachments === undefined || attachments.length === 0) return userContent;
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: userContent },
  ];
  for (let index: number = 0; index < attachments.length; index++) {
    const attachment: AdDetectMediaAttachment = attachments[index]!;
    parts.push({ type: "text", text: formatAdDetectAttachmentLabel(index + 1, attachment) });
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${attachment.image.mime};base64,${attachment.image.bytes.toBase64()}`,
      },
    });
  }
  return parts;
}

/**
 * 发一次请求并收窄结果；带图请求遇明确模态不支持错误时返回 `"visionUnsupported"`，其余异常就地归一成 null。
 * @param params 结构化广告判定请求参数。
 * @returns 单次尝试结果、`"visionUnsupported"` 标记或表示请求异常的 null。
 */
async function attemptOpenAiAdDetectJson({
  model,
  systemPrompt,
  userContent,
  temperature,
  maxOutputTokens,
  errorLabel,
  attachments,
}: AdDetectJsonRequestParams): Promise<OpenAiAdDetectAttempt | "visionUnsupported" | null> {
  const hasAttachments: boolean = attachments !== undefined && attachments.length > 0;
  try {
    const completion: OpenAI.Chat.Completions.ChatCompletion =
      await getAdDetectOpenAiClient().chat.completions.create({
        model,
        temperature,
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- OpenAI 兼容端点按 Chat Completions 的 max_tokens 读取输出上限
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildOpenAiUserContent(userContent, attachments) },
        ],
      });
    reportOpenAiChatUsage({ capability: "ad_detect", model, usage: completion.usage });
    const choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined = completion.choices[0];
    // 兼容端点可能不带 refusal 字段；出现非空拒答文本时按拒答收尾并禁止重采样。
    const refusal: string | null | undefined = choice?.message.refusal;
    const refused: boolean = typeof refusal === "string" && refusal.trim().length > 0;
    return {
      body: choice?.message.content ?? "",
      refused,
      finishReason: choice?.finish_reason ?? null,
      finishDetails: typeof refusal === "string" ? (finishDetailsJson({ refusal }) ?? null) : null,
      reasoningTokens: completion.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    };
  } catch (error: unknown) {
    if (
      hasAttachments &&
      isExplicitUnsupportedMediaError(numericErrorStatus(error), errorMessage(error))
    ) {
      return "visionUnsupported";
    }
    if (error instanceof OpenAI.APIError) {
      // APIError.message 已包含 HTTP 状态码前缀。
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
 * 发送 JSON object 模式的 chat completion 请求；出现非空 `refusal` 立即放弃不重采样，
 * 响应正文为空或被截断时按 `AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS` 有界重采样，停机期间放弃第 2 轮重采样。
 * @param params 结构化广告判定请求参数。
 * @returns 传输层统一结果（成功正文、明确不支持视觉输入或失败）。
 */
export function requestOpenAiAdDetectJson(
  params: AdDetectJsonRequestParams
): Promise<AdDetectProviderResult> {
  return requestAdDetectJsonWithRetry<OpenAiAdDetectAttempt>({
    attemptRequest: (): Promise<OpenAiAdDetectAttempt | "visionUnsupported" | null> =>
      attemptOpenAiAdDetectJson(params),
    extractUsableBody: (result: OpenAiAdDetectAttempt): string | null =>
      !result.refused && result.finishReason !== "length" && result.body.trim().length > 0
        ? result.body
        : null,
    canRetry: (result: OpenAiAdDetectAttempt): boolean => !result.refused,
    shouldContinue: (): boolean => !adDetectStopping.current,
    logExhausted: (result: OpenAiAdDetectAttempt, attempts: number): void => {
      logger.error(
        "Ad detection request produced no usable body.",
        {
          errorLabel: params.errorLabel,
          attempts,
          finishReason: result.finishReason,
          finishDetails: result.finishDetails,
          hasPartialText: result.body.length > 0,
          reasoningTokens: result.reasoningTokens,
          maxTokens: params.maxOutputTokens,
        }
      );
    },
  });
}
