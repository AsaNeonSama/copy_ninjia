import { verificationGeneration } from
  "../../cache/workers/antiRaid/verification";
import type {
  VerificationSnapshot,
  PendingVerificationSnapshot,
} from "../../types/antiRaid/verification";
import type {
  ExpelSnapshot,
  PendingState,
  VerificationState,
  VerificationTerminalState,
} from "../../types/states/verification";
import { isTerminalVerificationPhase } from "../../states/verification/shared";

/** 需要跨 Worker 重建持久化的验证阶段。 */
type PersistedVerificationState = PendingState | VerificationTerminalState;

/**
 * 当前状态是否拥有持久化快照。
 * @param state 待判定的验证状态。
 * @returns 为 `pending` 或终态阶段时返回 true，否则返回 false。
 */
export function isPersistedVerificationState(
  state: VerificationState | undefined
): state is PersistedVerificationState {
  return state?.kind === "pending" || isTerminalVerificationPhase(state?.kind);
}

interface VerificationSnapshotParams {
  /** 群组 ID。 */
  chatId: number;
  /** 成员 ID。 */
  userId: number;
  /** 需投影的持久化验证阶段状态。 */
  state: PersistedVerificationState;
  /** 本次发布的修订号。 */
  revision: number;
}

/**
 * 将当前持久化阶段投影成跨线程严格快照。快照只交给随即的 postMessage（结构化克隆同步完成后即丢弃），
 * 因此 trackedMessageTimes 直接引用状态里的数组，不复制；调用方不得留存返回值。
 *
 * 各阶段共有的字段只在 `base` 里列一次；非 pending 阶段一律 `...base` 展开后只覆盖 `phase`
 * 与本阶段专有字段。不得按阶段改写成各自完整列出共有字段的对象字面量：共有字段多为可选，
 * 某个阶段漏写时类型检查不报错，该阶段的快照会静默缺字段。
 * @param params 验证快照投影参数。
 * @returns 供跨线程传输的验证持久化快照对象。
 */
export function verificationSnapshot({
  chatId,
  userId,
  state,
  revision,
}: VerificationSnapshotParams): VerificationSnapshot {
  // kickPending 自带身份与入群时刻；其余阶段取 pending 本身或终态冻结的语义快照。
  let label: string;
  let isBot: boolean;
  let announcementMessageId: number | undefined;
  let reminderMessageId: number | undefined;
  let replyReminderMessageId: number | undefined;
  let joinedAt: number;
  let expiresAt: number;
  if (state.kind === "kickPending") {
    label = state.label;
    isBot = state.isBot;
    announcementMessageId = state.announcementMessageId;
    reminderMessageId = undefined;
    replyReminderMessageId = undefined;
    joinedAt = state.requestedAt;
    expiresAt = state.requestedAt;
  } else {
    const source: PendingState | ExpelSnapshot = state.kind === "pending" ? state : state.snapshot;
    label = source.label;
    isBot = source.isBot;
    announcementMessageId = source.announcementMessageId;
    reminderMessageId = source.reminderMessageId;
    replyReminderMessageId = source.replyReminderMessageId;
    joinedAt = source.joinedAt;
    expiresAt = source.expiresAt;
  }
  const base: PendingVerificationSnapshot = {
    chatId,
    userId,
    generation: verificationGeneration.current,
    revision,
    label,
    isBot,
    announcementMessageId,
    trackedMessageTimes:
      state.kind === "pending" ? state.trackedMessageTimes : [],
    invitedBy: state.kind === "pending" ? state.invitedBy : undefined,
    reminderMessageId,
    replyReminderMessageId,
    replyReminderRequested:
      state.kind === "pending" ? state.replyReminderRequested : false,
    welcomeAnchorMessageId:
      state.kind === "pending" ? state.welcomeAnchorMessageId : undefined,
    reminderSuperseded:
      state.kind === "pending" ? state.reminderSuperseded : true,
    joinedAt,
    expiresAt,
    phase: "pending",
  };
  if (state.kind === "pending") return base;
  if (state.kind === "kickPending") {
    return {
      ...base,
      phase: "kickPending",
      requestedAt: state.requestedAt,
      countedJoinAt: state.countedJoinAt,
    };
  }
  if (state.kind === "checkingInviter") {
    return {
      ...base,
      phase: "checkingInviter",
      terminalInviterId: state.inviterId,
    };
  }
  return {
    ...base,
    phase: "expelling",
    expelReason: state.reason,
    successNoticeSent: state.successNoticeSent,
    failureNoticeSent: state.failureNoticeSent,
    unconfirmedNoticeSent: state.unconfirmedNoticeSent,
    removalConfirmed: state.removalConfirmed,
  };
}
