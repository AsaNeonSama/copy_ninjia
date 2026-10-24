import { LOCKDOWN_RETRIGGER_COOLDOWN_MS, NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import type {
  LockdownAbandonReason,
  LockdownAnnouncement,
  LockdownEffect,
  LockdownState,
} from "../../types/states/lockdown";

/**
 * 本轮公告的记账原样带到下一阶段。
 * @param state 当前私密模式状态。
 * @returns 提取出的公告记账字段。
 */
export function announcementOf(state: LockdownState): LockdownAnnouncement {
  return {
    announced: state.announced,
    announcementPending: state.announcementPending,
    announcementMessageId: state.announcementMessageId,
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
