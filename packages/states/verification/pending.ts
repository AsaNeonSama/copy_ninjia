import { ANTI_RAID_PER_MINUTE_LIMIT, JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import {
  NO_VERIFICATION_EFFECTS,
  VERIFICATION_REMINDER_UNDELIVERED_MAX_MS,
  VERIFICATION_TIMEOUT_MS,
} from "../../consts/antiRaid/verification";
import { trimSlidingWindowArrayInPlace } from "../../libs/slidingWindowRateLimit";
import type {
  ApproveCallbackEvent,
  ConfirmedThreadCommentEvent,
  ExpelSnapshot,
  PendingState,
  ReminderLandedEvent,
  SelfAnswerCallbackEvent,
  TrackedMessageEvent,
  VerificationCallbackEvent,
  VerificationEffect,
  VerificationState,
  VerificationTransition,
  VerifyTimeoutEvent,
} from "../../types/states/verification";
import {
  channelCommentExemption,
  checkingInviterOf,
  exemptOf,
  expellingOf,
  pendingUpdated,
  reminderResendOf,
  remindersOf,
  snapshotOf,
} from "./shared";

/**
 * 处理待验证成员发言、评论区豁免与刷屏终态切换。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 待验证成员发言事件载荷。
 * @returns 状态转移结果及所需的提醒、豁免或驱逐副作用。
 */
export function handleTrackedMessage(
  state: VerificationState | undefined,
  event: TrackedMessageEvent
): VerificationTransition {
  if (state?.kind !== "pending") return { next: state, effects: NO_VERIFICATION_EFFECTS };

  if (event.inCommentThread) return channelCommentExemption(state, event.messageId);

  trimSlidingWindowArrayInPlace(state.trackedMessageTimes, JOIN_WINDOW_MS, event.now);
  state.trackedMessageTimes.push(event.now);
  if (state.trackedMessageTimes.length > ANTI_RAID_PER_MINUTE_LIMIT) {
    return {
      next: expellingOf("flood", snapshotOf(state)),
      effects: NO_VERIFICATION_EFFECTS,
    };
  }
  if (state.replyReminderRequested) return pendingUpdated(state, NO_VERIFICATION_EFFECTS);
  state.replyReminderRequested = true;
  state.welcomeAnchorMessageId = event.messageId;
  state.reminderSuperseded = true;

  const effects: VerificationEffect[] = [{
    kind: "sendReplyReminder",
    label: state.label,
    isBot: state.isBot,
    targetMessageId: event.messageId,
  }];
  if (state.reminderMessageId !== undefined) {
    effects.push({ kind: "deleteMessage", messageId: state.reminderMessageId });
    state.reminderMessageId = undefined;
  }
  return pendingUpdated(state, effects);
}

/**
 * 处理冷缓存核查返回的权威评论区确认。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 权威评论区确认事件载荷。
 * @returns 状态转移结果；命中豁免条件时转入 exempt 并清理提醒。
 */
export function handleConfirmedThreadComment(
  state: VerificationState | undefined,
  event: ConfirmedThreadCommentEvent
): VerificationTransition {
  if (state?.kind === "pending") return channelCommentExemption(state, event.messageId);
  if (
    state?.kind !== "expelling" ||
    state.reason !== "flood" ||
    state.executionStarted === true ||
    !event.allowFloodTerminalExemption
  ) {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  return channelCommentExemption(state.snapshot, event.messageId);
}

/** 验证按钮回调的应答类型。 */
type CallbackReply = Extract<VerificationEffect, { kind: "answerCallback" }>["reply"];

/**
 * 只应答按钮、不改记录的转移。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param callbackQueryId Telegram 回调查询 ID。
 * @param reply 回调应答类型。
 * @returns 原样返回状态并携带单个 answerCallback 副作用的转移结果。
 */
function callbackReplied(
  state: VerificationState | undefined,
  callbackQueryId: string,
  reply: CallbackReply
): VerificationTransition {
  return { next: state, effects: [{ kind: "answerCallback", callbackQueryId, reply }] };
}

/**
 * 验证通过：应答按钮、删除提醒并发送欢迎语，记录随之删除。
 * @param state 当前待验证状态。
 * @param event 验证按钮回调事件载荷。
 * @returns 删除记录并携带应答、清理提醒与欢迎语副作用的转移结果。
 */
function callbackPassed(state: PendingState, event: VerificationCallbackEvent): VerificationTransition {
  return {
    next: undefined,
    effects: [
      { kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: "ok" },
      remindersOf(state),
      {
        kind: "sendWelcome",
        variant: event.action === "self"
          ? "verified"
          : state.isBot ? "vouchedBot" : "approved",
        targetLabel: state.label,
        fromLabel: event.fromLabel,
        anchorMessageId: state.welcomeAnchorMessageId,
      },
    ],
  };
}

/**
 * 「通过」按钮：本人点按提示改点作答按钮，身份未查清提示稍后再试，非管理员驳回，管理员代点放行。
 * @param state 当前待验证状态。
 * @param event 「通过」按钮回调事件载荷。
 * @returns 驳回时仅应答，放行时为验证通过的转移结果。
 */
function handleApproveCallback(state: PendingState, event: ApproveCallbackEvent): VerificationTransition {
  if (event.isSelf) return callbackReplied(state, event.callbackQueryId, "useSelfButton");
  if (event.fromCanApprove === undefined) return callbackReplied(state, event.callbackQueryId, "approverUnknown");
  if (!event.fromCanApprove) return callbackReplied(state, event.callbackQueryId, "notApprover");
  return callbackPassed(state, event);
}

/**
 * 本人作答按钮：只认本人在 pending 当前登记的提醒消息上作答。答对即通过；答错转入
 * expelling(wrongAnswer)，落盘回执后只踢不封；Worker 没有缓存题目（`missing`）时删除现有提醒、
 * 清空登记并按当前形态补发，补发时 Worker 生成新题。
 * @param state 当前待验证状态。
 * @param event 本人作答按钮回调事件载荷。
 * @returns 应答、通过、答错处置或换题补发的转移结果。
 */
function handleSelfAnswerCallback(state: PendingState, event: SelfAnswerCallbackEvent): VerificationTransition {
  if (!event.isSelf) return callbackReplied(state, event.callbackQueryId, "notYourButton");
  if (
    event.messageId === undefined ||
    (event.messageId !== state.reminderMessageId && event.messageId !== state.replyReminderMessageId)
  ) {
    return callbackReplied(state, event.callbackQueryId, "staleReminder");
  }
  switch (event.answerVerdict) {
    case "correct":
      return callbackPassed(state, event);
    case "wrong":
      return {
        next: expellingOf("wrongAnswer", snapshotOf(state)),
        effects: [{ kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: "wrongAnswer" }],
      };
    case "missing": {
      const effects: VerificationEffect[] = [
        { kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: "challengeRefreshed" },
        remindersOf(state),
        reminderResendOf(state),
      ];
      state.reminderMessageId = undefined;
      state.replyReminderMessageId = undefined;
      return pendingUpdated(state, effects);
    }
    default: {
      const unhandledVerdict: never = event.answerVerdict;
      throw new Error(`Unsupported verification answer verdict: ${String(unhandledVerdict)}`);
    }
  }
}

/**
 * 处理验证按钮回调：本人作答仅接受待验证真人本人，「通过」仅接受群管理员代点；
 * 记录非 pending 时应答失效。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 验证按钮回调事件载荷。
 * @returns 状态转移结果及回调应答、删除提醒、发送欢迎、答错处置或换题补发等副作用。
 */
export function handleCallback(
  state: VerificationState | undefined,
  event: VerificationCallbackEvent
): VerificationTransition {
  if (state?.kind !== "pending") return callbackReplied(state, event.callbackQueryId, "invalid");
  return event.action === "self"
    ? handleSelfAnswerCallback(state, event)
    : handleApproveCallback(state, event);
}

/**
 * 处理验证到期：提醒尚未送达且在重试窗口内时续期重发，否则进入处置终态。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 验证超时事件载荷。
 * @returns 续期重发提醒或进入 checkingInviter / expelling 终态的转移结果。
 */
export function handleVerifyTimeout(
  state: VerificationState | undefined,
  event: VerifyTimeoutEvent
): VerificationTransition {
  if (state?.kind !== "pending") return { next: state, effects: NO_VERIFICATION_EFFECTS };

  if (
    state.reminderMessageId === undefined &&
    state.replyReminderMessageId === undefined &&
    event.now - state.joinedAt < VERIFICATION_REMINDER_UNDELIVERED_MAX_MS
  ) {
    state.expiresAt = event.now + VERIFICATION_TIMEOUT_MS;
    return pendingUpdated(state, [reminderResendOf(state)], true);
  }

  const snapshot: ExpelSnapshot = snapshotOf(state);
  if (state.invitedBy !== undefined) {
    return {
      next: checkingInviterOf(state.invitedBy, snapshot),
      effects: NO_VERIFICATION_EFFECTS,
    };
  }
  return { next: expellingOf("timeout", snapshot), effects: NO_VERIFICATION_EFFECTS };
}

/**
 * 回填已落地的提醒消息 ID，并重置验证到期时间。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 提醒消息发送落地事件载荷。
 * @returns 状态转移结果；非 pending 或已被替代时返回删除该提醒消息的副作用。
 */
export function handleReminderLanded(
  state: VerificationState | undefined,
  event: ReminderLandedEvent
): VerificationTransition {
  if (state?.kind !== "pending") {
    return { next: state, effects: [{ kind: "deleteMessage", messageId: event.messageId }] };
  }
  if (event.reminderKind === "original" && state.reminderSuperseded) {
    return { next: state, effects: [{ kind: "deleteMessage", messageId: event.messageId }] };
  }
  if (event.reminderKind === "original") state.reminderMessageId = event.messageId;
  else state.replyReminderMessageId = event.messageId;
  state.expiresAt = event.now + VERIFICATION_TIMEOUT_MS;
  return pendingUpdated(state, NO_VERIFICATION_EFFECTS, true);
}

/**
 * 处理异步管理员核查返回的通过结论：仅对 pending 状态切换至 exempt，
 * 删除验证提醒并撤回入群滑动窗口计数。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns 状态转移结果；pending 时转入 exempt 并附带清理提醒与撤回计数副作用。
 */
export function handleAdminCheckResolved(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind !== "pending") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  return {
    next: exemptOf(state.label, state.isBot),
    effects: [
      remindersOf(state),
      { kind: "retractJoinCount", joinedAt: state.joinedAt },
    ],
  };
}
