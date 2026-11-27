/**
 * 首次引用类广告命中的公开警告发送、警告前消息清理与警告后残留条目保留编排（Anti-Raid Worker 侧）：
 * - 在 `inFlightAdDetectKeys` 保护下向主线程发送 30 秒自删的公开警告提示；
 * - 双工 RPC 抛错时按 fail-closed 取消本次警告且不执行删帖，仅裁剪已判定条目避免污染后续消息；
 * - 按主线程批准后的警告发送结果推进 `referencePolicy` 状态机，清理不晚于警告消息（或已判定上界）的历史消息；
 * - 裁剪已处置条目与待删 ID，并按保留条目的不可变 `senderText` 重算引文去重与警告窗口标记。
 */

import {
  adDetectStopping,
  inFlightAdDetectKeys,
} from "../../../cache/workers/antiRaid/adDetect";
import { AD_REFERENCE_WARNING_WINDOW_MS } from "../../../consts/antiRaid/adDetect/limits";
import { logger } from "../../../infra/logger";
import { deleteMessage, telegramApi } from "../../../infra/telegram";
import type {
  AdCandidateEntry,
  AdMessageBundle,
} from "../../../types/antiRaid/adDetect";
import type {
  TelegramWorkerTemporaryMessageResult,
  TelegramWorkerTemporaryMessageSentResult,
} from "../../../types/telegramWorker";
import { claimSampleContextParts } from "./bundle";
import {
  deleteReferencedAdMessages,
  warnReferencedAdSender,
} from "./disposal";
import {
  deletePendingAdBundle,
  pendingAdBundle,
  requeueIfUnchecked,
} from "./queueState";
import {
  beginReferencedAdWarning,
  cancelReferencedAdWarning,
  completeReferencedAdWarning,
} from "./referencePolicy";

/**
 * 提取本次送检条目快照中的最大消息 ID；快照为空时返回 0。
 *
 * @param entries 本次送检入选的条目列表。
 * @returns 最大 `messageId`。
 */
function maxMessageId(entries: readonly AdCandidateEntry[]): number {
  let maxId: number = 0;
  for (const entry of entries) {
    if (entry.messageId > maxId) maxId = entry.messageId;
  }
  return maxId;
}

/**
 * 裁剪不晚于 `messageIdThrough` 的已处置条目与待删 ID，并按保留条目的不可变 `senderText`
 * 重新计算引用去重；给出 `warningSentAt` 时同步刷新剩余条目的警告窗口标记（`AD_REFERENCE_WARNING_WINDOW_MS`）。
 *
 * @param bundle 待检消息束。
 * @param messageIdThrough 已触发清理的消息 ID 上界（含）。
 * @param warningSentAt 公开警告消息发送时刻；警告发送失败时缺省，不改写既有窗口标记。
 */
function retainPostWarningContent(
  bundle: AdMessageBundle,
  messageIdThrough: number,
  warningSentAt?: number
): void {
  const retainedEntries: AdCandidateEntry[] = [];
  for (const entry of bundle.entries) {
    if (entry.messageId <= messageIdThrough) continue;
    if (
      entry.text.length > 0 &&
      (entry.quote !== undefined || entry.replyTo !== undefined)
    ) {
      entry.text = claimSampleContextParts(
        entry.senderText,
        entry,
        retainedEntries
      );
    }
    if (warningSentAt !== undefined) {
      entry.withinReferencedWarning =
        entry.receivedAt - warningSentAt < AD_REFERENCE_WARNING_WINDOW_MS;
    }
    retainedEntries.push(entry);
  }
  bundle.entries = retainedEntries;

  let pendingIdWriteIndex: number = 0;
  for (const messageId of bundle.pendingDeleteIds) {
    if (messageId <= messageIdThrough) continue;
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
 * 处理首次引用类广告命中：在 `inFlightAdDetectKeys` 保护下发送公开警告、删除警告前消息并保留警告后新消息重排。
 * 双工 RPC 抛错时无法确认主线程白名单与群开关裁决，按 fail-closed 取消警告且跳过删帖；
 * 仅在主线程放行后 Telegram 发送失败（返回 `undefined`）或发送成功时才删除引用广告消息。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 */
export async function warnReferencedOnlySender(
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
        "Ad detection failed to send referenced-ad warning:",
        { chatId: bundle.chatId, senderId: bundle.senderId },
        error
      );
      cancelReferencedAdWarning(key, warningGeneration);
      if (
        !adDetectStopping.current &&
        pendingAdBundle(bundle.chatId, bundle.senderId) === bundle
      ) {
        retainPostWarningContent(bundle, maxMessageId(judged));
      }
      return;
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
        const messageIdThrough: number = maxMessageId(judged);
        deleteReferencedAdMessages({
          bundle,
          judged,
          messageIdThrough,
        });
        retainPostWarningContent(bundle, messageIdThrough);
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
    retainPostWarningContent(bundle, warning.messageId, warning.sentAt);
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
