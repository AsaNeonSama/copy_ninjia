import { ANTI_RAID_PER_MINUTE_LIMIT, JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import {
  NO_VERIFICATION_EFFECTS,
  VERIFICATION_REMINDER_UNDELIVERED_MAX_MS,
  VERIFICATION_TIMEOUT_MS,
} from "../../consts/antiRaid/verification";
import { trimSlidingWindowArrayInPlace } from "../../libs/slidingWindowRateLimit";
import type {
  ConfirmedThreadCommentEvent,
  ExpelSnapshot,
  ReminderLandedEvent,
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
  remindersOf,
  snapshotOf,
} from "./shared";

/** 处理待验证成员发言、评论区豁免与刷屏终态切换。 */
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
    targetMessageId: event.messageId,
  }];
  if (state.reminderMessageId !== undefined) {
    effects.push({ kind: "deleteMessage", messageId: state.reminderMessageId });
    state.reminderMessageId = undefined;
  }
  return pendingUpdated(state, effects);
}

/** 处理冷缓存核查返回的权威评论区确认。 */
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

/**
 * 计算「通过」按钮的驳回理由；返回 undefined 表示放行。
 */
function approveDenial(
  event: VerificationCallbackEvent
): "useSelfButton" | "notApprover" | "approverUnknown" | undefined {
  if (event.isSelf) return "useSelfButton";
  if (event.fromCanApprove === undefined) return "approverUnknown";
  return event.fromCanApprove ? undefined : "notApprover";
}

/**
 * 处理验证按钮回调：本人验证仅接受待验证真人本人，「通过」仅接受群管理员代点；
 * 记录非 pending 时应答失效。
 */
export function handleCallback(
  state: VerificationState | undefined,
  event: VerificationCallbackEvent
): VerificationTransition {
  if (state?.kind !== "pending") {
    return {
      next: state,
      effects: [{ kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: "invalid" }],
    };
  }

  const denial: "notYourButton" | "useSelfButton" | "notApprover" | "approverUnknown" | undefined =
    event.action === "self"
      ? (event.isSelf ? undefined : "notYourButton")
      : approveDenial(event);
  if (denial !== undefined) {
    return {
      next: state,
      effects: [{ kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: denial }],
    };
  }

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

/** 处理验证到期：提醒尚未送达且在重试窗口内时续期重发，否则进入处置终态。 */
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
    const anchorMessageId: number | undefined = state.welcomeAnchorMessageId;
    const effects: VerificationEffect[] = anchorMessageId !== undefined
      ? [{
        kind: "sendReplyReminder",
        label: state.label,
        targetMessageId: anchorMessageId,
      }]
      : [{ kind: "sendReminder", label: state.label, isBot: state.isBot }];
    return pendingUpdated(state, effects, true);
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

/** 回填已落地的提醒消息 ID，并重置验证到期时间。 */
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
