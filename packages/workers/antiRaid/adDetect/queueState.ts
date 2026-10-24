/**
 * 广告判定队列认领、待检消息束容量记账与处置抑制表访问（Anti-Raid Worker 侧，状态位于
 * `cache/workers/antiRaid/adDetect.ts`，跨模块约束见 `docs/cn/04-invariants.md`）。
 */

import { logger } from "../../../infra/logger";
import {
  adDetectCapacitySaturated,
  adDetectQueue,
  adDetectSaturated,
  inFlightAdDetectKeys,
  pendingAdBundleCount,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_JUDGED_RETENTION_WINDOW_MS,
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../../../consts/antiRaid/adDetect";
import {
  admitAdRequeue,
  isNewAdBundleAtCapacity,
} from "../../../states/adDetectAdmission";
import { latestSeq } from "./bundle";
import { requireVerificationKey, verificationKey } from "../../../libs/verificationKey";
import type { ParsedVerificationKey } from "../../../libs/verificationKey";
import type { AdMessageBundle } from "../../../types/antiRaid/adDetect";
import type { AdRequeueDecision } from "../../../types/states/adDetectAdmission";

/**
 * 若消息束仍有未判内容且该键未排队、不在途，则同步登记 `queuedAdDetectKeys` 并推入 `adDetectQueue`。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @param bundle 待检消息束。
 */
export function requeueIfUnchecked(key: string, bundle: AdMessageBundle): void {
  const decision: AdRequeueDecision = admitAdRequeue({
    hasUncheckedContent: latestSeq(bundle) > bundle.checkedSeq,
    queued: queuedAdDetectKeys.has(key),
    inFlight: inFlightAdDetectKeys.has(key),
  });
  if (decision === "skip") return;
  queuedAdDetectKeys.add(key);
  adDetectQueue.push(key);
}

/**
 * 读取指定群与发送者的待检消息束。
 *
 * @param chatId 目标群 ID。
 * @param senderId 发送者 ID。
 * @returns 匹配的待检消息束；不存在时返回 `undefined`。
 */
export function pendingAdBundle(chatId: number, senderId: number): AdMessageBundle | undefined {
  return pendingAdMessages.get(chatId)?.get(senderId);
}

/**
 * 按队列键读取待检消息束。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @returns 匹配的待检消息束；不存在时返回 `undefined`。
 */
export function pendingAdBundleForKey(key: string): AdMessageBundle | undefined {
  const parsed: ParsedVerificationKey = requireVerificationKey(key);
  return pendingAdBundle(parsed.chatId, parsed.userId);
}

/**
 * 将新建的消息束存入 `pendingAdMessages` 并递增 `pendingAdBundleCount`、刷新容量饱和状态。
 *
 * @param bundle 新建的待检消息束。
 */
export function storeBundle(bundle: AdMessageBundle): void {
  let bundles: Map<number, AdMessageBundle> | undefined = pendingAdMessages.get(bundle.chatId);
  if (bundles === undefined) {
    bundles = new Map();
    pendingAdMessages.set(bundle.chatId, bundles);
  }
  bundles.set(bundle.senderId, bundle);
  pendingAdBundleCount.current++;
  refreshAdDetectCapacitySaturation();
}

/**
 * 删除指定群与发送者的消息束并刷新容量饱和状态。
 *
 * @param chatId 目标群 ID。
 * @param senderId 发送者 ID。
 */
export function deletePendingAdBundle(chatId: number, senderId: number): void {
  const bundles: Map<number, AdMessageBundle> | undefined = pendingAdMessages.get(chatId);
  if (bundles?.delete(senderId) !== true) return;
  pendingAdBundleCount.current--;
  if (bundles.size === 0) pendingAdMessages.delete(chatId);
  refreshAdDetectCapacitySaturation();
}

/**
 * 删除指定群的全部待检消息束并刷新容量饱和状态。
 *
 * @param chatId 目标群 ID。
 */
export function deletePendingAdBundlesInChat(chatId: number): void {
  const bundles: Map<number, AdMessageBundle> | undefined = pendingAdMessages.get(chatId);
  if (bundles === undefined) return;
  pendingAdBundleCount.current -= bundles.size;
  pendingAdMessages.delete(chatId);
  refreshAdDetectCapacitySaturation();
}

/**
 * 删除指定发送者在各群的待检消息束并刷新容量饱和状态。
 *
 * @param senderId 发送者 ID。
 */
export function deletePendingAdBundlesOfSender(senderId: number): void {
  let deleted: boolean = false;
  for (const [chatId, bundles] of pendingAdMessages) {
    if (!bundles.delete(senderId)) continue;
    deleted = true;
    pendingAdBundleCount.current--;
    if (bundles.size === 0) pendingAdMessages.delete(chatId);
  }
  if (deleted) refreshAdDetectCapacitySaturation();
}

/** 清空全部待检消息束并重置计数。 */
export function clearPendingAdBundles(): void {
  pendingAdMessages.clear();
  pendingAdBundleCount.current = 0;
}

/**
 * 判定处置抑制记录是否仍在 `AD_DETECT_JUDGED_RETENTION_WINDOW_MS` 单调时钟窗口内（见 `docs/cn/04-invariants.md`）。
 *
 * @param disposedAt 记录处置时的单调时钟毫秒读数。
 * @param now 当前单调时钟毫秒读数。
 * @returns 仍在抑制窗口内时返回 `true`。
 */
function adDisposalMarkerActive(disposedAt: number, now: number): boolean {
  const elapsedMs: number = now - disposedAt;
  return elapsedMs >= 0 && elapsedMs < AD_DETECT_JUDGED_RETENTION_WINDOW_MS;
}

/**
 * 查询指定键是否存在未过期的处置抑制记录；已过期记录在读取时即地删除。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @returns 存在未过期处置抑制记录时返回 `true`。
 */
export function hasActiveAdDisposalMarker(key: string): boolean {
  const disposedAt: number | undefined = recentlyDisposedAdKeys.get(key);
  if (disposedAt === undefined) return false;
  if (adDisposalMarkerActive(disposedAt, performance.now())) return true;
  recentlyDisposedAdKeys.delete(key);
  return false;
}

/**
 * 扫描并清理已过期的处置抑制记录。
 *
 * @param now 当前单调时钟毫秒读数，默认取 `performance.now()`。
 */
export function expireAdDetectDisposalMarkers(now: number = performance.now()): void {
  for (const [key, disposedAt] of recentlyDisposedAdKeys) {
    if (!adDisposalMarkerActive(disposedAt, now)) recentlyDisposedAdKeys.delete(key);
  }
}

/**
 * 判定待检发送者总数是否已达 `AD_DETECT_MAX_PENDING_SENDERS` 上限并记录容量边沿日志。
 *
 * @returns 已达上限需拒绝新建消息束时返回 `true`。
 */
export function rejectNewAdBundleAtCapacity(): boolean {
  if (!isNewAdBundleAtCapacity(pendingAdBundleCount.current)) return false;
  noteAdDetectCapacitySaturation(true);
  return true;
}

/**
 * 在封禁取得确定结果后移除该发送者的处置抑制记录。
 *
 * @param chatId 目标群 ID。
 * @param senderId 发送者 ID。
 */
export function releaseAdDetectDedupKey(chatId: number, senderId: number): void {
  recentlyDisposedAdKeys.delete(verificationKey(chatId, senderId));
}

/**
 * 记录在途判定数量触顶或恢复的边沿日志。
 *
 * @param saturated 当前在途判定是否已达上限。
 */
export function noteAdDetectSaturation(saturated: boolean): void {
  if (saturated === adDetectSaturated.current) return;
  adDetectSaturated.current = saturated;
  logger.error(saturated
    ? `Ad detection reached its ${AD_DETECT_MAX_IN_FLIGHT} in-flight ceiling; ` +
      `${adDetectQueue.size} accepted key(s) remain queued.`
    : "Ad detection dropped back below its in-flight ceiling."
  );
}

/**
 * 记录待检发送者容量触顶或恢复的边沿日志。
 *
 * @param saturated 当前待检发送者数是否已达容量上限。
 */
function noteAdDetectCapacitySaturation(saturated: boolean): void {
  if (saturated === adDetectCapacitySaturated.current) return;
  adDetectCapacitySaturated.current = saturated;
  logger.error(saturated
    ? `Ad detection reached its ${AD_DETECT_MAX_PENDING_SENDERS} pending-key ceiling; ` +
      "new distinct senders will be rejected until capacity recovers."
    : "Ad detection pending-key capacity recovered below its ceiling."
  );
}

/** 根据当前 `pendingAdBundleCount` 刷新容量饱和状态。 */
function refreshAdDetectCapacitySaturation(): void {
  noteAdDetectCapacitySaturation(
    isNewAdBundleAtCapacity(pendingAdBundleCount.current)
  );
}
