/**
 * 单个待检键的广告分类、引用归因与处置编排（Anti-Raid Worker 侧）：
 * - 送检前由 `selectAdBundleEntries` 定格入选条目与水位；
 * - 按分类与归因结果分派：非广告/未知仅推进 `checkedSeq`，本人姓名或正文命中广告直接处置，
 *   仅引用内容命中广告且未处于警告窗口时先发警告并删除警告前消息，警告窗口内再次命中则升级处置。
 */

import { classifyAdText } from "./classifier";
import {
  deleteReferencedAdMessages,
  disposeAdSender,
  warnReferencedAdSender,
} from "./disposal";
import { deleteMessage, telegramApi } from "../../../infra/telegram";
import { isChatAdmin } from "../adminCache";
import { logger } from "../../../infra/logger";
import {
  adVerdictTruePublishHolder,
  adDetectStopping,
  inFlightAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningStates,
} from "../../../cache/workers/antiRaid/adDetect";
import { AD_REFERENCE_WARNING_WINDOW_MS } from "../../../consts/antiRaid/adDetect";
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

type AdDetectionOutcome =
  | { readonly kind: "notAd" }
  | { readonly kind: "unknown" }
  | { readonly kind: "directAd"; readonly verdict: AdVerdict }
  | { readonly kind: "referencedOnly"; readonly verdict: AdVerdict };

/**
 * 对选中条目执行分类与引用归因，返回 `AdDetectionOutcome`。
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
    if (entry.quote !== undefined || entry.replyTo !== undefined) {
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
