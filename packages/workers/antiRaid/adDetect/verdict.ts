/**
 * 单个待检键的广告分类、引用归因与处置编排（Anti-Raid Worker 侧）：
 * - 送检前由 `selectAdBundleEntries` 定格入选条目与水位；
 * - 先经 `./blacklistFastPath.ts` 执行贴纸与自定义表情包黑名单快路径，未命中时再调用 AI 分类；
 * - 按分类与归因结果分派：非广告/未知仅推进 `checkedSeq`，命中黑名单或本人姓名/正文命中广告直接处置，
 *   仅引用内容命中广告且未处于警告窗口时交由 `./referencedWarning.ts` 发警告并清理警告前消息，警告窗口内再次命中则升级处置。
 */

import {
  matchCustomEmojiBlacklistFastPath,
  matchStickerBlacklistFastPath,
} from "./blacklistFastPath";
import type { CustomEmojiBlacklistMatchResult } from "./blacklistFastPath";
import { classifyAdText } from "./classifier";
import { disposeAdSender } from "./disposal";
import { resolveAdBundleMedia } from "./media";
import { warnReferencedOnlySender } from "./referencedWarning";
import { adDetectAgentConfigSnapshot } from "../../../config/agent";
import { isChatAdmin } from "../adminCache";
import { logger } from "../../../infra/logger";
import {
  adVerdictTruePublishHolder,
  adDetectStopping,
  adDetectVisionSupport,
  adPackBlacklistCounts,
  inFlightAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningStates,
} from "../../../cache/workers/antiRaid/adDetect";
import { EMPTY_RESOLVED_AD_BUNDLE_MEDIA } from "../../../consts/antiRaid/adDetect/limits";
import { collectValidStickerPackNames } from "../../../libs/stickerPackNames";
import {
  containsReferencedAdContent,
  formatAdBundleText,
  formatDirectAdBundleText,
  selectAdBundleEntries,
} from "./bundle";
import {
  deletePendingAdBundle,
  pendingAdBundle,
  requeueIfUnchecked,
} from "./queueState";
import type {
  AdBundleMediaSlice,
  AdBundleSelection,
  AdCandidateEntry,
  AdMessageBundle,
  AdVerdict,
  ClassifyAdBundleOptions,
  ResolvedAdBundleMedia,
} from "../../../types/antiRaid/adDetect";
import type { AdDetectAgentConfig } from "../../../types/config";

/**
 * 核查发送者是否为本群管理员（频道身份直接返回 false，真人成员经 `isChatAdmin` 查询）。
 *
 * @param bundle 待检消息束。
 * @returns 确认为管理员返回 `true`，非管理员返回 `false`，无法确认时返回 `undefined`。
 */
async function isAdminSender(bundle: AdMessageBundle): Promise<boolean | undefined> {
  if (bundle.isChannel) return false;
  return await isChatAdmin(bundle.chatId, bundle.senderId, "sender");
}

/** 单次消息束广告分类与引用归因的结果。 */
type AdDetectionOutcome =
  | { readonly kind: "notAd" }
  | { readonly kind: "unknown" }
  | { readonly kind: "directAd"; readonly verdict: AdVerdict }
  | { readonly kind: "referencedOnly"; readonly verdict: AdVerdict };

/** 本次送检条目快照中文本与视觉媒体的单遍扫描摘要。 */
interface AdBundleContentSummary {
  /** 任一未检条目（`seq > bundle.checkedSeq`）含有非空送检文本。 */
  readonly hasUncheckedText: boolean;
  /** 任一未检条目（`seq > bundle.checkedSeq`）携带视觉媒体标识。 */
  readonly hasUncheckedMedia: boolean;
  /** 任一条目（含已判上下文）携带视觉媒体标识。 */
  readonly hasAnyMedia: boolean;
}

/**
 * 检查单条候选条目是否携带可供视觉检测的媒体标识（贴纸、普通图片/图片文件或自定义表情）。
 *
 * @param entry 候选条目。
 * @returns 携带任一视觉媒体标识时返回 `true`。
 */
function hasEntryAdMedia(entry: AdCandidateEntry): boolean {
  return (
    entry.stickerFileId !== undefined ||
    entry.imageFileId !== undefined ||
    (entry.customEmojiIds !== undefined && entry.customEmojiIds.length > 0)
  );
}

/**
 * 单遍扫描本次送检条目快照，汇总未检文本、未检视觉媒体与整串视觉媒体的存在性。
 *
 * @param bundle 待检消息束（提供已检水位 `checkedSeq`）。
 * @param judged 本次送检入选的条目快照。
 * @returns 条目快照的文本与视觉媒体摘要。
 */
function summarizeBundleEntries(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[]
): AdBundleContentSummary {
  let hasUncheckedText: boolean = false;
  let hasUncheckedMedia: boolean = false;
  let hasAnyMedia: boolean = false;
  for (const entry of judged) {
    const isUnchecked: boolean = entry.seq > bundle.checkedSeq;
    if (isUnchecked && entry.text.length > 0) {
      hasUncheckedText = true;
    }
    if (hasEntryAdMedia(entry)) {
      hasAnyMedia = true;
      if (isUnchecked) hasUncheckedMedia = true;
    }
    if (hasUncheckedText && hasUncheckedMedia) break;
  }
  return { hasUncheckedText, hasUncheckedMedia, hasAnyMedia };
}

/**
 * 组装交给分类器的单次多模态请求入参（保持固定对象形态，空数组字段显式置为 `undefined`）。
 *
 * @param text 按行编号的待判定消息文本。
 * @param justJoined 发送者是否处于入群验证窗口内。
 * @param slice 本轮对应的多模态附件与包归因候选切片。
 * @returns 广告消息束分类入参。
 */
function buildClassifyOptions(
  text: string,
  justJoined: boolean,
  slice: AdBundleMediaSlice
): ClassifyAdBundleOptions {
  return {
    text,
    justJoined,
    attachments: slice.attachments.length > 0 ? slice.attachments : undefined,
    stickerPackCandidates:
      slice.stickerPackCandidates.length > 0 ? slice.stickerPackCandidates : undefined,
    emojiPackCandidates:
      slice.emojiPackCandidates.length > 0 ? slice.emojiPackCandidates : undefined,
  };
}

/**
 * 将模型返回的广告包归因列表与本轮候选集合求交集，并按 `STICKER_PACK_NAME_PATTERN` 校验后去重。
 *
 * @param returned 模型返回的原始包名列表。
 * @param candidates 本轮送检实际附带视觉素材的合法候选包名列表。
 * @returns 过滤后的去重包名列表；无有效条目时返回 `undefined`。
 */
function filterAttributedPacks(
  returned: readonly string[] | undefined,
  candidates: readonly string[]
): readonly string[] | undefined {
  if (returned === undefined || returned.length === 0 || candidates.length === 0) {
    return undefined;
  }
  const filtered: string[] = collectValidStickerPackNames(returned, {
    allowed: new Set<string>(candidates),
  });
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * 清洗模型广告判定结果中的贴纸包与自定义表情包归因字段：仅保留本轮候选内且合法的包名，空数组省略。
 *
 * @param verdict 模型返回的原始广告判定结果。
 * @param slice 本轮送检对应的多模态切片。
 * @returns 清洗归因字段后的广告判定结果。
 */
function sanitizePackAttribution(
  verdict: AdVerdict,
  slice: AdBundleMediaSlice
): AdVerdict {
  const adStickerPacks: readonly string[] | undefined =
    filterAttributedPacks(verdict.adStickerPacks, slice.stickerPackCandidates);
  const adEmojiPacks: readonly string[] | undefined =
    filterAttributedPacks(verdict.adEmojiPacks, slice.emojiPackCandidates);
  return {
    isAd: verdict.isAd,
    reason: verdict.reason,
    ...(adStickerPacks !== undefined ? { adStickerPacks } : {}),
    ...(adEmojiPacks !== undefined ? { adEmojiPacks } : {}),
  };
}

/**
 * 对选中条目按「贴纸与自定义表情黑名单快路径 -> 视觉素材准备 -> AI 分类与引用归因」顺序执行检测。
 *
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 * @returns 广告分类与引用归因结果。
 */
async function classifyAdBundle(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[]
): Promise<AdDetectionOutcome> {
  let combinedVerdict: AdVerdict | null;
  let media: ResolvedAdBundleMedia;
  try {
    if (adPackBlacklistCounts.sticker > 0) {
      const stickerVerdict: AdVerdict | null =
        await matchStickerBlacklistFastPath(bundle, judged);
      if (stickerVerdict !== null) {
        return { kind: "directAd", verdict: stickerVerdict };
      }
    }
    let emojiQueryFailed: boolean = false;
    if (adPackBlacklistCounts.emoji > 0) {
      const emojiMatch: CustomEmojiBlacklistMatchResult =
        await matchCustomEmojiBlacklistFastPath(bundle, judged);
      if (emojiMatch.verdict !== null) {
        return { kind: "directAd", verdict: emojiMatch.verdict };
      }
      emojiQueryFailed = emojiMatch.queryFailed;
    }
    const summary: AdBundleContentSummary = summarizeBundleEntries(bundle, judged);
    if (!summary.hasUncheckedText && !summary.hasUncheckedMedia) return { kind: "notAd" };

    const agentConfig: AdDetectAgentConfig | null = adDetectAgentConfigSnapshot();
    const isGoogleDecision: boolean =
      agentConfig?.provider === "google" && agentConfig.useDecision;
    const skipMediaDownloads: boolean =
      adDetectVisionSupport.current === "unsupported" && !isGoogleDecision;
    if (skipMediaDownloads && !summary.hasUncheckedText) return { kind: "notAd" };

    media = !skipMediaDownloads && summary.hasAnyMedia
      ? await resolveAdBundleMedia({
        bundle,
        judged,
        hasUncheckedText: summary.hasUncheckedText,
        skipCustomEmojiNetworkQuery: emojiQueryFailed,
      })
      : EMPTY_RESOLVED_AD_BUNDLE_MEDIA;
    if (!summary.hasUncheckedText && !media.hasUncheckedAttachments) {
      return { kind: "notAd" };
    }
    const combinedOptions: ClassifyAdBundleOptions = buildClassifyOptions(
      formatAdBundleText(judged),
      bundle.justJoined,
      media.combined
    );
    combinedVerdict = await classifyAdText(combinedOptions);
  } catch (error: unknown) {
    logger.error(
      "Ad detection failed to classify sender:",
      { chatId: bundle.chatId, senderId: bundle.senderId },
      error
    );
    return { kind: "unknown" };
  }
  if (combinedVerdict === null) return { kind: "unknown" };
  if (!combinedVerdict.isAd) return { kind: "notAd" };
  if (!containsReferencedAdContent(judged)) {
    return { kind: "directAd", verdict: sanitizePackAttribution(combinedVerdict, media.combined) };
  }

  const referencedVerdict: AdVerdict = { isAd: true, reason: combinedVerdict.reason };
  const directText: string = formatDirectAdBundleText(judged);
  if (directText.length === 0 && media.direct.attachments.length === 0) {
    return { kind: "referencedOnly", verdict: referencedVerdict };
  }
  try {
    const directOptions: ClassifyAdBundleOptions = buildClassifyOptions(
      directText,
      bundle.justJoined,
      media.direct
    );
    const directVerdict: AdVerdict | null = await classifyAdText(directOptions);
    if (directVerdict === null) {
      logger.error(
        "Ad detection could not attribute referenced content; the direct-content classifier returned no verdict.",
        { chatId: bundle.chatId, senderId: bundle.senderId }
      );
      return { kind: "unknown" };
    }
    return directVerdict.isAd
      ? { kind: "directAd", verdict: sanitizePackAttribution(directVerdict, media.direct) }
      : { kind: "referencedOnly", verdict: referencedVerdict };
  } catch (error: unknown) {
    logger.error(
      "Ad detection failed to attribute referenced content:",
      { chatId: bundle.chatId, senderId: bundle.senderId },
      error
    );
    return { kind: "unknown" };
  }
}

/**
 * 读取本次推进水位的最后一条消息在入队时冻结的警告窗口状态。
 *
 * @param selection 本次送检入选条目与水位快照。
 * @returns 最后一条入选消息处于已公开警告窗口内时返回 `true`。
 */
function selectedWithinReferencedWarning(selection: AdBundleSelection): boolean {
  return selection.entries.at(-1)?.withinReferencedWarning === true;
}

/**
 * 对单个队列键执行广告分类并根据归因结果推进水位、发送引用警告或执行封禁处置。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @param bundle 待检消息束。
 */
export async function detectOne(
  key: string,
  bundle: AdMessageBundle
): Promise<void> {
  const selection: AdBundleSelection = selectAdBundleEntries(bundle);
  const judged: readonly AdCandidateEntry[] = selection.entries;
  const withinReferencedWarning: boolean = selectedWithinReferencedWarning(selection);
  let outcome: AdDetectionOutcome;
  let isAdmin: boolean | undefined;
  try {
    outcome = await classifyAdBundle(bundle, judged);
    if (
      outcome.kind === "directAd" ||
      outcome.kind === "referencedOnly"
    ) isAdmin = await isAdminSender(bundle);
  } finally {
    inFlightAdDetectKeys.delete(key);
  }
  if (adDetectStopping.current) return;
  if (outcome.kind === "directAd" || outcome.kind === "referencedOnly") {
    adVerdictTruePublishHolder.current?.({
      type: "adVerdictTrue",
      chatId: bundle.chatId,
      senderId: bundle.senderId,
    });
  }
  const current: AdMessageBundle | undefined = pendingAdBundle(bundle.chatId, bundle.senderId);
  if (current !== bundle) {
    if (current !== undefined) requeueIfUnchecked(key, current);
    return;
  }
  bundle.checkedSeq = Math.max(bundle.checkedSeq, selection.checkedToSeq);
  if (outcome.kind === "notAd" || outcome.kind === "unknown") {
    requeueIfUnchecked(key, bundle);
    return;
  }
  if (isAdmin !== false) {
    logger.error(
      isAdmin === true
        ? "Ad detection flagged chat admin; skipping disposal."
        : "Ad detection flagged unverified sender; skipping disposal.",
      {
        chatId: bundle.chatId,
        senderId: bundle.senderId,
        reason: outcome.verdict.reason || null,
      }
    );
    if (isAdmin === true) {
      deletePendingAdBundle(bundle.chatId, bundle.senderId);
    } else {
      requeueIfUnchecked(key, bundle);
    }
    return;
  }
  if (outcome.kind === "referencedOnly" && !withinReferencedWarning) {
    await warnReferencedOnlySender(key, bundle, judged);
    return;
  }
  // 处置前移除待检消息束并写入单调时钟处置抑制表（见 docs/cn/04-invariants.md）。
  deletePendingAdBundle(bundle.chatId, bundle.senderId);
  recentlyDisposedAdKeys.set(key, performance.now());
  referencedAdWarningStates.delete(key);
  disposeAdSender({ bundle, verdict: outcome.verdict, judged });
}
