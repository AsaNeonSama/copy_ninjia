/**
 * 黑名单补扫的主线程状态机：退避、权限闩锁、分页推进与回执结算，参见 docs/cn/04-invariants.md。
 */

import {
  blockedMemberRemoverHolder,
  blocklistSweepPages,
  blocklistSweepSchedulerState,
  blocklistSweepState,
  pendingBlockedRemovals,
} from "../../cache/main/blocklist";
import { logger } from "../logger";
import { getChatStateCache } from "../storage/stateStore";
import {
  hasAnyBlockedIdentity,
  readBlocklistSweepPage,
} from "../identityStorage";
import {
  armBlocklistSweepScheduler,
  initBlocklistSweepScheduler as initSweepScheduler,
} from "./sweepScheduler";
import { canClaimSweep, isManagedAdminChat } from "./sweepEligibility";
import {
  forgetSupersededChatSweepBatches,
  materializeRemovalParams,
  queueBlocklistRemovalWrite,
  trackBlockedRemoval,
} from "./outbox";
import type { BlockedMembersRemovedEvent } from
  "../../types/antiRaid/events";
import type {
  BlocklistSweepPageState,
  BlocklistSweepRecord,
  PendingBlockedRemoval,
  RemoveBlockedMembersParams,
} from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";
import type { BlocklistIdPage } from "../../types/identityStorage";
import {
  nextFailedSweeps,
  noteSweepAttemptFailed,
  recordPendingRemovalFailure,
  requestBlocklistResweep,
  sweepRetryDelayMs,
} from "./sweepRetryState";
import { replayPendingBlockedRemovalsForChat } from "./sweepReplay";

export { requestBlocklistResweep } from "./sweepRetryState";
export { replayPendingBlockedRemovals } from "./sweepReplay";

export { quiesceBlocklistSweepScheduler } from "./sweepScheduler";

/** 以当前墙钟时间触发一次受管群黑名单补扫的调度回调。 */
const runScheduledBlocklistSweep: () => Promise<void> = (): Promise<void> =>
  sweepManagedBlocklistChats(Date.now());

/** 启动恢复完成后初始化补扫调度器。 */
export function initBlocklistSweepScheduler(): void {
  initSweepScheduler(runScheduledBlocklistSweep);
}

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
      `Blocklist removal ${removalId} for chat ${chatId} is blocked by missing ban rights; ` +
      "removals there wait for the bot's permissions to change."
    );
  }
  if (pendingBlockedRemovals.get(removalId)?.params.probeMembership === false) {
    pendingBlockedRemovals.delete(removalId);
    if (!queueBlocklistRemovalWrite(removalId)) {
      logger.error(`Failed to queue permission-blocked blocklist removal cleanup ${removalId}.`);
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
  logger.log(`Ban rights restored in chat ${chatId}; re-arming the blocklist sweep.`);
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

interface PreparedBlocklistSweep {
  chatId: number;
  params: RemoveBlockedMembersParams;
  failedSweeps: number;
  now: number;
}

/**
 * 为指定群建立补扫 claim 并登记首张游标页状态；不满足资格或登记失败时返回 null。
 *
 * @param chatId 目标受管群 ID。
 * @param now 当前毫秒时间戳。
 * @param page 首张黑名单 ID 游标页。
 * @returns 已登记 claim 的补扫准备上下文；不满足 claim 资格或登记失败时返回 `null`。
 */
function prepareBlocklistSweep(
  chatId: number,
  now: number,
  page: BlocklistIdPage
): PreparedBlocklistSweep | null {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (!canClaimSweep(progress, now)) return null;
  if (!hasAnyBlockedIdentity()) return null;
  const failedSweeps: number = progress?.failedSweeps ?? 0;
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({ chatId, probeMembership: true }, page.ids);
  } catch (error: unknown) {
    logger.error(`Failed to queue the blocklist sweep of chat ${chatId}:`, error);
    noteSweepAttemptFailed(chatId, failedSweeps, now);
    return null;
  }
  forgetSupersededChatSweepBatches(chatId, params.removalId);
  blocklistSweepState.set(chatId, {
    removalId: params.removalId,
    sweptAt: null,
    nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
    resweepRequested: false,
    failedSweeps,
    permissionBlocked: false,
  });
  blocklistSweepPages.set(params.removalId, {
    chatId,
    nextCursor: page.nextCursor,
    done: page.done,
    awaitingAck: true,
  });
  armBlocklistSweepScheduler();
  return { chatId, params, failedSweeps, now };
}

/**
 * 补扫批次投递失败时作废当前 claim、记录诊断并推进退避。
 *
 * @param sweeps 本轮已建立 claim 但投递失败的补扫批次列表。
 */
function abandonPreparedSweeps(sweeps: readonly PreparedBlocklistSweep[]): void {
  for (const sweep of sweeps) {
    if (
      blocklistSweepState.get(sweep.chatId)?.removalId ===
      sweep.params.removalId
    ) {
      recordPendingRemovalFailure(
        sweep.params.removalId,
        sweep.chatId,
        "delivery-boundary"
      );
      blocklistSweepPages.delete(sweep.params.removalId);
      noteSweepAttemptFailed(
        sweep.chatId,
        sweep.failedSweeps,
        sweep.now
      );
    }
  }
}

/**
 * 将已准备好的补扫批次统一交给执行回调投递；投递失败或未投出任何任务时回退 claim 并推进退避。
 *
 * @param sweeps 待投递给 Anti-Raid Worker 的补扫批次列表。
 */
async function deliverPreparedSweeps(
  sweeps: readonly PreparedBlocklistSweep[]
): Promise<void> {
  if (sweeps.length === 0) return;
  let deliveredCount: number;
  try {
    deliveredCount = await blockedMemberRemoverHolder.current(
      sweeps.map((sweep: PreparedBlocklistSweep): RemoveBlockedMembersParams =>
        sweep.params
      )
    );
  } catch (error: unknown) {
    abandonPreparedSweeps(sweeps);
    throw error;
  }
  if (deliveredCount > 0) return;
  abandonPreparedSweeps(sweeps);
  logger.error(
    `Blocklist sweep delivery posted nothing for ${sweeps.length} chat(s); ` +
    "the batches stay in the durable outbox and the sweeps were rescheduled."
  );
}

/**
 * 对单个受管群触发一次黑名单补扫。
 *
 * @param chatId 目标受管群 ID。
 * @param now 当前毫秒时间戳，默认取 `Date.now()`。
 */
export async function sweepBlockedMembers(
  chatId: number,
  now: number = Date.now()
): Promise<void> {
  try {
    if (!canClaimSweep(blocklistSweepState.get(chatId), now)) return;
    let page: BlocklistIdPage;
    try {
      page = hasAnyBlockedIdentity()
        ? await readBlocklistSweepPage(null)
        : { ids: [], nextCursor: null, done: true };
    } catch (error: unknown) {
      const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
      if (canClaimSweep(progress, now)) noteSweepAttemptFailed(chatId, progress?.failedSweeps ?? 0, now);
      throw error;
    }
    const sweep: PreparedBlocklistSweep | null = page.ids.length === 0
      ? null
      : prepareBlocklistSweep(chatId, now, page);
    if (sweep === null) return;
    await deliverPreparedSweeps([sweep]);
  } finally {
    armBlocklistSweepScheduler();
  }
}

/**
 * 黑名单页读取失败时，将本轮满足补扫资格的受管群统一推进一次失败退避。
 *
 * @param now 当前毫秒时间戳。
 */
function deferManagedBlocklistSweeps(now: number): void {
  for (const [chatId, state] of getChatStateCache()) {
    const chatState: ChatState = state;
    if (!isManagedAdminChat(chatState)) continue;
    const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
    if (!canClaimSweep(progress, now)) continue;
    noteSweepAttemptFailed(chatId, progress?.failedSweeps ?? 0, now);
  }
}

/**
 * 判断当前是否至少存在一个可建立补扫 claim 的受管群。
 *
 * @param now 当前毫秒时间戳。
 * @returns 存在至少一个可建立补扫 claim 的受管群时返回 `true`，否则返回 `false`。
 */
function hasClaimableManagedChat(now: number): boolean {
  for (const [chatId, state] of getChatStateCache()) {
    const chatState: ChatState = state;
    if (!isManagedAdminChat(chatState)) continue;
    if (canClaimSweep(blocklistSweepState.get(chatId), now)) return true;
  }
  return false;
}

/**
 * 对全部满足资格的受管群合并发起一轮黑名单补扫。
 *
 * @param now 当前毫秒时间戳，默认取 `Date.now()`。
 */
export async function sweepManagedBlocklistChats(
  now: number = Date.now()
): Promise<void> {
  try {
    if (!hasAnyBlockedIdentity()) return;
    if (!hasClaimableManagedChat(now)) return;
    let page: BlocklistIdPage;
    try {
      page = await readBlocklistSweepPage(null);
    } catch (error: unknown) {
      logger.error("Failed to read the first blocklist ID page for the managed chat sweep:", error);
      deferManagedBlocklistSweeps(now);
      return;
    }
    if (page.ids.length === 0) return;
    const sweeps: PreparedBlocklistSweep[] = [];
    for (const [chatId, state] of getChatStateCache()) {
      const chatState: ChatState = state;
      if (!isManagedAdminChat(chatState)) continue;
      const sweep: PreparedBlocklistSweep | null =
        prepareBlocklistSweep(chatId, now, page);
      if (sweep !== null) sweeps.push(sweep);
    }
    await deliverPreparedSweeps(sweeps);
  } finally {
    armBlocklistSweepScheduler();
  }
}

/**
 * 读取并投递同一补扫任务的下一张游标页；失败时释放 claim 并推进退避。
 *
 * @param chatId 目标受管群 ID。
 * @param removalId 当前补扫任务编号。
 * @param afterId 上一页末尾的黑名单身份 ID 游标。
 */
async function continueBlocklistSweep(
  chatId: number,
  removalId: number,
  afterId: number
): Promise<void> {
  try {
    const page: BlocklistIdPage = await readBlocklistSweepPage(afterId);
    const progress: BlocklistSweepRecord | undefined =
      blocklistSweepState.get(chatId);
    const pending: PendingBlockedRemoval | undefined =
      pendingBlockedRemovals.get(removalId);
    if (
      progress?.removalId !== removalId ||
      pending?.params.probeMembership !== true
    ) {
      blocklistSweepPages.delete(removalId);
      return;
    }
    if (page.ids.length === 0) {
      blocklistSweepPages.delete(removalId);
      settleBlockedRemoval({
        type: "blockedMembersRemoved",
        chatId,
        removalId,
        complete: true,
        permissionDenied: false,
        targetIsAdmin: false,
        participantInvalidUserIds: [],
        settledUserIds: [],
      });
      return;
    }
    const params: RemoveBlockedMembersParams | undefined =
      materializeRemovalParams(pending.params, page.ids);
    if (params === undefined) {
      throw new Error(`Blocklist sweep page for removal ${removalId} has no target.`);
    }
    blocklistSweepPages.set(removalId, {
      chatId,
      nextCursor: page.nextCursor,
      done: page.done,
      awaitingAck: true,
    });
    await deliverPreparedSweeps([{
      chatId,
      params,
      failedSweeps: progress.failedSweeps,
      now: Date.now(),
    }]);
  } catch (error: unknown) {
    const progress: BlocklistSweepRecord | undefined =
      blocklistSweepState.get(chatId);
    if (progress?.removalId === removalId) {
      recordPendingRemovalFailure(removalId, chatId, "delivery-boundary");
      blocklistSweepPages.delete(removalId);
      noteSweepAttemptFailed(chatId, progress.failedSweeps, Date.now());
    }
    logger.error(
      `Failed to continue blocklist sweep ${removalId} for chat ${chatId}:`,
      error
    );
  }
}

/**
 * 处理 Anti-Raid Worker 的黑名单处置回执：推进分页补扫或结算整批任务。
 *
 * @param event Anti-Raid Worker 上报的黑名单成员处置完成事件。
 */
export function settleBlockedRemoval(event: BlockedMembersRemovedEvent): void {
  if (advanceSweepPage(event)) return;
  settleRemovalOutcome(event);
}

/**
 * 处理分页补扫的非末页回执并触发下一页拉取；无需继续分页时返回 false。
 *
 * @param event Anti-Raid Worker 上报的黑名单成员处置完成事件。
 * @returns 已作为非末页补扫回执消费（或因重复/缺游标终止）时返回 `true`；需进入整批终局结算时返回 `false`。
 */
function advanceSweepPage(event: BlockedMembersRemovedEvent): boolean {
  const page: BlocklistSweepPageState | undefined =
    blocklistSweepPages.get(event.removalId);
  const currentProgress: BlocklistSweepRecord | undefined =
    blocklistSweepState.get(event.chatId);
  if (page === undefined || currentProgress?.removalId !== event.removalId) return false;
  if (!page.awaitingAck) return true;
  if (!event.complete || page.done) {
    blocklistSweepPages.delete(event.removalId);
    return false;
  }
  if (event.targetIsAdmin === true) {
    blocklistSweepState.set(event.chatId, {
      ...currentProgress,
      resweepRequested: true,
    });
  }
  if (page.nextCursor === null) {
    blocklistSweepPages.delete(event.removalId);
    recordPendingRemovalFailure(
      event.removalId,
      event.chatId,
      "delivery-boundary"
    );
    noteSweepAttemptFailed(
      event.chatId,
      currentProgress.failedSweeps,
      Date.now()
    );
    logger.error(
      `Non-final blocklist sweep ${event.removalId} is missing its next cursor.`
    );
    return true;
  }
  blocklistSweepPages.set(event.removalId, {
    ...page,
    awaitingAck: false,
  });
  void continueBlocklistSweep(
    event.chatId,
    event.removalId,
    page.nextCursor
  );
  return true;
}

/**
 * 结算整批处置结果：销账、置位权限闩锁或记录失败，并更新群补扫状态与调度器。
 *
 * @param event Anti-Raid Worker 上报的黑名单成员处置完成事件。
 */
function settleRemovalOutcome(event: BlockedMembersRemovedEvent): void {
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
      logger.error(`Failed to queue completed blocklist removal cleanup ${event.removalId}.`);
    }
  } else if (event.permissionDenied === true) {
    notePermissionBlocked(event.chatId, event.removalId);
  } else {
    const message: string =
      `Blocklist removal ${event.removalId} for chat ${event.chatId} did not fully settle; ` +
      "it will be retried.";
    if (blocklistSweepSchedulerState.accepting) logger.error(message);
    else logger.log(message);
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
