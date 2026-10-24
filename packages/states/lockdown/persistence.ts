import { NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import {
  announcementCleanupEffects,
  announcementOf,
  suppressRetrigger,
} from "./shared";
import type {
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/**
 * 本轮 intent 落盘成功：APPLYING 才允许改 Telegram，其余阶段释放等待中的动作。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 状态落盘成功回执事件。
 * @returns 释放等待动作后的状态转移结果。
 */
export function handleStatePersisted(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "statePersisted" }>
): LockdownTransition {
  if (state?.kind !== event.phase) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (state.kind === "applying") {
    if (
      state.stage !== "prepared" ||
      state.intentId !== event.intentId ||
      // 公告落盘与主线程对账可重复确认同一 intent，提交仅派发一次。
      state.commitStarted
    ) {
      return { next: state, effects: NO_LOCKDOWN_EFFECTS };
    }
    return { next: { ...state, commitStarted: true }, effects: [{ kind: "commitApply" }] };
  }
  if (state.intentId !== event.intentId) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (state.kind === "restoring" && state.restoreAfterPersist) {
    return {
      next: { ...state, restoreAfterPersist: false },
      effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }],
    };
  }
  if (state.kind === "reconciling" && state.reapplyAfterPersist) {
    return {
      next: { ...state, reapplyAfterPersist: false },
      effects: [{ kind: "beginReapply" }],
    };
  }
  return { next: state, effects: NO_LOCKDOWN_EFFECTS };
}

/**
 * 本轮 intent 确定无法写入 SQLite：一律按故障安全策略放弃或解除私密模式并恢复群权限。
 * 提交未派发时撤销占位；可能在途或已生效的权限限制立即发起恢复，不再等待落盘回执。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 状态落盘失败通知事件。
 * @returns 执行故障安全撤销或立即恢复群权限的状态转移结果。
 */
export function handlePersistFailed(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "persistFailed" }>
): LockdownTransition {
  if (state?.kind !== event.phase) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (state.kind === "applying") {
    if (state.stage !== "prepared" || state.intentId !== event.intentId) {
      return { next: state, effects: NO_LOCKDOWN_EFFECTS };
    }
    if (!state.commitStarted) {
      return {
        next: undefined,
        effects: [
          { kind: "reportUnlock" },
          ...announcementCleanupEffects(state),
          suppressRetrigger("persistFailed"),
        ],
      };
    }
  }
  if (state.intentId !== event.intentId) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (state.kind === "restoring") {
    // 本来就等着落盘回执去恢复：回执永远不会来了，直接恢复。
    if (!state.restoreAfterPersist) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
    return {
      next: { ...state, restoreAfterPersist: false },
      effects: [
        { kind: "beginRestore", originalPermissions: state.originalPermissions },
        suppressRetrigger("persistFailed"),
      ],
    };
  }
  // 已派发的提交可能在途；恢复沿同一 API 串行链排在提交后面。
  return {
    next: {
      kind: "restoring",
      originalPermissions: state.originalPermissions,
      intentId: state.intentId,
      restoreAfterPersist: false,
      restoreReason: "lifted",
      ...announcementOf(state),
    },
    effects: [
      { kind: "persistState" },
      { kind: "beginRestore", originalPermissions: state.originalPermissions },
      suppressRetrigger("persistFailed"),
    ],
  };
}
