import {
  CHANNEL_COMMENT_JOIN_EXEMPTION,
  IDENTITY_JOIN_EXEMPTION,
  KICKED_REJOIN_GRACE_MS,
  NO_JOIN_EXEMPTION,
  NO_VERIFICATION_EFFECTS,
  VERIFICATION_TIMEOUT_MS,
} from "../../consts/antiRaid/verification";
import type {
  JoinEvent,
  JoinExemption,
  PendingState,
  VerificationEffect,
  VerificationExpelState,
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import { exemptOf, kickPendingOf, pendingUpdated, remindersOf } from "./shared";

/**
 * 汇总一次入群的全部豁免来源。关联频道评论区的直属评论和楼中楼回复均视为
 * 已参与讨论，不计入刷群统计。
 * @param event 入群事件载荷。
 * @returns 汇总后的入群豁免判定结果。
 */
function resolveJoinExemption(event: JoinEvent): JoinExemption {
  if (event.identityExempt || event.actorSyncExempt) return IDENTITY_JOIN_EXEMPTION;
  if (event.recentComment !== undefined) return CHANNEL_COMMENT_JOIN_EXEMPTION;
  return NO_JOIN_EXEMPTION;
}

/**
 * 判断本次投递是否为秒踢记录之后的真正重新入群：距记录时刻超过 KICKED_REJOIN_GRACE_MS，
 * 且不是携带同一条入群公告的重复投递（同号公告恒属同一次物理入群）。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 入群事件载荷。
 * @returns 属于超出双路投递误差的重新入群时返回 true，否则返回 false。
 */
function isKickRejoin(
  state: VerificationState | undefined,
  event: JoinEvent
): boolean {
  if (state?.kind === "kickPending") {
    return event.now - state.requestedAt > KICKED_REJOIN_GRACE_MS &&
      (event.announcementMessageId === undefined ||
        state.announcementMessageId !== event.announcementMessageId);
  }
  return state?.kind === "kicked" && event.now - state.kickedAt > KICKED_REJOIN_GRACE_MS;
}

/**
 * 判定本次入群是否新建验证记录并计入刷群统计；秒踢记录之后的重新入群与无记录同等计入。
 * 调用方先据此决定是否调用 recordJoin，再读取 lockdownActive 并分派转移。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 入群事件载荷。
 * @returns 需要新建验证记录并计入入群速率时返回 true，否则返回 false。
 */
export function joinCreatesNewRecord(
  state: VerificationState | undefined,
  event: JoinEvent
): boolean {
  return (
    state === undefined ||
    state.kind === "checkingInviter" ||
    state.kind === "expelling" ||
    isKickRejoin(state, event)
  ) && !resolveJoinExemption(event).exempt;
}

/** 除处置终态外、可被一次入群直接改写的记录状态（含尚未结算的秒踢）。 */
type JoinableState = Exclude<VerificationState, VerificationExpelState>;

/**
 * 处理豁免成立的入群：保留已有豁免占位或已完成的踢人；将未发出的秒踢替换为豁免占位并撤回
 * 已计入的入群计数；对已开的验证窗口撤销计数并删提醒；关联频道评论入群另发欢迎消息。
 * @param state 当前成员的可入群改写状态，未记录时为 undefined。
 * @param event 入群事件载荷。
 * @param viaChannelComment 豁免是否来自关联频道评论区活动。
 * @returns 豁免后的状态转移结果及相应清理、撤回计数或欢迎副作用。
 */
function joinExempt(
  state: JoinableState | undefined,
  event: JoinEvent,
  viaChannelComment: boolean
): VerificationTransition {
  if (state?.kind === "exempt") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  if (state?.kind === "kickPending") {
    if (state.executionStarted === true) {
      return {
        next: state,
        effects: [{ kind: "logUncancelableKickExemption", label: event.label }],
      };
    }
    return {
      next: exemptOf(event.label, event.isBot),
      effects: state.countedJoinAt === undefined
        ? []
        : [{ kind: "retractJoinCount", joinedAt: state.countedJoinAt }],
    };
  }
  if (state?.kind === "kicked") {
    return {
      next: state,
      effects: [{ kind: "logUncancelableKickExemption", label: event.label }],
    };
  }
  const effects: VerificationEffect[] = [];
  if (state !== undefined) {
    effects.push(remindersOf(state));
    effects.push({ kind: "retractJoinCount", joinedAt: state.joinedAt });
  }
  if (viaChannelComment && event.recentComment !== undefined) {
    effects.push({
      kind: "sendWelcome",
      variant: "channelComment",
      targetLabel: event.label,
      anchorMessageId: event.recentComment.messageId,
    });
  }
  return { next: exemptOf(event.label, event.isBot), effects };
}

/**
 * 处理已有记录时到达的补充投递：补齐公告与拉人者，不重置计时器、不重发提醒。
 * 秒踢记录之后的重新入群（见 isKickRejoin）按新一次入群交给 joinCreate，并删除尚未进入
 * 踢人动作的旧记录所持公告。
 * @param state 当前成员已有的可入群改写状态。
 * @param event 入群事件载荷。
 * @param invitedByOther 是否由其他成员邀请入群。
 * @returns 补充投递更新后或重新入群重建后的状态转移结果。
 */
function joinDuplicateDelivery(
  state: JoinableState,
  event: JoinEvent,
  invitedByOther: boolean
): VerificationTransition {
  if (isKickRejoin(state, event)) {
    const created: VerificationTransition = joinCreate(event, invitedByOther);
    if (
      state.kind !== "kickPending" ||
      state.effectStarted ||
      state.announcementMessageId === undefined
    ) return created;
    return {
      ...created,
      effects: [{ kind: "deleteMessage", messageId: state.announcementMessageId }, ...created.effects],
    };
  }
  const effects: VerificationEffect[] = [];
  let snapshotChanged: boolean = false;
  if (event.announcementMessageId !== undefined) {
    if (
      state.kind === "kicked" ||
      (state.kind === "kickPending" &&
        state.announcementMessageId !== event.announcementMessageId)
    ) {
      effects.push({ kind: "deleteMessage", messageId: event.announcementMessageId });
    } else if (state.kind === "pending" && state.announcementMessageId === undefined) {
      state.announcementMessageId = event.announcementMessageId;
      snapshotChanged = true;
    } else if (
      state.kind === "pending" &&
      state.announcementMessageId !== event.announcementMessageId
    ) {
      effects.push({ kind: "deleteMessage", messageId: event.announcementMessageId });
    }
  }
  if (state.kind === "pending" && invitedByOther) {
    if (state.invitedBy === undefined) {
      state.invitedBy = event.actorId;
      snapshotChanged = true;
    }
    if (!event.adminCacheFresh) {
      effects.push({ kind: "startAdminCheck", actorId: event.actorId! });
    }
  }
  if (state.kind === "pending" && snapshotChanged) return pendingUpdated(state, effects);
  return { next: state, effects };
}

/**
 * 处理新一次物理入群：私密模式期间进入 kickPending，否则开启验证窗口并发送提醒。
 * @param event 入群事件载荷。
 * @param invitedByOther 是否由其他成员邀请入群。
 * @returns 新建的 kickPending 或 pending 状态转移结果。
 */
function joinCreate(event: JoinEvent, invitedByOther: boolean): VerificationTransition {
  if (event.lockdownActive) {
    return {
      next: kickPendingOf({
        label: event.label,
        isBot: event.isBot,
        requestedAt: event.now,
        countedJoinAt: event.now,
        announcementMessageId: event.announcementMessageId,
      }),
      effects: NO_VERIFICATION_EFFECTS,
    };
  }
  const pending: PendingState = {
    kind: "pending",
    label: event.label,
    isBot: event.isBot,
    announcementMessageId: event.announcementMessageId,
    trackedMessageTimes: [],
    invitedBy: invitedByOther ? event.actorId : undefined,
    reminderMessageId: undefined,
    replyReminderMessageId: undefined,
    replyReminderRequested: false,
    welcomeAnchorMessageId: undefined,
    reminderSuperseded: false,
    joinedAt: event.now,
    expiresAt: event.now + VERIFICATION_TIMEOUT_MS,
  };
  const effects: VerificationEffect[] = [];
  if (invitedByOther && !event.adminCacheFresh) {
    effects.push({ kind: "startAdminCheck", actorId: event.actorId! });
  }
  effects.push({ kind: "sendReminder", label: event.label, isBot: event.isBot });
  return { next: pending, effects };
}

/**
 * 处理入群投递、豁免、私密模式秒踢及验证窗口创建。对象同一性作为解释器的执行 token：
 * 同一次入群的补充投递原地修改记录；豁免替换秒踢、重新入群与替换终态时返回新状态对象，
 * 使在途旧副作用在同一性复核时失效。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 入群事件载荷。
 * @returns 入群事件处理后的状态转移结果。
 */
export function handleJoin(
  state: VerificationState | undefined,
  event: JoinEvent
): VerificationTransition {
  if (state?.kind === "checkingInviter" || state?.kind === "expelling") {
    const replaced: VerificationTransition = handleJoin(undefined, event);
    return {
      ...replaced,
      effects: [remindersOf(state.snapshot), ...replaced.effects],
    };
  }
  const { exempt, viaChannelComment }: JoinExemption = resolveJoinExemption(event);
  const invitedByOther: boolean = event.actorId !== undefined && event.actorId !== event.memberId;
  if (exempt) return joinExempt(state, event, viaChannelComment);
  if (state !== undefined) return joinDuplicateDelivery(state, event, invitedByOther);
  return joinCreate(event, invitedByOther);
}

/**
 * 处理成员离群：pending 状态清除记录并删除带按钮的验证提醒；checkingInviter / expelling
 * 终态保留至处置结算事件到达（见 verificationRuntime.ts 的 dispatchVerification）；
 * 其余状态清除记录。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns 离群事件处理后的状态转移结果。
 */
export function handleLeft(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "pending") {
    return { next: undefined, effects: [remindersOf(state)] };
  }
  if (state?.kind === "checkingInviter" || state?.kind === "expelling") {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  return { next: undefined, effects: NO_VERIFICATION_EFFECTS };
}
