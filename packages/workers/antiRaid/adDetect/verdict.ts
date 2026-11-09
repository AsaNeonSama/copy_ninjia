/**
 * 单个待检键的广告分类、引用归因与处置编排（Anti-Raid Worker 侧）：
 * - 送检前由 `selectAdBundleEntries` 定格入选条目与水位；
 * - 依次执行贴纸黑名单快路径（`sticker_black_list`）、自定义表情包黑名单（`emoji_black_list`）与 AI 分类；
 * - 按分类与归因结果分派：非广告/未知仅推进 `checkedSeq`，命中黑名单或本人姓名/正文命中广告直接处置，
 *   仅引用内容命中广告且未处于警告窗口时先发警告并删除警告前消息，警告窗口内再次命中则升级处置。
 */

import type { Sticker } from "grammy/types";
import { classifyAdText } from "./classifier";
import {
  deleteReferencedAdMessages,
  disposeAdSender,
  warnReferencedAdSender,
} from "./disposal";
import { getAdSampleConfig } from "../../../config/adSamples";
import { deleteMessage, telegramApi } from "../../../infra/telegram";
import { isTelegramRequestRejected } from "../../../infra/telegram/errors";
import { isChatAdmin } from "../adminCache";
import { logger } from "../../../infra/logger";
import {
  adVerdictTruePublishHolder,
  adDetectStopping,
  customEmojiSetNames,
  inFlightAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningStates,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES,
  AD_REFERENCE_WARNING_WINDOW_MS,
  adEmojiBlacklistReason,
  adStickerBlacklistReason,
} from "../../../consts/antiRaid/adDetect";
import { TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS } from "../../../consts/telegram";
import {
  claimSampleContextParts,
  containsReferencedAdContent,
  formatAdBundleText,
  formatDirectAdBundleText,
  selectAdBundleEntries,
} from "./bundle";
import {
  beginReferencedAdWarning,
  cancelReferencedAdWarning,
  completeReferencedAdWarning,
} from "./referencePolicy";
import {
  deletePendingAdBundle,
  pendingAdBundle,
  requeueIfUnchecked,
} from "./queueState";
import type {
  AdBundleSelection,
  AdCandidateEntry,
  AdMessageBundle,
  AdVerdict,
} from "../../../types/antiRaid/adDetect";
import type { AdSampleConfig } from "../../../types/config";
import type {
  TelegramWorkerTemporaryMessageResult,
  TelegramWorkerTemporaryMessageSentResult,
} from "../../../types/telegramWorker";

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

/**
 * 检查本次未检条目是否命中贴纸包黑名单（快路径）。
 *
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 * @param stickerBlackList 贴纸包黑名单。
 * @returns 命中的贴纸包 short name；未命中时返回 `undefined`。
 */
function matchBlacklistedStickerSet(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[],
  stickerBlackList: readonly string[]
): string | undefined {
  for (const entry of judged) {
    if (
      entry.seq > bundle.checkedSeq &&
      entry.stickerSetName !== undefined &&
      stickerBlackList.includes(entry.stickerSetName)
    ) return entry.stickerSetName;
  }
  return undefined;
}

/**
 * 核对本次未检条目的自定义表情是否属于黑名单表情包：已在 customEmojiSetNames 的 ID 直接比对，
 * 其余 ID 去重后交给 queryBlacklistedCustomEmojiSet 分批查询。
 *
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 * @param emojiBlackList 非空的自定义表情包黑名单。
 * @returns 命中的自定义表情包 short name；未命中或查询失败时返回 `undefined`。
 */
async function matchBlacklistedCustomEmojiSet(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[],
  emojiBlackList: readonly string[]
): Promise<string | undefined> {
  let uncachedIds: Set<string> | undefined;
  for (const entry of judged) {
    if (entry.seq <= bundle.checkedSeq || entry.customEmojiIds === undefined) continue;
    for (const id of entry.customEmojiIds) {
      const setName: string | null | undefined = customEmojiSetNames.get(id);
      if (setName === undefined) {
        uncachedIds ??= new Set<string>();
        uncachedIds.add(id);
      } else if (setName !== null && emojiBlackList.includes(setName)) {
        return setName;
      }
    }
  }
  if (uncachedIds === undefined) return undefined;
  return await queryBlacklistedCustomEmojiSet(bundle, [...uncachedIds], emojiBlackList);
}

/**
 * 经主线程统一 Telegram 出站按 TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS 分批查询自定义表情所属表情包，
 * 把每批返回的贴纸写入 customEmojiSetNames 后比对黑名单，命中即停。查询失败时各批共用
 * AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES 次立即重试；4xx 拒绝、预算用尽或进入停机时放弃本轮核对。
 *
 * @param bundle 待检消息束。
 * @param customEmojiIds 去重后的待查询自定义表情 ID 列表。
 * @param emojiBlackList 自定义表情包黑名单。
 * @returns 命中的自定义表情包 short name；未命中或放弃核对时返回 `undefined`。
 */
async function queryBlacklistedCustomEmojiSet(
  bundle: AdMessageBundle,
  customEmojiIds: readonly string[],
  emojiBlackList: readonly string[]
): Promise<string | undefined> {
  let retriesLeft: number = AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES;
  for (
    let start: number = 0;
    start < customEmojiIds.length;
    start += TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS
  ) {
    const batch: string[] = customEmojiIds.slice(start, start + TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS);
    let stickers: readonly Sticker[] | undefined;
    while (stickers === undefined) {
      try {
        stickers = await telegramApi.getCustomEmojiStickers(batch);
      } catch (error: unknown) {
        if (retriesLeft === 0 || isTelegramRequestRejected(error) || adDetectStopping.current) {
          logger.error(
            `Ad detection failed to query custom emoji stickers for sender ${bundle.senderId} ` +
            `in chat ${bundle.chatId} (${AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES - retriesLeft} ` +
            "retries used); skipping the custom emoji blacklist check:",
            error
          );
          return undefined;
        }
        retriesLeft--;
      }
    }
    let matched: string | undefined;
    for (const sticker of stickers) {
      const setName: string | null = sticker.set_name ?? null;
      if (sticker.custom_emoji_id !== undefined) customEmojiSetNames.set(sticker.custom_emoji_id, setName);
      if (matched === undefined && setName !== null && emojiBlackList.includes(setName)) matched = setName;
    }
    if (matched !== undefined) return matched;
  }
  return undefined;
}

/**
 * 检查本次送检是否存在尚未做过 AI 文本判定的非空文本条目。
 *
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 * @returns 任一未检条目（`seq > bundle.checkedSeq`）含有非空 `text` 时返回 `true`。
 */
function hasUncheckedAdText(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[]
): boolean {
  for (const entry of judged) {
    if (entry.seq > bundle.checkedSeq && entry.text.length > 0) return true;
  }
  return false;
}

/**
 * 对选中条目按「贴纸黑名单快路径 -> 自定义表情包黑名单 -> AI 分类与引用归因」顺序执行检测。
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
  try {
    const { stickerBlackList, emojiBlackList }: AdSampleConfig = getAdSampleConfig();
    const matchedStickerSet: string | undefined =
      matchBlacklistedStickerSet(bundle, judged, stickerBlackList);
    if (matchedStickerSet !== undefined) {
      return {
        kind: "directAd",
        verdict: { isAd: true, reason: adStickerBlacklistReason(matchedStickerSet) },
      };
    }

    const matchedEmojiSet: string | undefined = emojiBlackList.length === 0
      ? undefined
      : await matchBlacklistedCustomEmojiSet(bundle, judged, emojiBlackList);
    if (matchedEmojiSet !== undefined) {
      return {
        kind: "directAd",
        verdict: { isAd: true, reason: adEmojiBlacklistReason(matchedEmojiSet) },
      };
    }

    if (!hasUncheckedAdText(bundle, judged)) return { kind: "notAd" };
    combinedVerdict = await classifyAdText({
      text: formatAdBundleText(judged),
      justJoined: bundle.justJoined,
    });
  } catch (error: unknown) {
    logger.error(
      `Ad detection failed to classify sender ${bundle.senderId} in chat ${bundle.chatId}:`,
      error
    );
    return { kind: "unknown" };
  }
  if (combinedVerdict === null) return { kind: "unknown" };
  if (!combinedVerdict.isAd) return { kind: "notAd" };
  if (!containsReferencedAdContent(judged)) {
    return { kind: "directAd", verdict: combinedVerdict };
  }

  const directText: string = formatDirectAdBundleText(judged);
  if (directText.length === 0) {
    return { kind: "referencedOnly", verdict: combinedVerdict };
  }
  try {
    const directVerdict: AdVerdict | null = await classifyAdText({
      text: directText,
      justJoined: bundle.justJoined,
    });
    if (directVerdict === null) {
      logger.error(
        `Ad detection could not attribute referenced content for sender ${bundle.senderId} ` +
        `in chat ${bundle.chatId}: the direct-content classifier returned no verdict.`
      );
      return { kind: "unknown" };
    }
    return directVerdict.isAd
      ? { kind: "directAd", verdict: directVerdict }
      : { kind: "referencedOnly", verdict: combinedVerdict };
  } catch (error: unknown) {
    logger.error(
      `Ad detection failed to attribute referenced content for sender ${bundle.senderId} ` +
      `in chat ${bundle.chatId}:`,
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
 * 保留 `messageId` 晚于公开警告的消息并更新其引用去重与警告窗口标记（`AD_REFERENCE_WARNING_WINDOW_MS`）。
 *
 * @param bundle 待检消息束。
 * @param warning 公开警告消息的发送结果。
 */
function retainPostWarningContent(
  bundle: AdMessageBundle,
  warning: TelegramWorkerTemporaryMessageSentResult
): void {
  const retainedEntries: AdCandidateEntry[] = [];
  for (const entry of bundle.entries) {
    if (entry.messageId <= warning.messageId) continue;
    if (
      entry.text.length > 0 &&
      (entry.quote !== undefined || entry.replyTo !== undefined)
    ) {
      entry.text = claimSampleContextParts(
        entry.directText,
        entry,
        retainedEntries
      );
    }
    entry.withinReferencedWarning =
      entry.receivedAt - warning.sentAt < AD_REFERENCE_WARNING_WINDOW_MS;
    retainedEntries.push(entry);
  }
  bundle.entries = retainedEntries;

  let pendingIdWriteIndex: number = 0;
  for (const messageId of bundle.pendingDeleteIds) {
    if (messageId <= warning.messageId) continue;
    bundle.pendingDeleteIds[pendingIdWriteIndex] = messageId;
    pendingIdWriteIndex++;
  }
  bundle.pendingDeleteIds.length = pendingIdWriteIndex;

  if (
    bundle.entries.length === 0 &&
    bundle.pendingDeleteIds.length === 0
  ) {
    deletePendingAdBundle(bundle.chatId, bundle.senderId);
  }
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
      `Ad detection flagged ${isAdmin === true ? "chat admin" : "unverified sender"} ${bundle.senderId} ` +
      `in chat ${bundle.chatId}; skipping disposal (${outcome.verdict.reason || "no reason given"}).`
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
  await disposeAdSender({ bundle, verdict: outcome.verdict, judged });
}

/**
 * 处理首次引用类广告命中：在 `inFlightAdDetectKeys` 保护下发送公开警告、删除警告前消息并保留警告后新消息重排。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 */
async function warnReferencedOnlySender(
  key: string,
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[]
): Promise<void> {
  const warningGeneration: number | undefined =
    beginReferencedAdWarning(key);
  if (warningGeneration === undefined) return;
  inFlightAdDetectKeys.add(key);
  try {
    let warningResult: TelegramWorkerTemporaryMessageResult | undefined;
    try {
      warningResult = await warnReferencedAdSender(bundle);
    } catch (error: unknown) {
      logger.error(
        `Ad detection failed to send referenced-ad warning for sender ${bundle.senderId} ` +
        `in chat ${bundle.chatId}:`,
        error
      );
    }
    if (
      warningResult !== undefined &&
      "suppressed" in warningResult
    ) {
      cancelReferencedAdWarning(key, warningGeneration);
      if (pendingAdBundle(bundle.chatId, bundle.senderId) === bundle) {
        deletePendingAdBundle(bundle.chatId, bundle.senderId);
      }
      return;
    }
    const warning: TelegramWorkerTemporaryMessageSentResult | undefined =
      warningResult;
    if (warning === undefined) {
      cancelReferencedAdWarning(key, warningGeneration);
      if (
        !adDetectStopping.current &&
        pendingAdBundle(bundle.chatId, bundle.senderId) === bundle
      ) {
        deleteReferencedAdMessages({
          bundle,
          judged,
          messageIdThrough: Number.POSITIVE_INFINITY,
        });
      }
      return;
    }
    if (
      adDetectStopping.current ||
      pendingAdBundle(bundle.chatId, bundle.senderId) !== bundle ||
      !completeReferencedAdWarning(
        key,
        warningGeneration,
        warning.sentAt
      )
    ) {
      cancelReferencedAdWarning(key, warningGeneration);
      void deleteMessage(bundle.chatId, warning.messageId, telegramApi);
      return;
    }
    deleteReferencedAdMessages({
      bundle,
      judged,
      messageIdThrough: warning.messageId,
    });
    retainPostWarningContent(bundle, warning);
  } finally {
    inFlightAdDetectKeys.delete(key);
    if (!adDetectStopping.current) {
      const current: AdMessageBundle | undefined = pendingAdBundle(bundle.chatId, bundle.senderId);
      if (current !== undefined) {
        requeueIfUnchecked(key, current);
      }
    }
  }
}
