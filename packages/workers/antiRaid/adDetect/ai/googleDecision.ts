/**
 * Google GenAI Decisions API（`client.decisions.create`）的广告检测传输实现。
 * 单次请求同时评估整体广告概率、广告类别与候选贴纸/自定义表情包的独立归因概率，
 * 并通过规范化 `base_url` 支持自定义代理前缀、版本前缀或完整 `/decisions` 端点。
 */

import { GoogleGenAI } from "@google/genai";
import type { Decisions } from "@google/genai";
import { numericErrorStatus } from "../../../../aiProviders/mediaSupportError";
import { adDetectGoogleDecisionClientHolder } from "../../../../cache/workers/antiRaid/google";
import { getAdDetectAgentConfig } from "../../../../config/agent";
import { GEMINI_API_BASE_URL, GEMINI_API_VERSION } from "../../../../consts/aiChat/gemini";
import {
  AD_DETECT_DECISION_AD_THRESHOLD,
  AD_DETECT_DECISION_PACK_THRESHOLD,
  AD_DETECT_DECISIONS_FULL_PATH_PATTERN,
  AD_DETECT_DECISIONS_VERSION_PATH_PATTERN,
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
  AD_DETECT_REASON_MAX_CHARS,
} from "../../../../consts/antiRaid/adDetect/limits";
import {
  AD_DETECT_DECISION_AD_CRITERIA,
  AD_DETECT_DECISION_CATEGORIES,
  AD_DETECT_DECISION_CATEGORY_INSTRUCTIONS,
  AD_DETECT_DECISION_EMOJI_PACK_CRITERIA,
  AD_DETECT_DECISION_STICKER_PACK_CRITERIA,
  AD_DETECT_EMPTY_TEXT_MEDIA_PLACEHOLDER,
  adDetectDecisionEmojiPackInstructions,
  adDetectDecisionStickerPackInstructions,
  formatAdDetectAttachmentLabel,
} from "../../../../consts/antiRaid/adDetect/prompts";
import { reportGeminiDecisionUsage } from "../../../../infra/aiCacheUsage";
import { logger } from "../../../../infra/logger";
import { errorMessage } from "../../../../libs/errorMessage";
import { sanitizeInline, truncateInline } from "../../../../libs/text";
import type { AdDetectMediaAttachment, AdVerdict } from "../../../../types/antiRaid/adDetect";
import type { AdDetectAgentConfig } from "../../../../types/config";

/** 规范化后的 Google Decisions API 客户端连接端点。 */
export interface GeminiDecisionEndpoint {
  /** 传给 `GoogleGenAI` 的 `httpOptions.baseUrl`（不含尾部 `/<apiVersion>` 或 `/decisions` 重复段）。 */
  readonly baseUrl: string;
  /** 传给 `GoogleGenAI` 的 `httpOptions.apiVersion`。 */
  readonly apiVersion: string;
}

/** 发起一次 Google Decisions API 广告判定的请求参数。 */
export interface GoogleAdDetectDecisionParams {
  /** 模型名来自 `config/dynamic/agent.json` 的 `agent.ad_detect.model`。 */
  readonly model: string;
  /** 判定规则与部署示例段（不含生成式 JSON 格式要求）。 */
  readonly instructions: string;
  /** 本次的系统事实一行（入群验证状态）。 */
  readonly fact: string;
  /** 待判定的群聊消息串正文（可为空串，表示纯视觉消息）。 */
  readonly userContent: string;
  /** 可选的多模态视觉附件列表。 */
  readonly attachments?: readonly AdDetectMediaAttachment[];
  /** 本轮消息束中出现、需独立归因的贴纸包 short name 候选列表。 */
  readonly stickerPackCandidates?: readonly string[];
  /** 本轮消息束中出现、需独立归因的自定义表情包 short name 候选列表。 */
  readonly emojiPackCandidates?: readonly string[];
  /** 出现在错误日志里的调用名（英文）。 */
  readonly errorLabel: string;
}

/**
 * 将用户配置的 `base_url` 拆分为 `GoogleGenAI` 所需的 `{ baseUrl, apiVersion }`，
 * 避免 SDK 拼接 `/{api_version}/decisions` 时出现重复版本或重复 `/decisions` 路径。
 * @param baseUrl 配置项 `agent.ad_detect.base_url`；缺省时使用官方默认端点与 `GEMINI_API_VERSION`。
 * @returns 规范化后的 `baseUrl` 与 `apiVersion`。
 */
export function resolveGeminiDecisionEndpoint(
  baseUrl: string | undefined
): GeminiDecisionEndpoint {
  if (baseUrl === undefined) {
    return { baseUrl: GEMINI_API_BASE_URL, apiVersion: GEMINI_API_VERSION };
  }
  const trimmed: string = baseUrl.trim().replace(/\/+$/u, "");
  const fullMatch: RegExpExecArray | null = AD_DETECT_DECISIONS_FULL_PATH_PATTERN.exec(trimmed);
  if (fullMatch !== null) {
    return { baseUrl: fullMatch[1]!, apiVersion: fullMatch[2]! };
  }
  const versionMatch: RegExpExecArray | null = AD_DETECT_DECISIONS_VERSION_PATH_PATTERN.exec(trimmed);
  if (versionMatch !== null) {
    return { baseUrl: versionMatch[1]!, apiVersion: versionMatch[2]! };
  }
  return { baseUrl: trimmed, apiVersion: GEMINI_API_VERSION };
}

/**
 * 按当前 `(apiKey, baseUrl, apiVersion)` 获取或重建 Google Decisions 客户端实例。
 * @returns 配置完成的 `GoogleGenAI` 客户端。
 */
function getAdDetectGoogleDecisionClient(): GoogleGenAI {
  const config: AdDetectAgentConfig = getAdDetectAgentConfig();
  if (config.provider !== "google") {
    throw new Error('Agent capability "ad_detect" is not configured for the Google provider.');
  }
  const endpoint: GeminiDecisionEndpoint = resolveGeminiDecisionEndpoint(config.baseUrl);
  const key: string = `${config.apiKey}\0${endpoint.baseUrl}\0${endpoint.apiVersion}`;
  if (adDetectGoogleDecisionClientHolder.current?.key === key) {
    return adDetectGoogleDecisionClientHolder.current.client;
  }
  const client: GoogleGenAI = new GoogleGenAI({
    apiKey: config.apiKey,
    enterprise: false,
    httpOptions: {
      baseUrl: endpoint.baseUrl,
      apiVersion: endpoint.apiVersion,
      timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
    },
  });
  adDetectGoogleDecisionClientHolder.current = { key, client };
  return client;
}

/**
 * 过滤并按首次出现顺序去重字符串列表（仅保留去空白后非空的字符串）。
 * 供 Google Decisions 候选包规范化与 `workers/antiRaid/adDetect/classifier.ts` 判定响应解析共用。
 * @param value 待解析的原始字段值或候选列表。
 * @returns 非空且去重后的字符串数组；不存在有效条目时返回 undefined。
 */
export function parseAdDetectPackNameList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen: Set<string> = new Set<string>();
  const packs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed: string = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    packs.push(trimmed);
  }
  return packs.length > 0 ? packs : undefined;
}

/**
 * 组装 Decisions API 共享多模态 `input` 内容块列表。
 * @param fact 入群验证系统事实行。
 * @param userContent 待判定消息串正文。
 * @param attachments 可选的视觉附件列表。
 * @returns 顺序固定的 `DecisionInputContent` 数组。
 */
function buildDecisionInput(
  fact: string,
  userContent: string,
  attachments: readonly AdDetectMediaAttachment[] | undefined
): Decisions.DecisionInputContent[] {
  const bodyText: string = userContent.trim().length > 0
    ? userContent
    : AD_DETECT_EMPTY_TEXT_MEDIA_PLACEHOLDER;
  const input: Decisions.DecisionInputContent[] = [
    { type: "text", text: `${fact}\n${bodyText}` },
  ];
  if (attachments === undefined || attachments.length === 0) return input;
  for (let index: number = 0; index < attachments.length; index++) {
    const attachment: AdDetectMediaAttachment = attachments[index]!;
    input.push({ type: "text", text: formatAdDetectAttachmentLabel(index + 1, attachment) });
    input.push({
      type: "image",
      mime_type: attachment.image.mime,
      data: attachment.image.bytes.toBase64(),
    });
  }
  return input;
}

/**
 * 组装单次请求的多问题映射表：整体广告概率、分类理由及各候选贴纸/表情包独立归因概率。
 * @param instructions 广告判定规则与部署示例文本。
 * @param stickerPacks 去重后的候选贴纸包列表。
 * @param emojiPacks 去重后的候选自定义表情包列表。
 * @returns 传给 `decisions.create` 的 `questions` 字典。
 */
function buildDecisionQuestions(
  instructions: string,
  stickerPacks: readonly string[],
  emojiPacks: readonly string[]
): Record<string, Decisions.Question> {
  const questions: Record<string, Decisions.Question> = {
    ad: {
      type: "noul",
      instructions,
      criteria: AD_DETECT_DECISION_AD_CRITERIA,
    },
    category: {
      type: "choice",
      instructions: AD_DETECT_DECISION_CATEGORY_INSTRUCTIONS,
      criteria: AD_DETECT_DECISION_CATEGORIES,
    },
  };
  for (let index: number = 0; index < stickerPacks.length; index++) {
    questions[`sticker_pack_${index}`] = {
      type: "noul",
      instructions: adDetectDecisionStickerPackInstructions(stickerPacks[index]!),
      criteria: AD_DETECT_DECISION_STICKER_PACK_CRITERIA,
    };
  }
  for (let index: number = 0; index < emojiPacks.length; index++) {
    questions[`emoji_pack_${index}`] = {
      type: "noul",
      instructions: adDetectDecisionEmojiPackInstructions(emojiPacks[index]!),
      criteria: AD_DETECT_DECISION_EMOJI_PACK_CRITERIA,
    };
  }
  return questions;
}

/**
 * 提取合法的 `NoulAnswer` 概率值（落在 `[0, 1]` 闭区间内的有限数字）。
 * @param answer 响应 `answers` 字典中对应问题的回答。
 * @returns 校验通过的 `noul` 概率值；结构或数值非法时返回 null。
 */
function validNoulProbability(answer: Decisions.Answer | undefined): number | null {
  if (answer?.type !== "noul") return null;
  const score: unknown = answer.noul;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    return null;
  }
  return score;
}

/**
 * 从响应中挑出概率达到 `AD_DETECT_DECISION_PACK_THRESHOLD` 的候选包列表。
 * @param answers 响应中的全部问题回答字典。
 * @param prefix 问题键前缀（`sticker_pack_` 或 `emoji_pack_`）。
 * @param candidates 与问题下标一一对应的候选包名列表。
 * @returns 达标包名列表；无达标包时返回 undefined。
 */
function matchedDecisionPacks(
  answers: Readonly<Record<string, Decisions.Answer>> | undefined,
  prefix: "sticker_pack_" | "emoji_pack_",
  candidates: readonly string[]
): readonly string[] | undefined {
  if (answers === undefined || candidates.length === 0) return undefined;
  const matched: string[] = [];
  for (let index: number = 0; index < candidates.length; index++) {
    const score: number | null = validNoulProbability(answers[`${prefix}${index}`]);
    if (score !== null && score >= AD_DETECT_DECISION_PACK_THRESHOLD) {
      matched.push(candidates[index]!);
    }
  }
  return matched.length > 0 ? matched : undefined;
}

/**
 * 调用 Google Decisions API 对消息束与附带视觉素材执行单次多问题广告判定。
 * 遇内容拦截、响应畸形或网络/API 错误时一律按 fail-closed 返回 null。
 * @param params Decisions API 请求参数。
 * @returns 广告判定结果（含可选贴纸/表情包归因）；失败或响应不可信时返回 null。
 */
export async function classifyWithGoogleDecision({
  model,
  instructions,
  fact,
  userContent,
  attachments,
  stickerPackCandidates,
  emojiPackCandidates,
  errorLabel,
}: GoogleAdDetectDecisionParams): Promise<AdVerdict | null> {
  const stickerPacks: readonly string[] = parseAdDetectPackNameList(stickerPackCandidates) ?? [];
  const emojiPacks: readonly string[] = parseAdDetectPackNameList(emojiPackCandidates) ?? [];
  const input: Decisions.DecisionInputContent[] = buildDecisionInput(fact, userContent, attachments);
  const questions: Record<string, Decisions.Question> = buildDecisionQuestions(
    instructions,
    stickerPacks,
    emojiPacks
  );

  let response: Decisions.CreateDecisionResponse;
  try {
    response = await getAdDetectGoogleDecisionClient().decisions.create(
      { model, input, questions },
      {
        timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
        maxRetries: AD_DETECT_GOOGLE_REQUEST_ATTEMPTS - 1,
      }
    );
  } catch (error: unknown) {
    const status: number | undefined = numericErrorStatus(error);
    if (status !== undefined) {
      logger.error(
        "Ad detection decision API request failed.",
        { errorLabel, status, errorMessage: errorMessage(error) }
      );
    } else {
      logger.error("Ad detection decision request failed:", { errorLabel }, error);
    }
    return null;
  }

  const rawBlockReason: unknown = response.prompt_feedback?.block_reason;
  const blockReason: string | undefined =
    typeof rawBlockReason === "string" && rawBlockReason.trim().length > 0
      ? rawBlockReason
      : undefined;
  if (blockReason !== undefined) {
    if (response.usage !== undefined) {
      reportGeminiDecisionUsage({ capability: "ad_detect", model, usage: response.usage });
    }
    logger.warn("Ad detection decision input was blocked.", {
      errorLabel,
      blockReason,
    });
    return null;
  }

  reportGeminiDecisionUsage({ capability: "ad_detect", model, usage: response.usage });

  const adProbability: number | null = validNoulProbability(response.answers?.ad);
  if (adProbability === null) {
    logger.error("Ad detection decision response had an invalid ad answer.", { errorLabel });
    return null;
  }

  const isAd: boolean = adProbability >= AD_DETECT_DECISION_AD_THRESHOLD;
  const categoryAnswer: Decisions.Answer | undefined = response.answers?.category;
  const rawCategory: string =
    categoryAnswer?.type === "choice" && typeof categoryAnswer.choice === "string"
      ? sanitizeInline(categoryAnswer.choice)
      : "";
  const category: string = rawCategory.length > 0 ? rawCategory : (isAd ? "ad" : "not_ad");
  const reason: string = truncateInline(
    `decision(${adProbability.toFixed(2)}): ${category}`,
    AD_DETECT_REASON_MAX_CHARS
  );

  if (!isAd) {
    return { isAd: false, reason };
  }

  const adStickerPacks: readonly string[] | undefined = matchedDecisionPacks(
    response.answers,
    "sticker_pack_",
    stickerPacks
  );
  const adEmojiPacks: readonly string[] | undefined = matchedDecisionPacks(
    response.answers,
    "emoji_pack_",
    emojiPacks
  );
  return {
    isAd: true,
    reason,
    ...(adStickerPacks !== undefined ? { adStickerPacks } : {}),
    ...(adEmojiPacks !== undefined ? { adEmojiPacks } : {}),
  };
}
