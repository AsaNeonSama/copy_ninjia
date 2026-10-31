import { LOCKDOWN_MS, NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import {
  activeOf,
  announcementCleanupEffects,
  preparedOf,
  preparingOf,
  restoringOf,
  suppressRetrigger,
} from "./shared";
import type {
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/**
 * 入群数越过反刷群阈值：首次同步占位并发公告，已在轮内只预热管理员表。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 入群速率越过阈值事件。
 * @returns 首次进入 applying 准备阶段或维持现阶段并预热管理员缓存的转移结果。
 */
export function handleThresholdExceeded(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "thresholdExceeded" }>
): LockdownTransition {
  if (state === undefined) {
    return {
      next: preparingOf(),
      effects: [
        { kind: "prefetchAdmins", onlyIfCold: true },
        { kind: "beginLockdownAnnouncement", joinCount: event.joinCount },
        { kind: "prepareApply" },
      ],
    };
  }
  // 本轮状态与恢复意图保持不变，恢复成功后由 owner 清空入群窗口。
  // 生命周期约束见 docs/cn/04-invariants.md。
  return { next: state, effects: [{ kind: "prefetchAdmins", onlyIfCold: true }] };
}

/**
 * 原权限读取完成：形成本轮 intent 并落盘，落盘回执才允许改 Telegram。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 原权限读取完成事件。
 * @returns 进入 applying prepared 阶段并触发落盘的转移结果。
 */
export function handleApplyPrepared(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "applyPrepared" }>
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "preparing") {
    return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  }
  return {
    next: preparedOf({
      originalPermissions: event.originalPermissions,
      intentId: event.intentId,
      commitStarted: false,
      announcement: state,
    }),
    effects: [{ kind: "persistState" }],
  };
}

/**
 * 读原权限失败：从未形成 intent、也从未改过 Telegram，撤销占位并清理已发出的公告。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @returns 撤销 preparing 占位、清理公告并压制重触发的转移结果。
 */
export function handleApplyPreparationFailed(
  state: LockdownState | undefined
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "preparing") {
    return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  }
  return {
    next: undefined,
    effects: [...announcementCleanupEffects(state), suppressRetrigger("preparationFailed")],
  };
}

/**
 * intent 已落盘但提交前置失败：删除 owner 并清理公告，不走恢复路径。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @returns 撤销 prepared 状态、上报解锁、清理公告并压制重触发的转移结果。
 */
export function handleApplyCommitPreparationFailed(
  state: LockdownState | undefined
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "prepared") {
    return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  }
  return {
    next: undefined,
    effects: [
      { kind: "reportUnlock" },
      ...announcementCleanupEffects(state),
      suppressRetrigger("commitPreparationFailed"),
    ],
  };
}

/**
 * setChatPermissions 结果：成功进 ACTIVE 并设定恢复延迟，失败转入 RESTORING 恢复对账。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 收紧群权限调用结果事件。
 * @returns 进入 active 或转入 restoring 对账的转移结果。
 */
export function handleApplyResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "applyResult" }>
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "prepared") {
    return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  }
  if (!event.ok) {
    return {
      next: restoringOf({
        originalPermissions: state.originalPermissions,
        intentId: event.restoreIntentId,
        restoreAfterPersist: true,
        restoreReason: "lifted",
        announcement: state,
      }),
      effects: [{ kind: "persistState" }],
    };
  }
  return {
    next: activeOf(state.originalPermissions, state.intentId, state),
    effects: [
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
    ],
  };
}
