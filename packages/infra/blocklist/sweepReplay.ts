import {
  blockedMemberRemoverHolder,
  blocklistSweepPages,
  blocklistSweepState,
  pendingBlockedRemovals,
} from "../../cache/main/blocklist";
import type {
  BlocklistSweepRecord,
  RemoveBlockedMembersParams,
} from "../../types/blocklist";
import type { BlocklistIdPage } from "../../types/identityStorage";
import { logger } from "../logger";
import {
  hasAnyBlockedIdentity,
  readBlocklistSweepPage,
} from "../identityStorage";
import { materializeRemovalParams } from "./outbox";
import {
  noteSweepAttemptFailed,
  recordPendingRemovalFailure,
  requestBlocklistResweep,
  sweepRetryDelayMs,
  updatePendingRemovalFailure,
} from "./sweepRetryState";

/**
 * 权限恢复后只重投该群冻结的秒踢/广告批次，补扫由新一轮重新登记。
 *
 * @param chatId 封禁权限已恢复的受管群 ID。
 */
export function replayPendingBlockedRemovalsForChat(chatId: number): void {
  const removals: RemoveBlockedMembersParams[] = [];
  for (const pending of pendingBlockedRemovals.values()) {
    if (
      pending.params.chatId !== chatId ||
      pending.params.probeMembership
    ) {
      continue;
    }
    const params: RemoveBlockedMembersParams | undefined =
      materializeRemovalParams(pending.params);
    if (params !== undefined) removals.push(params);
  }
  if (removals.length === 0) return;
  void blockedMemberRemoverHolder.current(removals).catch(
    (error: unknown): void => {
      logger.error(
        `Failed to replay ${removals.length} permission-blocked removal batch(es) for chat ${chatId}:`,
        error
      );
      rearmSweepAfterFailedReplay([chatId]);
    }
  );
}

/**
 * durable 重投交接失败后，让涉及的群重新欠一次全名单补扫。
 *
 * @param chatIds 重投失败涉及的受管群 ID 可迭代集合。
 * @param sweepRemovalIds 各群在本次重投中关联的补扫任务编号映射（键为 `chatId`，值为 `removalId`）。
 */
function rearmSweepAfterFailedReplay(
  chatIds: Iterable<number>,
  sweepRemovalIds: ReadonlyMap<number, number> = new Map()
): void {
  for (const chatId of chatIds) {
    const progress: BlocklistSweepRecord | undefined =
      blocklistSweepState.get(chatId);
    const sweepRemovalId: number | undefined = sweepRemovalIds.get(chatId);
    if (
      sweepRemovalId !== undefined &&
      progress?.removalId === sweepRemovalId
    ) {
      blocklistSweepPages.delete(sweepRemovalId);
      recordPendingRemovalFailure(
        sweepRemovalId,
        chatId,
        "delivery-boundary"
      );
      noteSweepAttemptFailed(chatId, progress.failedSweeps, Date.now());
      continue;
    }
    requestBlocklistResweep(
      chatId,
      Date.now() + sweepRetryDelayMs(progress?.failedSweeps ?? 0)
    );
  }
}

/**
 * Anti-Raid Worker 重建后重投全部未销账任务。
 *
 * @param countPreviousAttempt 为 `true` 时将重投前的一轮计入任务失败尝试次数（记为 `worker-restarted`）。
 */
export function replayPendingBlockedRemovals(
  countPreviousAttempt: boolean = true
): void {
  void replayPendingBlockedRemovalsAsync(countPreviousAttempt);
}

/**
 * 异步执行全部未销账黑名单处置任务的重投。
 *
 * @param countPreviousAttempt 为 `true` 时将重投前的一轮计入任务失败尝试次数。
 */
async function replayPendingBlockedRemovalsAsync(
  countPreviousAttempt: boolean
): Promise<void> {
  const removals: RemoveBlockedMembersParams[] = [];
  const replayedChatIds: Set<number> = new Set<number>();
  const deferredSweepChatIds: Set<number> = new Set<number>();
  const replayedSweepRemovalIds: Map<number, number> = new Map();
  const deferredSweepRemovalIds: Map<number, number> = new Map();
  let page: BlocklistIdPage = { ids: [], nextCursor: null, done: true };
  blocklistSweepPages.clear();
  try {
    if (hasAnyBlockedIdentity()) page = await readBlocklistSweepPage(null);
  } catch (error: unknown) {
    logger.error(
      "Failed to read the first blocklist ID page for pending removal replay:",
      error
    );
  }
  for (const [removalId, pending] of [...pendingBlockedRemovals]) {
    if (
      blocklistSweepState.get(pending.params.chatId)?.permissionBlocked === true
    ) {
      continue;
    }
    const blockedIds: readonly number[] = pending.params.probeMembership
      ? page.ids
      : [];
    const params: RemoveBlockedMembersParams | undefined =
      materializeRemovalParams(pending.params, blockedIds);
    if (params === undefined) {
      if (pending.params.probeMembership) {
        deferredSweepChatIds.add(pending.params.chatId);
        deferredSweepRemovalIds.set(pending.params.chatId, removalId);
      }
      continue;
    }
    if (countPreviousAttempt) {
      updatePendingRemovalFailure(
        removalId,
        pending.params.chatId,
        "worker-restarted"
      );
    }
    if (pending.params.probeMembership) {
      blocklistSweepPages.set(removalId, {
        chatId: pending.params.chatId,
        nextCursor: page.nextCursor,
        done: page.done,
        awaitingAck: true,
      });
      replayedSweepRemovalIds.set(pending.params.chatId, removalId);
    }
    removals.push(params);
    replayedChatIds.add(pending.params.chatId);
  }
  if (deferredSweepChatIds.size > 0) {
    rearmSweepAfterFailedReplay(
      deferredSweepChatIds,
      deferredSweepRemovalIds
    );
  }
  if (removals.length === 0) return;
  await blockedMemberRemoverHolder.current(removals).catch(
    (error: unknown): void => {
      logger.error(
        `Failed to replay ${removals.length} blocklist removal batch(es):`,
        error
      );
      rearmSweepAfterFailedReplay(replayedChatIds, replayedSweepRemovalIds);
    }
  );
}
