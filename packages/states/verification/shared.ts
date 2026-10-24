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
 * @param phase 待判定的状态阶段字面量或 undefined。
 * @returns 处于终态执行阶段时返回 true，否则返回 false。
 */
export function isTerminalVerificationPhase(
  phase: VerificationState["kind"] | VerificationSnapshot["phase"] | undefined
): boolean {
  return phase === "kickPending" ||
    phase === "checkingInviter" ||
    phase === "expelling";
}

/**
 * isTerminalVerificationPhase 的状态类型守卫，收窄为 VerificationTerminalState。
 * @param state 待判定的验证状态或 undefined。
 * @returns 状态属于 VerificationTerminalState 时返回 true，否则返回 false。
 */
export function isTerminalVerificationState(
  state: VerificationState | undefined
): state is VerificationTerminalState {
  return isTerminalVerificationPhase(state?.kind);
}

/**
 * 构造 exempt 去重占位状态。
 * @param label 成员显示标签。
 * @param isBot 成员是否为机器人账号。
 * @returns 豁免去重占位状态。
 */
export function exemptOf(label: string, isBot: boolean): ExemptState {
  return { kind: "exempt", label, isBot };
}

/** kickPendingOf 的入参；Worker 本地幂等标志在构造时固定初始化为 false。 */
export interface KickPendingParams {
  /** 成员显示标签。 */
  readonly label: string;
  /** 成员是否为机器人账号。 */
  readonly isBot: boolean;
  /** 发起踢人请求的时间戳（毫秒）。 */
  readonly requestedAt: number;
  /** 计入入群速率滑窗的时间戳（毫秒），未计入时为 undefined。 */
  readonly countedJoinAt: number | undefined;
  /** 入群系统消息 ID，无消息时为 undefined。 */
  readonly announcementMessageId: number | undefined;
}

/**
 * 构造 kickPending 终态；effectStarted 与 executionStarted 初始化为 false。
 * @param params 构造 kickPending 终态所需的成员与时间参数。
 * @returns 初始化完成的 KickPendingState。
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

/**
 * 构造私密模式踢人结算后的 kicked 去重占位状态。
 * @param label 成员显示标签。
 * @param isBot 成员是否为机器人账号。
 * @param kickedAt 踢人结算完成的时间戳（毫秒）。
 * @returns 踢出完成后的去重占位状态。
 */
export function kickedOf(label: string, isBot: boolean, kickedAt: number): KickedState {
  return { kind: "kicked", label, isBot, kickedAt };
}

/** 落盘快照携带的终态播报记账；新建终态时各项均为 undefined。 */
export interface PersistedExpelNotices {
  /** 移出失败告警是否已发送。 */
  readonly failureNoticeSent?: true;
  /** 移出结果未确认提示是否已发送。 */
  readonly unconfirmedNoticeSent?: true;
  /** 移出成功播报是否已发送。 */
  readonly successNoticeSent?: true;
  /** 成员移出状态是否已确认。 */
  readonly removalConfirmed?: true;
}

/**
 * 构造 checkingInviter 终态，executionStarted 初始化为 false。
 * @param inviterId 邀请该成员入群的用户 ID。
 * @param snapshot 终态处置所需的成员与消息快照。
 * @returns 初始化完成的 CheckingInviterState。
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
 * @param reason 触发驱逐处置的原因（timeout 或 flood）。
 * @param snapshot 终态处置所需的成员与消息快照。
 * @param persisted 落盘快照中已记录的播报与确认标志。
 * @returns 初始化完成的 ExpellingState。
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

/**
 * 提取终态处置所需的最小语义快照。
 * @param source 待验证状态或落盘快照数据。
 * @returns 供终态处置使用的 ExpelSnapshot。
 */
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
 * @param source 待验证记录或 flood 终态快照。
 * @param messageId 触发评论区豁免的消息 ID（作为欢迎消息锚点）。
 * @returns 包含 exempt 状态及清理、撤回计数、发送欢迎副作用的转移结果。
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

/**
 * 构造清理验证提醒消息的副作用。
 * @param source 持有原始提醒或回复提醒消息 ID 的状态或快照。
 * @returns deleteReminders 副作用对象。
 */
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
 * @param state 已原地更新的待验证状态。
 * @param effects 本次状态转移产出的副作用列表。
 * @param rescheduleTimer 是否需要重设验证超时计时器，默认 false。
 * @returns 携带 snapshotChanged（及可选 rescheduleTimer）的转移结果。
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
