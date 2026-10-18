import type {
  CheckingInviterState,
  ExemptState,
  ExpelSnapshot,
  ExpellingState,
  KickedState,
  KickPendingState,
  PendingState,
  VerificationEffect,
  VerificationState,
  VerificationTerminalState,
  VerificationTransition,
} from "../../types/states/verification";
import type { VerificationSnapshot } from "../../types/antiRaid/verification";

/**
 * 判定验证记录是否处于终态执行阶段（kickPending / checkingInviter / expelling）。
 * 状态机的 `kind` 与持久化快照的 `phase` 共用同一组字面量。
 */
export function isTerminalVerificationPhase(
  phase: VerificationState["kind"] | VerificationSnapshot["phase"] | undefined
): boolean {
  return phase === "kickPending" ||
    phase === "checkingInviter" ||
    phase === "expelling";
}

/** isTerminalVerificationPhase 的状态类型守卫，收窄为 VerificationTerminalState。 */
export function isTerminalVerificationState(
  state: VerificationState | undefined
): state is VerificationTerminalState {
  return isTerminalVerificationPhase(state?.kind);
}

/** 构造 exempt 去重占位状态。 */
export function exemptOf(label: string, isBot: boolean): ExemptState {
  return { kind: "exempt", label, isBot };
}

/** kickPendingOf 的入参；Worker 本地幂等标志在构造时固定初始化为 false。 */
export interface KickPendingParams {
  readonly label: string;
  readonly isBot: boolean;
  readonly requestedAt: number;
  readonly countedJoinAt: number | undefined;
  readonly announcementMessageId: number | undefined;
}

/**
 * 构造 kickPending 终态；effectStarted 与 executionStarted 初始化为 false。
 */
export function kickPendingOf({
  label,
  isBot,
  requestedAt,
  countedJoinAt,
  announcementMessageId,
}: KickPendingParams): KickPendingState {
  return {
    kind: "kickPending",
    label,
    isBot,
    requestedAt,
    countedJoinAt,
    announcementMessageId,
    effectStarted: false,
    executionStarted: false,
  };
}

/** 构造私密模式踢人结算后的 kicked 去重占位状态。 */
export function kickedOf(label: string, isBot: boolean, kickedAt: number): KickedState {
  return { kind: "kicked", label, isBot, kickedAt };
}

/** 落盘快照携带的终态播报记账；新建终态时各项均为 undefined。 */
export interface PersistedExpelNotices {
  readonly failureNoticeSent?: true;
  readonly unconfirmedNoticeSent?: true;
  readonly successNoticeSent?: true;
  readonly removalConfirmed?: true;
}

/**
 * 构造 checkingInviter 终态，executionStarted 初始化为 false。
 */
export function checkingInviterOf(
  inviterId: number,
  snapshot: ExpelSnapshot
): CheckingInviterState {
  return {
    kind: "checkingInviter",
    inviterId,
    snapshot,
    executionStarted: false,
  };
}

/**
 * 构造 expelling 终态；executionStarted 初始化为 false，播报记账从落盘快照恢复。
 */
export function expellingOf(
  reason: ExpellingState["reason"],
  snapshot: ExpelSnapshot,
  persisted?: PersistedExpelNotices
): ExpellingState {
  return {
    kind: "expelling",
    reason,
    snapshot,
    executionStarted: false,
    failureNoticeSent: persisted?.failureNoticeSent,
    unconfirmedNoticeSent: persisted?.unconfirmedNoticeSent,
    successNoticeSent: persisted?.successNoticeSent,
    removalConfirmed: persisted?.removalConfirmed,
  };
}

/** snapshotOf 的输入来源：内存中的待验证记录或落盘快照。 */
type ExpelSnapshotSource =
  Pick<ExpelSnapshot, "label" | "isBot" | "joinedAt" | "expiresAt"> &
  Partial<Pick<ExpelSnapshot, "announcementMessageId" | "reminderMessageId" | "replyReminderMessageId">>;

/** 提取终态处置所需的最小语义快照。 */
export function snapshotOf(source: ExpelSnapshotSource): ExpelSnapshot {
  return {
    label: source.label,
    isBot: source.isBot,
    announcementMessageId: source.announcementMessageId,
    reminderMessageId: source.reminderMessageId,
    replyReminderMessageId: source.replyReminderMessageId,
    joinedAt: source.joinedAt,
    expiresAt: source.expiresAt,
  };
}

/** 评论区豁免的来源：待验证记录或 flood 终态的快照。 */
type ChannelCommentSource =
  Pick<ExpelSnapshot, "label" | "isBot" | "joinedAt" | "reminderMessageId" | "replyReminderMessageId">;

/**
 * 构造频道评论区活动确证后的豁免转移：进入 exempt 占位，删除验证提醒、撤回入群计数，
 * 并以评论消息为锚发送欢迎消息。
 */
export function channelCommentExemption(
  source: ChannelCommentSource,
  messageId: number
): VerificationTransition {
  return {
    next: exemptOf(source.label, source.isBot),
    effects: [
      remindersOf(source),
      { kind: "retractJoinCount", joinedAt: source.joinedAt },
      {
        kind: "sendWelcome",
        variant: "channelComment",
        targetLabel: source.label,
        anchorMessageId: messageId,
      },
    ],
  };
}

/** 构造清理验证提醒消息的副作用。 */
export function remindersOf(
  source: Pick<PendingState, "reminderMessageId" | "replyReminderMessageId">
): VerificationEffect {
  return {
    kind: "deleteReminders",
    reminderMessageId: source.reminderMessageId,
    replyReminderMessageId: source.replyReminderMessageId,
  };
}

/**
 * 返回已原地修改的 pending 状态并标记 snapshotChanged，由调用方发布持久化快照。
 */
export function pendingUpdated(
  state: PendingState,
  effects: readonly VerificationEffect[],
  rescheduleTimer: boolean = false
): VerificationTransition {
  if (rescheduleTimer) {
    return {
      next: state,
      effects,
      snapshotChanged: true,
      rescheduleTimer: true,
    };
  }
  return { next: state, effects, snapshotChanged: true };
}
