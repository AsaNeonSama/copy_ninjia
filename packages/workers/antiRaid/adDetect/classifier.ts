/**
 * 广告判定领域逻辑：组装判定提示词（见 config/adDetectConfig.ts 与 consts/antiRaid/adDetect/prompts.ts）、
 * 路由至 Google Decisions API 或三家生成式多模态/纯文本传输（./ai/provider.ts），
 * 并在纯文本模型拒绝视觉输入时记忆状态并回退纯文本判定。
 * 请求失败、超时或响应形态不符时统一返回 null。
 */

import { parseAdDetectPackNameList } from "./ai/googleDecision";
import { requestAdDetectDecision, requestAdDetectJson } from "./ai/provider";
import { adDetectPrompts, adDetectVisionSupport } from "../../../cache/workers/antiRaid/adDetect";
import { getAdDetectConfig } from "../../../config/adDetectConfig";
import { adDetectAgentConfigSnapshot, getAdDetectAgentConfig } from "../../../config/agent";
import { logger } from "../../../infra/logger";
import {
  AD_DETECT_MAX_OUTPUT_TOKENS,
  AD_DETECT_REASON_MAX_CHARS,
  AD_DETECT_TEMPERATURE,
} from "../../../consts/antiRaid/adDetect/limits";
import {
  AD_DETECT_EMPTY_TEXT_MEDIA_PLACEHOLDER,
  AD_DETECT_MULTIMODAL_MEDIA_INSTRUCTION,
  adDetectFact,
  buildAdDetectDecisionInstructions,
  buildAdDetectInstructions,
  buildAdDetectPackAttributionInstruction,
} from "../../../consts/antiRaid/adDetect/prompts";
import { isPlainRecord } from "../../../libs/record";
import { sanitizeInline, truncateInline } from "../../../libs/text";
import type {
  AdDetectMediaAttachment,
  AdDetectPrompts,
  AdDetectProviderResult,
  AdVerdict,
  ClassifyAdBundleOptions,
} from "../../../types/antiRaid/adDetect";
import type { AdDetectAgentConfig } from "../../../types/config";

/**
 * 解析模型返回的 JSON 文本为 AdVerdict；格式或字段类型非法时返回 null。
 * 可选解析 `ad_sticker_packs` 与 `ad_emoji_packs` 字符串数组，缺省或为空时省略对应字段。
 * @param raw 模型返回的原始字符串。
 * @returns 解析出的广告判定结果；输入非合法判定 JSON 时返回 null。
 */
export function parseAdVerdict(raw: string | null | undefined): AdVerdict | null {
  if (typeof raw !== "string") return null;
  const trimmed: string = raw.trim();
  const fenced: RegExpExecArray | null = trimmed.startsWith("{") && trimmed.endsWith("}")
    ? null
    : /(?:^|[\r\n])[ \t]*```json[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[ \t]*```(?=[ \t]*(?:[\r\n]|$))/i.exec(trimmed);
  const normalized: string = fenced?.[1]?.trim() ?? trimmed;
  const start: number = normalized.indexOf("{");
  const end: number = normalized.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized.slice(start, end + 1)) as unknown;
  } catch (error: unknown) {
    logger.error("Ad detection response was not valid JSON:", error);
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  const verdict: Record<string, unknown> = parsed;
  // ad 字段仅接受布尔类型，非布尔值一律视为无效响应。
  if (typeof verdict.ad !== "boolean") return null;
  const reason: string = typeof verdict.reason === "string"
    ? truncateInline(sanitizeInline(verdict.reason), AD_DETECT_REASON_MAX_CHARS)
    : "";
  const adStickerPacks: readonly string[] | undefined = parseAdDetectPackNameList(verdict.ad_sticker_packs);
  const adEmojiPacks: readonly string[] | undefined = parseAdDetectPackNameList(verdict.ad_emoji_packs);
  return {
    isAd: verdict.ad,
    reason,
    ...(adStickerPacks !== undefined ? { adStickerPacks } : {}),
    ...(adEmojiPacks !== undefined ? { adEmojiPacks } : {}),
  };
}

/**
 * 获取或构建当前示例快照对应的判定提示词缓存（见 cache/workers/antiRaid/adDetect.ts）。
 * @returns 当前生效的广告判定提示词集合。
 */
function currentAdDetectPrompts(): AdDetectPrompts {
  if (adDetectPrompts.current !== null) return adDetectPrompts.current;
  const instructions: string = buildAdDetectInstructions(getAdDetectConfig().samples);
  const prompts: AdDetectPrompts = {
    instructions,
    justJoinedSystemPrompt: `${instructions}\n${adDetectFact(true)}`,
    establishedSystemPrompt: `${instructions}\n${adDetectFact(false)}`,
  };
  adDetectPrompts.current = prompts;
  return prompts;
}

/**
 * 将模型返回的单类归因包列表按本轮候选集合过滤。
 * @param packs 模型返回的包名列表。
 * @param candidates 本轮允许归因的候选包名列表。
 * @returns 命中候选集合的非空包名列表；无命中或任一侧为空时返回 undefined。
 */
function filterAllowedPacks(
  packs: readonly string[] | undefined,
  candidates: readonly string[]
): readonly string[] | undefined {
  if (packs === undefined || packs.length === 0 || candidates.length === 0) return undefined;
  const allowed: ReadonlySet<string> = new Set<string>(candidates);
  const matched: string[] = [];
  for (const pack of packs) {
    if (allowed.has(pack)) matched.push(pack);
  }
  return matched.length > 0 ? matched : undefined;
}

/**
 * 按本轮候选集合过滤模型返回的贴纸包与自定义表情包归因列表；非广告结论一律剥离包归因。
 * @param verdict 模型解析出的原始判定结果。
 * @param stickerCandidates 本轮允许归因的贴纸包候选列表。
 * @param emojiCandidates 本轮允许归因的自定义表情包候选列表。
 * @returns 过滤后的广告判定结果。
 */
function filterVerdictPacks(
  verdict: AdVerdict,
  stickerCandidates: readonly string[],
  emojiCandidates: readonly string[]
): AdVerdict {
  if (verdict.adStickerPacks === undefined && verdict.adEmojiPacks === undefined) {
    return verdict;
  }
  if (!verdict.isAd) {
    return { isAd: false, reason: verdict.reason };
  }
  const adStickerPacks: readonly string[] | undefined = filterAllowedPacks(
    verdict.adStickerPacks,
    stickerCandidates
  );
  const adEmojiPacks: readonly string[] | undefined = filterAllowedPacks(
    verdict.adEmojiPacks,
    emojiCandidates
  );
  if (adStickerPacks === undefined && adEmojiPacks === undefined) {
    return { isAd: true, reason: verdict.reason };
  }
  return {
    isAd: true,
    reason: verdict.reason,
    ...(adStickerPacks !== undefined ? { adStickerPacks } : {}),
    ...(adEmojiPacks !== undefined ? { adEmojiPacks } : {}),
  };
}

/**
 * 发起纯文本生成式广告判定并解析结果（始终剥离任何包归因）。
 * @param model 当前配置的模型名。
 * @param text 待判定消息串正文。
 * @param justJoined 发送者是否仍处于入群验证窗口内。
 * @returns 解析后的广告判定结果；失败时返回 null。
 */
async function classifyAdTextOnly(
  model: string,
  text: string,
  justJoined: boolean
): Promise<AdVerdict | null> {
  const prompts: AdDetectPrompts = currentAdDetectPrompts();
  const result: AdDetectProviderResult = await requestAdDetectJson({
    model,
    instructions: prompts.instructions,
    // 系统事实与正文分开交给传输，不拼进用户可控的正文。
    fact: adDetectFact(justJoined),
    systemPrompt: justJoined ? prompts.justJoinedSystemPrompt : prompts.establishedSystemPrompt,
    userContent: text,
    temperature: AD_DETECT_TEMPERATURE,
    maxOutputTokens: AD_DETECT_MAX_OUTPUT_TOKENS,
    errorLabel: "Ad detection request",
  });
  if (result.status !== "ok") return null;
  const verdict: AdVerdict | null = parseAdVerdict(result.body);
  return verdict === null ? null : filterVerdictPacks(verdict, [], []);
}

/**
 * 判定一串消息（可选携带图片、贴纸与自定义表情附件及归因候选包）是不是广告。
 * @param options 待判定消息串、新入群标记、视觉附件与候选包名列表。
 * @returns 判定结果；请求或解析失败时为 null，调用方应视为「本次没判定」。
 */
export async function classifyAdText({
  text,
  justJoined,
  attachments,
  stickerPackCandidates,
  emojiPackCandidates,
}: ClassifyAdBundleOptions): Promise<AdVerdict | null> {
  const agentConfig: AdDetectAgentConfig = getAdDetectAgentConfig();
  const mediaAttachments: readonly AdDetectMediaAttachment[] = attachments ?? [];
  const stickerPacks: readonly string[] = parseAdDetectPackNameList(stickerPackCandidates) ?? [];
  const emojiPacks: readonly string[] = parseAdDetectPackNameList(emojiPackCandidates) ?? [];
  const hasText: boolean = text.trim().length > 0;
  const hasAttachments: boolean = mediaAttachments.length > 0;

  if (agentConfig.provider === "google" && agentConfig.useDecision) {
    if (!hasText && !hasAttachments) return { isAd: false, reason: "" };
    return requestAdDetectDecision({
      model: agentConfig.model,
      instructions: buildAdDetectDecisionInstructions(getAdDetectConfig().samples, hasAttachments),
      fact: adDetectFact(justJoined),
      userContent: text,
      ...(hasAttachments ? { attachments: mediaAttachments } : {}),
      ...(stickerPacks.length > 0 ? { stickerPackCandidates: stickerPacks } : {}),
      ...(emojiPacks.length > 0 ? { emojiPackCandidates: emojiPacks } : {}),
      errorLabel: "Ad detection decision request",
    });
  }

  if (hasAttachments && adDetectVisionSupport.current !== "unsupported") {
    const prompts: AdDetectPrompts = currentAdDetectPrompts();
    const hasPackCandidates: boolean = stickerPacks.length > 0 || emojiPacks.length > 0;
    const extraParts: string[] = [AD_DETECT_MULTIMODAL_MEDIA_INSTRUCTION];
    if (hasPackCandidates) {
      extraParts.push(buildAdDetectPackAttributionInstruction(stickerPacks, emojiPacks));
    }
    const instructions: string = `${prompts.instructions}\n${extraParts.join("\n")}`;
    const fact: string = adDetectFact(justJoined);
    const result: AdDetectProviderResult = await requestAdDetectJson({
      model: agentConfig.model,
      instructions,
      fact,
      systemPrompt: `${instructions}\n${fact}`,
      userContent: hasText ? text : AD_DETECT_EMPTY_TEXT_MEDIA_PLACEHOLDER,
      temperature: AD_DETECT_TEMPERATURE,
      maxOutputTokens: AD_DETECT_MAX_OUTPUT_TOKENS,
      errorLabel: "Ad detection request",
      attachments: mediaAttachments,
      ...(stickerPacks.length > 0 ? { stickerPackCandidates: stickerPacks } : {}),
      ...(emojiPacks.length > 0 ? { emojiPackCandidates: emojiPacks } : {}),
    });
    const configStillCurrent: boolean = adDetectAgentConfigSnapshot() === agentConfig;
    if (result.status === "ok") {
      if (configStillCurrent && adDetectVisionSupport.current === "unknown") {
        adDetectVisionSupport.current = "supported";
      }
      const verdict: AdVerdict | null = parseAdVerdict(result.body);
      return verdict === null ? null : filterVerdictPacks(verdict, stickerPacks, emojiPacks);
    }
    if (result.status === "visionUnsupported") {
      if (!configStillCurrent) return null;
      adDetectVisionSupport.current = "unsupported";
      logger.warn("Ad detection model does not support image inputs; falling back to text-only detection.", {
        provider: agentConfig.provider,
        model: agentConfig.model,
      });
      if (!hasText) return { isAd: false, reason: "" };
      return classifyAdTextOnly(agentConfig.model, text, justJoined);
    }
    return null;
  }

  if (!hasText) return { isAd: false, reason: "" };
  return classifyAdTextOnly(agentConfig.model, text, justJoined);
}
