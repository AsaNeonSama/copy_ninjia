import { NO_LOCKDOWN_EFFECTS, RESTORE_RETRY_MS } from "../../consts/antiRaid/lockdown";
import { activeOf, announcementCleanupEffects, reconcilingOf, restoringOf } from "./shared";
import type { ChatPermissions } from "grammy/types";
import type {
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/**
 * 本轮到期：先落盘「要恢复」，落盘回执后才真的把权限还回去。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 恢复计时器到期事件。
 * @returns 进入 restoring 阶段并触发落盘的转移结果。
 */
export function handleRestoreTimerFired(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "restoreTimerFired" }>
): LockdownTransition {
  if (state?.kind !== "active" && state?.kind !== "reconciling") {
    return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  }
  return {
    next: restoringOf({
      originalPermissions: state.originalPermissions,
      intentId: event.intentId,
      restoreAfterPersist: true,
      restoreReason: "expired",
      announcement: state,
    }),
    effects: [{ kind: "persistState" }],
  };
}

/**
 * 恢复重试计时器到点：状态不变，只再发一次恢复。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @returns restoring 阶段下附带 beginRestore 副作用的转移结果。
 */
export function handleRestoreRetryFired(state: LockdownState | undefined): LockdownTransition {
  if (state?.kind !== "restoring") return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  return {
    next: state,
    effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }],
  };
}

/**
 * 纠偏重试计时器到点：状态不变，只再发一次重新收紧。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @returns reconciling 阶段下附带 beginReapply 副作用的转移结果。
 */
export function handleReapplyRetryFired(state: LockdownState | undefined): LockdownTransition {
  if (state?.kind !== "reconciling") return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  return { next: state, effects: [{ kind: "beginReapply" }] };
}

/**
 * 显式解除：占位阶段直接撤销并清理公告，其余阶段走与到期恢复同一条落盘优先的路径。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 显式解除私密模式事件。
 * @returns 撤销占位或进入 restoring 阶段并触发落盘的转移结果。
 */
export function handleDeactivate(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "deactivate" }>
): LockdownTransition {
  if (state === undefined) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (state.kind === "applying" && state.stage === "preparing") {
    return { next: undefined, effects: announcementCleanupEffects(state) };
  }
  const originalPermissions: ChatPermissions =
    state.originalPermissions;
  return {
    next: restoringOf({
      originalPermissions,
      intentId: event.intentId,
      restoreAfterPersist: true,
      // 到期恢复进行中再被解除时，解锁仍按到期公告。
      restoreReason: state.kind === "restoring" ? state.restoreReason : "lifted",
      announcement: state,
    }),
    effects: [{ kind: "persistState" }],
  };
}

/**
 * 群已不存在：任何阶段都直接删除记录，只报 unlock 让主线程清掉落盘的私密模式；不恢复权限、不删
 * 公告，群里已没有可调的 API。在途的权限调用随后回投的结果撞上空状态，不再推进。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @returns 清除内存状态并发出 reportUnlock 的转移结果。
 */
export function handleChatGone(state: LockdownState | undefined): LockdownTransition {
  if (state === undefined) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  return { next: undefined, effects: [{ kind: "reportUnlock" }] };
}

/**
 * 恢复调用结果；迟到回执与新一轮的关系见 docs/cn/04-invariants.md。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 权限恢复调用结果事件。
 * @returns 恢复完成收敛、转入 reconciling 纠偏或排期重试的转移结果。
 */
export function handleRestoreResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "restoreResult" }>
): LockdownTransition {
  if (state === undefined || state.kind === "applying") return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (event.ok) {
    if (state.kind === "active") {
      // ACTIVE 收到恢复成功回执时，先持久化远端权限与当前意图的差异，
      // 再重新收紧；RECONCILING 在 Worker 重建后仍可幂等接管。
      return {
        next: reconcilingOf({
          originalPermissions: state.originalPermissions,
          intentId: state.intentId,
          reapplyAfterPersist: true,
          announcement: state,
        }),
        effects: [{ kind: "persistState" }],
      };
    }
    if (state.kind === "reconciling") return { next: state, effects: NO_LOCKDOWN_EFFECTS };
    return {
      next: undefined,
      effects: state.announced
        ? [
          { kind: "reportUnlock" },
          ...announcementCleanupEffects(state),
          { kind: "announceUnlock", reason: state.restoreReason },
        ]
        : [{ kind: "reportUnlock" }, ...announcementCleanupEffects(state)],
    };
  }
  if (state.kind === "active" || state.kind === "reconciling") {
    // 当前意图仍为锁定，迟到的失败回执不改变它的倒计时或纠偏阶段。
    return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  }
  return { next: state, effects: [{ kind: "scheduleRestoreRetry", delayMs: RESTORE_RETRY_MS }] };
}

/**
 * 纠偏调用结果：成功则回到 ACTIVE 并持久化状态，失败则按固定间隔 RESTORE_RETRY_MS 排期重试。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 重新收紧权限调用结果事件。
 * @returns 回到 active 阶段或按固定间隔排期纠偏重试的转移结果。
 */
export function handleReapplyResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "reapplyResult" }>
): LockdownTransition {
  if (state?.kind !== "reconciling") return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (!event.ok) {
    return {
      next: state,
      effects: [{ kind: "scheduleReapplyRetry", delayMs: RESTORE_RETRY_MS }],
    };
  }
  return {
    next: activeOf(state.originalPermissions, state.intentId, state),
    effects: [{ kind: "persistState" }],
  };
}
