import { NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import { isPersistable } from "./shared";
import type {
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/**
 * 封锁公告的发送结果；未激活或当前不等待公告结果时无操作。轮次已结束时的公告由解释器
 * （workers/antiRaid/lockdownApi.ts）沿串行链直接删除，不派发本事件。
 * @param state 当前群聊的私密模式状态，未激活时为 undefined。
 * @param event 封锁公告发送结果事件。
 * @returns 记录公告消息 ID 并按需持久化，或保持无操作的状态转移结果。
 */
export function handleAnnouncementResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "announcementResult" }>
): LockdownTransition {
  if (!state?.announcementPending) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (event.messageId === undefined) return { next: { ...state, announcementPending: false }, effects: NO_LOCKDOWN_EFFECTS };
  const next: LockdownState = {
    ...state,
    announced: true,
    announcementPending: false,
    announcementMessageId: event.messageId,
  };
  return { next, effects: isPersistable(next) ? [{ kind: "persistState" }] : NO_LOCKDOWN_EFFECTS };
}
