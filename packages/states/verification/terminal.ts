import { NO_VERIFICATION_EFFECTS } from "../../consts/antiRaid/verification";
import type {
  ExpelNoticeKind,
  KickRequestEvent,
  TimeoutInviterVerdictEvent,
  VerificationEffect,
  VerificationState,
  VerificationTerminalState,
  VerificationTransition,
} from "../../types/states/verification";
import { exemptOf, expellingOf, isTerminalVerificationPhase, kickedOf, remindersOf } from "./shared";

/**
 * 处理拉人者终核结果，管理员豁免，否则切换到可重放处置终态。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 拉人者管理员资格核查结论事件。
 * @returns 豁免转入 exempt 或转入 expelling 终态的转移结果。
 */
export function handleTimeoutInviterVerdict(
  state: VerificationState | undefined,
  event: TimeoutInviterVerdictEvent
): VerificationTransition {
  if (state?.kind !== "checkingInviter") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  if (!event.inviterIsAdmin) {
    return {
      next: expellingOf("timeout", state.snapshot),
      effects: NO_VERIFICATION_EFFECTS,
    };
  }
  const effects: VerificationEffect[] = [
    remindersOf(state.snapshot),
    { kind: "retractJoinCount", joinedAt: state.snapshot.joinedAt },
  ];
  return { next: exemptOf(state.snapshot.label, state.snapshot.isBot), effects };
}

/**
 * 落盘回执到达后打开终态本地执行门；成功播报已发出的 expelling 直接收尾清除，重复回执保持幂等。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns 附带踢人、复核拉人者、驱逐副作用或收尾清除的状态转移结果。
 */
export function handleTerminalPersisted(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "kickPending") {
    if (state.effectStarted === true) return { next: state, effects: NO_VERIFICATION_EFFECTS };
    state.effectStarted = true;
    const effects: VerificationEffect[] = [];
    if (state.announcementMessageId !== undefined) {
      effects.push({ kind: "deleteMessage", messageId: state.announcementMessageId });
    }
    effects.push({ kind: "kickMember" });
    return { next: state, effects };
  }
  if (state?.kind === "checkingInviter") {
    if (state.executionStarted === true) return { next: state, effects: NO_VERIFICATION_EFFECTS };
    state.executionStarted = true;
    return {
      next: state,
      effects: [{
        kind: "recheckInviter",
        inviterId: state.inviterId,
        snapshot: state.snapshot,
      }],
    };
  }
  if (state?.kind === "expelling") {
    if (state.successNoticeSent === true) return { next: undefined, effects: NO_VERIFICATION_EFFECTS };
    if (state.executionStarted === true) return { next: state, effects: NO_VERIFICATION_EFFECTS };
    state.executionStarted = true;
    return {
      next: state,
      effects: [{
        kind: state.reason === "flood" ? "expelFlood" : "expel",
        snapshot: state.snapshot,
      }],
    };
  }
  return { next: state, effects: NO_VERIFICATION_EFFECTS };
}

/**
 * 本进程执行预算耗尽或当前执行许可无法确认时卸载终态，保留最后一份磁盘快照。
 *
 * 该转移不表示处置成功：解释器据 retainPersistedSnapshot 跳过 tombstone，下一次
 * 完整进程启动仍从持久化记录恢复。非终态收到迟到事件时保持原状态。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns 终态时卸载内存状态并携带 retainPersistedSnapshot 的转移结果。
 */
export function handleTerminalAttemptBudgetExhausted(
  state: VerificationState | undefined
): VerificationTransition {
  if (!isTerminalVerificationPhase(state?.kind)) {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  return {
    next: undefined,
    effects: NO_VERIFICATION_EFFECTS,
    retainPersistedSnapshot: true,
  };
}

/**
 * 处置成功后只允许当前 expelling 终态退出。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns expelling 终态下收敛为 undefined 的转移结果。
 */
export function handleExpelSettled(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "expelling") return { next: undefined, effects: NO_VERIFICATION_EFFECTS };
  return { next: state, effects: NO_VERIFICATION_EFFECTS };
}

/**
 * 驱逐播报发出后置位对应标记；只作用于当前 expelling 终态，快照随之重发。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param notice 已发出的驱逐播报种类（success / failure / unconfirmed）。
 * @returns 更新播报标志并携带 snapshotChanged 的转移结果。
 */
export function handleExpelNoticeSent(
  state: VerificationState | undefined,
  notice: ExpelNoticeKind
): VerificationTransition {
  if (state?.kind !== "expelling") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  if (notice === "success") state.successNoticeSent = true;
  else if (notice === "failure") state.failureNoticeSent = true;
  else state.unconfirmedNoticeSent = true;
  return { next: state, effects: NO_VERIFICATION_EFFECTS, snapshotChanged: true };
}

/**
 * 踢人确认成功但成功播报没发出：记下 removalConfirmed；只作用于当前 expelling 终态，已记过时不重发快照。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns 首次确认移出时携带 snapshotChanged 的转移结果。
 */
export function handleRemovalConfirmed(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind !== "expelling" || state.removalConfirmed === true) {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  state.removalConfirmed = true;
  return { next: state, effects: NO_VERIFICATION_EFFECTS, snapshotChanged: true };
}

/**
 * 私密模式踢人失败后的重试只对尚未执行的原 token 生效。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns 满足重试条件时附带 kickMember 副作用的转移结果。
 */
export function handleKickRetry(
  state: VerificationState | undefined
): VerificationTransition {
  if (
    state?.kind !== "kickPending" ||
    state.executionStarted === true ||
    state.effectStarted === true
  ) {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  state.effectStarted = true;
  return { next: state, effects: [{ kind: "kickMember" }] };
}

/**
 * 私密模式踢人请求的执行门。kickRequestSent：请求即将同步发出，此后到达的豁免无法再撤销
 * 这次调用（见 ./join.ts 的 joinExempt）；kickRequestFailed：请求返回但没有结算，重新允许
 * 权威豁免替换 token，本轮尝试仍在进行，effectStarted 保持置位。只作用于发起这次踢人的那个状态对象。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param event 踢人请求发出或失败事件载荷。
 * @returns 更新 executionStarted 后的状态转移结果。
 */
export function handleKickRequest(
  state: VerificationState | undefined,
  event: KickRequestEvent
): VerificationTransition {
  if (state !== event.attemptState) return { next: state, effects: NO_VERIFICATION_EFFECTS };
  state.executionStarted = event.type === "kickRequestSent";
  return { next: state, effects: NO_VERIFICATION_EFFECTS };
}

/**
 * 本轮终态动作没有结算、解释器即将排一次退避重试：复位 Worker 本地执行门，让到点的
 * kickRetry / terminalPersisted 能重新发出动作，也让权威豁免可以替换 token。只作用于发起
 * 这一轮的那个状态对象；门不持久化，快照不变。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param attemptState 发起本轮终态尝试时的状态对象引用。
 * @returns 复位本地执行门后的状态转移结果。
 */
export function handleTerminalAttemptUnsettled(
  state: VerificationState | undefined,
  attemptState: VerificationTerminalState
): VerificationTransition {
  if (state !== attemptState) return { next: state, effects: NO_VERIFICATION_EFFECTS };
  if (state.kind === "kickPending") state.effectStarted = false;
  state.executionStarted = false;
  return { next: state, effects: NO_VERIFICATION_EFFECTS };
}

/**
 * 私密模式踢人请求结算后进入双路投递去重窗口。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @param now 踢人结算完成的时间戳（毫秒）。
 * @returns 从 kickPending 切换至 kicked 去重占位的状态转移结果。
 */
export function handleKickSettled(
  state: VerificationState | undefined,
  now: number
): VerificationTransition {
  if (state?.kind !== "kickPending") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  return { next: kickedOf(state.label, state.isBot, now), effects: NO_VERIFICATION_EFFECTS };
}

/**
 * 只清除短期去重占位，不影响真实验证或可恢复终态。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns exempt 或 kicked 状态下清除为 undefined 的状态转移结果。
 */
export function handleDedupeExpired(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "exempt" || state?.kind === "kicked") {
    return { next: undefined, effects: NO_VERIFICATION_EFFECTS };
  }
  return { next: state, effects: NO_VERIFICATION_EFFECTS };
}
