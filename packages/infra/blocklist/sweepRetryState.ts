import {
  blocklistSweepState,
  pendingBlockedRemovals,
  unwrittenRemovalDiagnostics,
} from "../../cache/main/blocklist";
import {
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
  BLOCKLIST_SWEEP_RETRY_INTERVAL_MS,
  BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS,
} from "../../consts/antiRaid/blocklist";
import type {
  BlocklistRemovalFailure,
  BlocklistSweepRecord,
  PendingBlockedRemoval,
} from "../../types/blocklist";
import { logger } from "../logger";
import { queueBlocklistRemovalWrite } from "./outbox";
import { armBlocklistSweepScheduler } from "./sweepScheduler";

/**
 * 按连续失败次数线性放大重扫间隔，并封顶。
 *
 * @param failedSweeps 当前已累计的连续失败补扫次数。
 * @returns 下一次补扫重试的退避延迟毫秒数。
 */
export function sweepRetryDelayMs(failedSweeps: number): number {
  return Math.min(
    BLOCKLIST_SWEEP_RETRY_INTERVAL_MS * (failedSweeps + 1),
    BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS
  );
}

/**
 * 退避顶到上限后不再自增；该计数只服务于延迟计算。
 *
 * @param failedSweeps 当前连续失败补扫次数。
 * @returns 本次失败结算后的新连续失败计数。
 */
export function nextFailedSweeps(failedSweeps: number): number {
  return sweepRetryDelayMs(failedSweeps) >= BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS
    ? failedSweeps
    : failedSweeps + 1;
}

/**
 * 让一个未被权限闩锁的群重新欠一次补扫。
 *
 * @param chatId 目标受管群 ID。
 * @param nextRetryAt 下一次允许发起补扫的最早毫秒时间戳，默认取 `Date.now()`。
 */
export function requestBlocklistResweep(
  chatId: number,
  nextRetryAt: number = Date.now()
): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.permissionBlocked === true) return;
  blocklistSweepState.set(chatId, {
    removalId: progress?.removalId ?? null,
    sweptAt: null,
    nextRetryAt,
    resweepRequested:
      progress?.removalId !== null && progress?.removalId !== undefined,
    failedSweeps: progress?.failedSweeps ?? 0,
    permissionBlocked: false,
  });
  armBlocklistSweepScheduler();
}

/**
 * 清掉当前 claim、推进失败计数并按退避截止时间重排。
 *
 * @param chatId 目标受管群 ID。
 * @param failedSweeps 本次失败前的连续失败补扫次数。
 * @param now 当前毫秒时间戳。
 */
export function noteSweepAttemptFailed(
  chatId: number,
  failedSweeps: number,
  now: number
): void {
  blocklistSweepState.set(chatId, {
    removalId: null,
    sweptAt: null,
    nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
    resweepRequested: false,
    failedSweeps: nextFailedSweeps(failedSweeps),
    permissionBlocked:
      blocklistSweepState.get(chatId)?.permissionBlocked === true,
  });
  armBlocklistSweepScheduler();
}

/**
 * 更新任务内存诊断并记入 unwrittenRemovalDiagnostics；首次达到告警阈值时记录错误日志。
 *
 * @param removalId 待更新诊断的待踢任务编号。
 * @param chatId 任务所属群 ID。
 * @param failure 本次失败原因分类。
 * @returns 任务仍在镜像中且已更新诊断时返回 `true`，任务不存在时返回 `false`。
 */
export function updatePendingRemovalFailure(
  removalId: number,
  chatId: number,
  failure: BlocklistRemovalFailure
): boolean {
  const pending: PendingBlockedRemoval | undefined =
    pendingBlockedRemovals.get(removalId);
  if (pending === undefined) return false;
  if (pending.attempts < Number.MAX_SAFE_INTEGER) pending.attempts++;
  pending.lastFailure = failure;
  unwrittenRemovalDiagnostics.add(removalId);
  if (pending.attempts === BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS) {
    logger.error(
      `Blocklist removal ${removalId} for chat ${chatId} failed ${pending.attempts} time(s); ` +
      "retaining its durable outbox entry until completion or authoritative cancellation."
    );
  }
  return true;
}

/**
 * 更新任务诊断；首次置为 missing-permission 或达到告警阈值时立即投递行写入。
 *
 * @param removalId 待记录失败的待踢任务编号。
 * @param chatId 任务所属群 ID。
 * @param failure 本次失败原因分类。
 */
export function recordPendingRemovalFailure(
  removalId: number,
  chatId: number,
  failure: BlocklistRemovalFailure
): void {
  const pending: PendingBlockedRemoval | undefined =
    pendingBlockedRemovals.get(removalId);
  if (pending === undefined) return;
  const permissionMarked: boolean =
    failure === "missing-permission" &&
    pending.lastFailure !== "missing-permission";
  updatePendingRemovalFailure(removalId, chatId, failure);
  if (
    !permissionMarked &&
    pending.attempts !== BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS
  ) {
    return;
  }
  if (!queueBlocklistRemovalWrite(removalId)) {
    logger.error(`Failed to queue blocklist removal retry state ${removalId}.`);
  }
}
