/**
 * 黑名单补扫权限闩锁与整批处置终局结算：权限拒绝置锁、权限恢复重投，以及回执销账与退避更新。
 */

import {
  blocklistSweepSchedulerState,
  blocklistSweepState,
  pendingBlockedRemovals,
} from "../../cache/main/blocklist";
import { logger } from "../logger";
import { queueBlocklistRemovalWrite } from "./outbox";
import { replayPendingBlockedRemovalsForChat } from "./sweepReplay";
import {
  nextFailedSweeps,
  recordPendingRemovalFailure,
  requestBlocklistResweep,
  sweepRetryDelayMs,
} from "./sweepRetryState";
import { armBlocklistSweepScheduler } from "./sweepScheduler";
import type { BlockedMembersRemovedEvent } from "../../types/antiRaid/events";
import type { BlocklistSweepRecord } from "../../types/blocklist";

/**
 * 记录群缺少封禁权限并置位权限闩锁；指名批次直接销账，补扫批次标记为 missing-permission。
 *
 * @param chatId 缺少封禁权限的群 ID。
 * @param removalId 触发权限拒绝回执的待踢任务编号。
 */
function notePermissionBlocked(chatId: number, removalId: number): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.permissionBlocked !== true) {
    logger.error(
      "Blocklist removal is blocked by missing ban rights; waiting for permission changes.",
      { removalId, chatId }
    );
  }
  if (pendingBlockedRemovals.get(removalId)?.params.probeMembership === false) {
    pendingBlockedRemovals.delete(removalId);
    if (!queueBlocklistRemovalWrite(removalId)) {
      logger.error("Failed to queue permission-blocked blocklist removal cleanup.", { removalId, chatId });
    }
  } else {
    recordPendingRemovalFailure(removalId, chatId, "missing-permission");
  }
  blocklistSweepState.set(chatId, progress === undefined
    ? {
      removalId: null,
      sweptAt: null,
      nextRetryAt: Date.now(),
      resweepRequested: false,
      failedSweeps: 0,
      permissionBlocked: true,
    }
    : { ...progress, permissionBlocked: true });
  armBlocklistSweepScheduler();
}

/**
 * 观测到封禁权限恢复时解除群权限闩锁、重排补扫调度并重投冻结批次。
 *
 * @param chatId 被观测到权限变更的群 ID。
 * @param canRestrict 机器人当前是否具备封禁/限制成员权限。
 */
export function noteBanPermissionObserved(chatId: number, canRestrict: boolean): void {
  if (!canRestrict) return;
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.permissionBlocked !== true) return;
  logger.info("Ban rights restored; re-arming blocklist sweep.", { chatId });
  blocklistSweepState.set(chatId, {
    removalId: null,
    sweptAt: null,
    nextRetryAt: Date.now(),
    resweepRequested: false,
    failedSweeps: 0,
    permissionBlocked: false,
  });
  armBlocklistSweepScheduler();
  replayPendingBlockedRemovalsForChat(chatId);
}

/**
 * 结算整批处置结果：销账、置位权限闩锁或记录失败，并更新群补扫状态与调度器。
 *
 * @param event Anti-Raid Worker 上报的黑名单成员处置完成事件。
 */
export function settleRemovalOutcome(event: BlockedMembersRemovedEvent): void {
  if (
    !pendingBlockedRemovals.has(event.removalId) &&
    !blocklistSweepState.has(event.chatId)
  ) {
    return;
  }
  if (event.complete) {
    if (
      pendingBlockedRemovals.delete(event.removalId) &&
      !queueBlocklistRemovalWrite(event.removalId)
    ) {
      logger.error("Failed to queue completed blocklist removal cleanup.", {
        removalId: event.removalId,
        chatId: event.chatId,
      });
    }
  } else if (event.permissionDenied === true) {
    notePermissionBlocked(event.chatId, event.removalId);
  } else {
    const summary: string = "Blocklist removal did not fully settle; it will be retried.";
    if (blocklistSweepSchedulerState.accepting) {
      logger.error(summary, { removalId: event.removalId, chatId: event.chatId });
    } else {
      logger.info(summary, { removalId: event.removalId, chatId: event.chatId });
    }
    recordPendingRemovalFailure(event.removalId, event.chatId, "side-effect-incomplete");
  }

  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(event.chatId);
  if (progress?.removalId !== event.removalId) {
    if ((!event.complete || event.targetIsAdmin === true) && event.permissionDenied !== true) {
      requestBlocklistResweep(
        event.chatId,
        Date.now() + sweepRetryDelayMs(progress?.failedSweeps ?? 0)
      );
    }
    armBlocklistSweepScheduler();
    return;
  }

  const stillOwesSweep: boolean =
    progress.resweepRequested || event.targetIsAdmin === true;
  const failedSweeps: number = event.complete && !stillOwesSweep
    ? 0
    : nextFailedSweeps(progress.failedSweeps);
  blocklistSweepState.set(event.chatId, {
    removalId: null,
    sweptAt: event.complete && !stillOwesSweep ? Date.now() : null,
    nextRetryAt: progress.nextRetryAt,
    resweepRequested: false,
    failedSweeps,
    permissionBlocked: blocklistSweepState.get(event.chatId)?.permissionBlocked === true,
  });
  armBlocklistSweepScheduler();
}
