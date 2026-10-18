import { LOCKDOWN_MS, NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
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

/** 入群数越过反刷群阈值：首次同步占位并发公告，已在轮内只预热管理员表。 */
export function handleThresholdExceeded(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "thresholdExceeded" }>
): LockdownTransition {
  if (state === undefined) {
    return {
      next: {
        kind: "applying",
        stage: "preparing",
        announced: false,
        announcementPending: true,
        announcementMessageId: undefined,
      },
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

/** 原权限读取完成：形成本轮 intent 并落盘，落盘回执才允许改 Telegram。 */
export function handleApplyPrepared(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "applyPrepared" }>
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "preparing") {
    return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  }
  return {
    next: {
      kind: "applying",
      stage: "prepared",
      originalPermissions: event.originalPermissions,
      intentId: event.intentId,
      commitStarted: false,
      ...announcementOf(state),
    },
    effects: [{ kind: "persistState" }],
  };
}

/** 读原权限失败：从未形成 intent、也从未改过 Telegram，撤销占位并清理已发出的公告。 */
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

/** intent 已落盘但提交前置失败：删除 owner 并清理公告，不走恢复路径。 */
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

/** setChatPermissions 结果：成功进 ACTIVE 并设定恢复延迟，失败转入 RESTORING 恢复对账。 */
export function handleApplyResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "applyResult" }>
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "prepared") {
    return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  }
  if (!event.ok) {
    return {
      next: {
        kind: "restoring",
        originalPermissions: state.originalPermissions,
        intentId: event.restoreIntentId,
        restoreAfterPersist: true,
        restoreReason: "lifted",
        ...announcementOf(state),
      },
      effects: [{ kind: "persistState" }],
    };
  }
  return {
    next: {
      kind: "active",
      originalPermissions: state.originalPermissions,
      intentId: state.intentId,
      ...announcementOf(state),
    },
    effects: [
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
    ],
  };
}
