import { LOCKDOWN_RETRIGGER_COOLDOWN_MS, NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import type { ChatPermissions } from "grammy/types";
import type {
  LockdownAbandonReason,
  LockdownActiveState,
  LockdownAnnouncement,
  LockdownEffect,
  LockdownPreparedState,
  LockdownPreparingState,
  LockdownReconcilingState,
  LockdownRestoreReason,
  LockdownRestoringState,
  LockdownState,
} from "../../types/states/lockdown";

/**
 * 构造 applying preparing 同步占位状态；初始尚未发出公告，标记一次公告在途。
 * @returns 初始化完成的 LockdownPreparingState。
 */
export function preparingOf(): LockdownPreparingState {
  return {
    kind: "applying",
    stage: "preparing",
    announced: false,
    announcementPending: true,
    announcementMessageId: undefined,
  };
}

/** preparedOf 的入参。 */
export interface LockdownPreparedParams {
  /** 进入私密模式前读取到的群原始权限。 */
  readonly originalPermissions: ChatPermissions;
  /** 本轮私密模式意图序号。 */
  readonly intentId: number;
  /** 是否已派发 commitApply。 */
  readonly commitStarted: boolean;
  /** 本轮封锁公告记账字段。 */
  readonly announcement: LockdownAnnouncement;
}

/**
 * 构造 applying prepared 阶段状态。
 * @param params 原权限、意图序号、提交标志与公告记账参数。
 * @returns 初始化完成的 LockdownPreparedState。
 */
export function preparedOf({
  originalPermissions,
  intentId,
  commitStarted,
  announcement,
}: LockdownPreparedParams): LockdownPreparedState {
  return {
    kind: "applying",
    stage: "prepared",
    originalPermissions,
    intentId,
    commitStarted,
    announced: announcement.announced,
    announcementPending: announcement.announcementPending,
    announcementMessageId: announcement.announcementMessageId,
  };
}

/**
 * 构造 active 阶段状态。
 * @param originalPermissions 进入私密模式前读取到的群原始权限。
 * @param intentId 本轮私密模式意图序号。
 * @param announcement 本轮封锁公告记账字段。
 * @returns 初始化完成的 LockdownActiveState。
 */
export function activeOf(
  originalPermissions: ChatPermissions,
  intentId: number,
  announcement: LockdownAnnouncement
): LockdownActiveState {
  return {
    kind: "active",
    originalPermissions,
    intentId,
    announced: announcement.announced,
    announcementPending: announcement.announcementPending,
    announcementMessageId: announcement.announcementMessageId,
  };
}

/** reconcilingOf 的入参。 */
export interface LockdownReconcilingParams {
  /** 进入私密模式前读取到的群原始权限。 */
  readonly originalPermissions: ChatPermissions;
  /** 本轮私密模式意图序号。 */
  readonly intentId: number;
  /** 是否等待本阶段落盘回执后再启动重新收紧。 */
  readonly reapplyAfterPersist: boolean;
  /** 本轮封锁公告记账字段。 */
  readonly announcement: LockdownAnnouncement;
}

/**
 * 构造 reconciling 阶段状态。
 * @param params 原权限、意图序号、落盘后纠偏标志与公告记账参数。
 * @returns 初始化完成的 LockdownReconcilingState。
 */
export function reconcilingOf({
  originalPermissions,
  intentId,
  reapplyAfterPersist,
  announcement,
}: LockdownReconcilingParams): LockdownReconcilingState {
  return {
    kind: "reconciling",
    originalPermissions,
    intentId,
    reapplyAfterPersist,
    announced: announcement.announced,
    announcementPending: announcement.announcementPending,
    announcementMessageId: announcement.announcementMessageId,
  };
}

/** restoringOf 的入参。 */
export interface LockdownRestoringParams {
  /** 进入私密模式前读取到的群原始权限。 */
  readonly originalPermissions: ChatPermissions;
  /** 本轮恢复意图序号。 */
  readonly intentId: number;
  /** 是否等待本阶段落盘回执后再启动权限恢复。 */
  readonly restoreAfterPersist: boolean;
  /** 进入恢复阶段的原因（到期或提前解除）。 */
  readonly restoreReason: LockdownRestoreReason;
  /** 本轮封锁公告记账字段。 */
  readonly announcement: LockdownAnnouncement;
}

/**
 * 构造 restoring 阶段状态。
 * @param params 原权限、意图序号、落盘后恢复标志、恢复原因与公告记账参数。
 * @returns 初始化完成的 LockdownRestoringState。
 */
export function restoringOf({
  originalPermissions,
  intentId,
  restoreAfterPersist,
  restoreReason,
  announcement,
}: LockdownRestoringParams): LockdownRestoringState {
  return {
    kind: "restoring",
    originalPermissions,
    intentId,
    restoreAfterPersist,
    restoreReason,
    announced: announcement.announced,
    announcementPending: announcement.announcementPending,
    announcementMessageId: announcement.announcementMessageId,
  };
}

/**
 * 本轮结束时撤掉群里那条封锁公告；ID 未知（没发成功或还在途）就不删。
 * @param state 当前私密模式状态。
 * @returns 删除封锁公告的副作用数组；无消息 ID 时返回空数组。
 */
export function announcementCleanupEffects(state: LockdownState): readonly LockdownEffect[] {
  return state.announcementMessageId === undefined
    ? NO_LOCKDOWN_EFFECTS
    : [{ kind: "deleteLockdownAnnouncement", messageId: state.announcementMessageId }];
}

/**
 * 本轮作废时压制重触发；只在真正作废的那条转移里发出，迟到或重复的失败通知对已换代的状态不发。
 * @param reason 本轮私密模式作废的原因。
 * @returns 压制重触发的副作用对象。
 */
export function suppressRetrigger(reason: LockdownAbandonReason): LockdownEffect {
  return { kind: "suppressRetrigger", reason, durationMs: LOCKDOWN_RETRIGGER_COOLDOWN_MS };
}

/**
 * APPLYING 的 preparing 阶段还没有 intent，主线程无从落盘（见 publishLockdownState）。
 * @param state 待检查的私密模式状态。
 * @returns 已具备 intent 可供持久化时返回 true，否则返回 false。
 */
export function isPersistable(state: LockdownState): boolean {
  return state.kind !== "applying" || state.stage === "prepared";
}
