import { NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import type {
  LockdownAnnouncement,
  LockdownEffect,
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/**
 * 重启接管一条落盘下来的私密模式记录；已有内存状态时原样保留，不重复接管。
 * @param state 当前群聊的内存私密模式状态，未记录时为 undefined。
 * @param event 落盘记录接管事件载荷。
 * @returns 接管后的私密模式状态及恢复执行所需的副作用。
 */
export function handleAdopt(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "adopt" }>
): LockdownTransition {
  if (state !== undefined) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  // 接管方只认落盘下来的 announced 与 messageId：落盘记为未公告且锁定仍要继续时
  // 补一次公告；RESTORING 阶段不补公告。
  const announceOnAdopt: boolean = !event.announced && event.phase !== "restoring";
  const announcement: LockdownAnnouncement = {
    announced: event.announced,
    announcementPending: announceOnAdopt,
    announcementMessageId: event.announcementMessageId,
  };
  const announceEffects: LockdownEffect[] = announceOnAdopt
    ? [{ kind: "beginLockdownAnnouncement" }]
    : [];
  switch (event.phase) {
    case "applying":
      return {
        next: {
          kind: "applying",
          stage: "prepared",
          originalPermissions: event.originalPermissions,
          intentId: event.intentId,
          // persisted 时下面立刻发 commitApply，commitStarted 同步置位。
          commitStarted: event.persisted,
          ...announcement,
        },
        effects: [
          { kind: "prefetchAdmins", onlyIfCold: false },
          ...announceEffects,
          ...(!event.persisted
            ? []
            : [{ kind: "commitApply" } as const]),
        ],
      };
    case "restoring":
      return {
        next: {
          kind: "restoring",
          originalPermissions: event.originalPermissions,
          intentId: event.intentId,
          restoreAfterPersist: !event.persisted,
          restoreReason: "lifted",
          ...announcement,
        },
        effects: [
          { kind: "prefetchAdmins", onlyIfCold: false },
          ...(!event.persisted
            ? []
            : [{ kind: "beginRestore", originalPermissions: event.originalPermissions } as const]),
        ],
      };
    case "reconciling":
      return {
        next: {
          kind: "reconciling",
          originalPermissions: event.originalPermissions,
          intentId: event.intentId,
          reapplyAfterPersist: !event.persisted,
          ...announcement,
        },
        effects: [
          { kind: "prefetchAdmins", onlyIfCold: false },
          ...announceEffects,
          { kind: "scheduleRestore", delayMs: event.remainingMs },
          ...(!event.persisted
            ? []
            : [{ kind: "beginReapply" } as const]),
        ],
      };
    case "active":
      return {
        next: {
          kind: "active",
          originalPermissions: event.originalPermissions,
          intentId: event.intentId,
          ...announcement,
        },
        effects: [
          { kind: "prefetchAdmins", onlyIfCold: false },
          ...announceEffects,
          { kind: "scheduleRestore", delayMs: event.remainingMs },
        ],
      };
  }
}
