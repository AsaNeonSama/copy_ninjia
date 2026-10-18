/**
 * 广告判定队列调度与批处理（Anti-Raid Worker 侧）：
 * - 按 `chatId:userId` 键排队并将同一发送者的新消息合并入 `pendingAdMessages`；
 * - 每 `AD_DETECT_QUEUE_TICK_MS` 节拍在 `AD_DETECT_MAX_IN_FLIGHT` 在途上限内从队首取至多
 *   `AD_DETECT_BATCH_SIZE` 个键并发执行 `detectOne`；
 * - 维护队列启停、群/身份状态清理与周期性回收（`sweepAdDetect`）。
 * 状态存放于 `cache/workers/antiRaid/adDetect.ts`（跨模块不变量见 `docs/cn/04-invariants.md`）。
 */

import { deleteStragglerAdMessage } from "./disposal";
import { freshAdminIds } from "../adminCache";
import {
  adDetectPublishHolder,
  adVerdictTruePublishHolder,
  adDetectQueue,
  adDetectStopping,
  adDetectTickTimer,
  inFlightAdDetectKeys,
  inFlightReferencedAdCleanupTasks,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningStates,
  adDetectCapacitySaturated,
  adDetectSaturated,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_BATCH_SIZE,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_DETECT_QUEUE_TICK_MS,
  EMPTY_AD_CANDIDATE_ENTRIES,
} from "../../../consts/antiRaid/adDetect";
import { truncateInline } from "../../../libs/text";
import {
  admitAdCandidate,
  isAdDispatchSaturated,
  isKnownAdminCandidate,
} from "../../../states/adDetectAdmission";
import {
  appendLinkUrls,
  boundSampleContext,
  claimSampleContextParts,
  enforceBundleCapacity,
  latestSeq,
  pruneConsumedContext,
} from "./bundle";
import {
  clearChatReferencedAdWarnings,
  clearIdentityReferencedAdWarnings,
  hasActiveReferencedAdWarning,
  resetReferencedAdWarnings,
  sweepReferencedAdWarnings,
} from "./referencePolicy";
import {
  clearPendingAdBundles,
  deletePendingAdBundle,
  deletePendingAdBundlesInChat,
  deletePendingAdBundlesOfSender,
  expireAdDetectDisposalMarkers,
  hasActiveAdDisposalMarker,
  noteAdDetectSaturation,
  pendingAdBundle,
  pendingAdBundleForKey,
  rejectNewAdBundleAtCapacity,
  requeueIfUnchecked,
  storeBundle,
} from "./queueState";
import { detectOne } from "./verdict";
import { formatAdSenderName } from "./senderName";
import type {
  AdCandidateEntry,
  AdCandidateMessage,
  AdDetectedEvent,
  AdVerdictTrueEvent,
  AdMessageBundle,
  AdSampleContext,
} from "../../../types/antiRaid/adDetect";
import {
  parseVerificationKey,
  verificationKey,
  verificationKeyPrefix,
} from "../../../libs/verificationKey";
import type { AdCandidateDecision } from "../../../types/states/adDetectAdmission";
import type { TelegramIdentityMetadata } from "../../../types/identityPolicy";

/** 提取候选消息携带的发送者身份元数据。 */
function candidateIdentityMetadata(
  message: AdCandidateMessage
): Readonly<TelegramIdentityMetadata> {
  return {
    firstName: message.firstName,
    lastName: message.lastName,
    username: message.username,
  };
}

/**
 * 接收并合并一条待判定候选消息，按准入策略入队或触发频道尾随广告删除。
 * @param now 观测时刻，默认取 `message.observedAt`。
 */
export function enqueueAdCandidate(
  message: AdCandidateMessage,
  now: number = message.observedAt
): void {
  const existing: AdMessageBundle | undefined = pendingAdBundle(message.chatId, message.senderId);
  if (
    existing === undefined &&
    !message.blocked &&
    !message.isChannel &&
    rejectNewAdBundleAtCapacity()
  ) return;
  let key: string | undefined = existing?.key;
  const recentlyDisposed: boolean = recentlyDisposedAdKeys.size > 0 &&
    hasActiveAdDisposalMarker(key ??= verificationKey(message.chatId, message.senderId));
  if (
    existing === undefined &&
    !message.blocked &&
    !recentlyDisposed &&
    rejectNewAdBundleAtCapacity()
  ) return;
  if (existing !== undefined) pruneConsumedContext(existing, now);
  if (isKnownAdminCandidate(
    message.isChannel,
    freshAdminIds(message.chatId, now)?.has(message.senderId) === true
  )) return;
  const context: AdSampleContext | undefined =
    boundSampleContext(message.sampleQuote, message.sampleReplyTo);
  const textWithLinks: string = appendLinkUrls(
    truncateInline(message.text, AD_DETECT_MESSAGE_MAX_CHARS),
    message.linkUrls
  );
  const knownSenderName: string | undefined =
    existing?.meta.firstName === message.firstName && existing.meta.lastName === message.lastName
      ? existing.senderName
      : undefined;
  const senderName: string = message.isChannel ? "" : knownSenderName ?? formatAdSenderName(message);
  const senderText: string = senderName.length === 0
    ? textWithLinks
    : textWithLinks.length === 0 ? senderName : `${senderName} ${textWithLinks}`;
  const text: string = context === undefined
    ? senderText
    : claimSampleContextParts(
      senderText,
      context,
      existing?.entries ?? EMPTY_AD_CANDIDATE_ENTRIES
    );
  const directText: string = message.isForwarded ? senderName : senderText;
  const onlyKnownName: boolean = text === senderName && knownSenderName !== undefined && (existing?.entries.length ?? 0) > 0;
  const decision: AdCandidateDecision = admitAdCandidate({
    textLength: onlyKnownName ? 0 : text.length,
    isChannel: message.isChannel,
    recentlyDisposed,
    blocked: message.blocked,
  });
  if (decision === "deleteStraggler") {
    deleteStragglerAdMessage(message.chatId, message.messageId);
    return;
  }
  if (decision === "ignore") return;

  const bundle: AdMessageBundle = existing ?? {
    key: key ?? verificationKey(message.chatId, message.senderId),
    chatId: message.chatId,
    senderId: message.senderId,
    meta: candidateIdentityMetadata(message),
    senderName,
    isChannel: message.isChannel,
    justJoined: message.justJoined,
    entries: [],
    pendingDeleteIds: [],
    pendingDeleteOverflowed: false,
    uncheckedEvicted: false,
    nextSeq: 1,
    checkedSeq: 0,
  };
  if (existing !== undefined) {
    if (knownSenderName === undefined || bundle.meta.username !== message.username) {
      bundle.meta = candidateIdentityMetadata(message);
      bundle.senderName = senderName;
    }
    bundle.justJoined ||= message.justJoined;
  }
  const entry: AdCandidateEntry = {
    messageId: message.messageId,
    seq: bundle.nextSeq++,
    text,
    directText,
    receivedAt: now,
    withinReferencedWarning: referencedAdWarningStates.size > 0 &&
      hasActiveReferencedAdWarning(bundle.key, now),
    quote: context?.quote,
    replyTo: context?.replyTo,
  };
  bundle.entries.push(entry);
  enforceBundleCapacity(bundle);
  if (existing === undefined) storeBundle(bundle);
  requeueIfUnchecked(bundle.key, bundle);
}

/**
 * 执行一拍批量派发：从队首取出至多 AD_DETECT_BATCH_SIZE 个键并发调用 detectOne。
 */
export function runAdDetectBatch(now: number = Date.now()): Promise<void> {
  const tasks: Promise<void>[] = [];
  let saturated: boolean = false;
  for (let taken: number = 0; taken < AD_DETECT_BATCH_SIZE; taken++) {
    if (isAdDispatchSaturated(inFlightAdDetectKeys.size)) {
      saturated = true;
      break;
    }
    const key: string | undefined = adDetectQueue.shift();
    if (key === undefined) break;
    queuedAdDetectKeys.delete(key);
    const bundle: AdMessageBundle | undefined = pendingAdBundleForKey(key);
    if (bundle === undefined) continue;
    pruneConsumedContext(bundle, now);
    if (bundle.entries.length === 0) {
      deletePendingAdBundle(bundle.chatId, bundle.senderId);
      continue;
    }
    if (inFlightAdDetectKeys.has(key)) continue;
    if (latestSeq(bundle) <= bundle.checkedSeq) continue;
    inFlightAdDetectKeys.add(key);
    tasks.push(detectOne(key, bundle));
  }
  noteAdDetectSaturation(saturated);
  if (tasks.length === 0) return Promise.resolve();
  return Promise.allSettled(tasks).then((): void => undefined);
}

/**
 * 停机静默：停止批处理定时器并置位 adDetectStopping，阻止新判定启动与在途结果发布。
 */
export function quiesceAdDetectQueue(): void {
  adDetectStopping.current = true;
  if (adDetectTickTimer.current !== null) {
    clearInterval(adDetectTickTimer.current);
    adDetectTickTimer.current = null;
  }
}

/**
 * 清理指定群的待检队列、消息束、处置抑制记录与引用警告状态。
 */
export function clearChatAdDetect(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  adDetectQueue.removeWhere((key: string): boolean => key.startsWith(prefix));
  for (const key of queuedAdDetectKeys) {
    if (key.startsWith(prefix)) queuedAdDetectKeys.delete(key);
  }
  deletePendingAdBundlesInChat(chatId);
  for (const key of recentlyDisposedAdKeys.keys()) {
    if (key.startsWith(prefix)) recentlyDisposedAdKeys.delete(key);
  }
  clearChatReferencedAdWarnings(chatId);
}

/**
 * 清理指定身份在各群尚未结算的广告检测状态。
 */
export function clearIdentityAdDetect(identityId: number): void {
  const belongsToIdentity = (key: string): boolean =>
    parseVerificationKey(key)?.userId === identityId;
  adDetectQueue.removeWhere(belongsToIdentity);
  for (const key of queuedAdDetectKeys) {
    if (belongsToIdentity(key)) queuedAdDetectKeys.delete(key);
  }
  deletePendingAdBundlesOfSender(identityId);
  for (const key of recentlyDisposedAdKeys.keys()) {
    if (belongsToIdentity(key)) recentlyDisposedAdKeys.delete(key);
  }
  clearIdentityReferencedAdWarnings(identityId);
}

/**
 * 周期性维护回收：清理过期的处置抑制记录、已判上下文与引用警告状态，回收空消息束并补排含未判内容的键。
 */
export function sweepAdDetect(now: number = Date.now()): void {
  expireAdDetectDisposalMarkers();
  for (const bundles of pendingAdMessages.values()) {
    for (const bundle of bundles.values()) {
      pruneConsumedContext(bundle, now);
      if (
        bundle.entries.length === 0 &&
        !queuedAdDetectKeys.has(bundle.key) &&
        !inFlightAdDetectKeys.has(bundle.key)
      ) {
        deletePendingAdBundle(bundle.chatId, bundle.senderId);
        continue;
      }
      requeueIfUnchecked(bundle.key, bundle);
    }
  }
  sweepReferencedAdWarnings(now);
}

/** Worker 启动入口：登记回投通道并挂上唯一批处理节拍。 */
export function startAdDetectQueue(
  publish: (event: AdDetectedEvent) => void,
  publishVerdictTrue: (event: AdVerdictTrueEvent) => void
): void {
  adDetectStopping.current = false;
  adDetectPublishHolder.current = publish;
  adVerdictTruePublishHolder.current = publishVerdictTrue;
  if (adDetectTickTimer.current !== null) return;
  adDetectTickTimer.current = setInterval((): void => {
    void runAdDetectBatch();
  }, AD_DETECT_QUEUE_TICK_MS);
  adDetectTickTimer.current.unref();
}

/** 协作式停止：清掉 timer 与全部队列状态；强制 terminate 时随 isolate 一起没。 */
export function stopAdDetectQueue(): void {
  quiesceAdDetectQueue();
  adDetectPublishHolder.current = null;
  adVerdictTruePublishHolder.current = null;
  adDetectQueue.clear();
  queuedAdDetectKeys.clear();
  recentlyDisposedAdKeys.clear();
  resetReferencedAdWarnings();
  clearPendingAdBundles();
  inFlightAdDetectKeys.clear();
  inFlightReferencedAdCleanupTasks.clear();
  adDetectSaturated.current = false;
  adDetectCapacitySaturated.current = false;
  // stop 清掉全部状态，quiesce 置位的 adDetectStopping 一并归零，下一次 start 从干净状态起步。
  adDetectStopping.current = false;
}
