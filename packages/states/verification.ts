import type {
  VerificationEvent,
  VerificationState,
  VerificationTransition,
} from "../types/states/verification";
import { handleGuardDisabled } from "./verification/disable";
import { handleJoin, handleLeft, joinCreatesNewRecord } from "./verification/join";
import {
  handleAdminCheckResolved,
  handleCallback,
  handleConfirmedThreadComment,
  handleReminderLanded,
  handleTrackedMessage,
  handleVerifyTimeout,
} from "./verification/pending";
import {
  handleDedupeExpired,
  handleExpelNoticeSent,
  handleExpelSettled,
  handleRemovalConfirmed,
  handleKickRequest,
  handleKickRetry,
  handleKickSettled,
  handleTerminalAttemptBudgetExhausted,
  handleTerminalAttemptUnsettled,
  handleTerminalPersisted,
  handleTimeoutInviterVerdict,
} from "./verification/terminal";

export { joinCreatesNewRecord };
/** 落盘快照 → 内存状态的纯转换；解释器只负责计时器与补投。 */
export { adoptVerificationState } from "./verification/adopt";

/**
 * 入群验证生命周期的显式状态机入口（纯逻辑，不做 I/O、不持有计时器）。
 * 各领域转移位于同名目录；本文件保留完整事件路由，穷尽路由全部事件。
 *
 * 状态图（ABSENT = Map 里没有这个 key）：
 *
 *   ABSENT ──身份豁免/非匿名管理员拉人（缓存命中）/评论区活动──> EXEMPT
 *   ABSENT ──私密模式期间入群──────────────────────────> KICK_PENDING
 *   KICK_PENDING ──踢人请求结算────────────────────────────> KICKED
 *   KICK_PENDING ──请求发出前收到权威豁免──────────────────> EXEMPT
 *   ABSENT ──普通入群──────────────────────────────────────> PENDING
 *   PENDING ──评论区活动 / 异步管理员核查通过────────────────> EXEMPT
 *   PENDING ──验证按钮通过 / 中途离群────────────────────────> ABSENT
 *   PENDING ──超时/刷屏──> CHECKING_INVITER / EXPELLING（落盘后执行）
 *   CHECKING_INVITER ──管理员──> EXEMPT；非管理员──> EXPELLING
 *   EXPELLING ──处置完成──────────────────────────────────────> ABSENT
 *   EXPELLING（flood 且未开始执行）──权威评论区确认──────────> EXEMPT
 *   CHECKING_INVITER/EXPELLING ──新一次物理入群──> 按 ABSENT 重新判定
 *   KICK_PENDING/KICKED ──超出双路投递误差的重进──> KICK_PENDING / PENDING（新 token，按当前是否私密模式）
 *   KICK_PENDING ──离群────────────────────────────────────────> ABSENT
 *   EXEMPT/KICKED ──去重窗口到期 / 离群────────────────────> ABSENT
 *   任意状态 ──主动关闭守卫（guardDisabled）────────────> ABSENT（清理机器人验证按钮）
 *
 * 同 kind 字段更新原地修改并原样返回；kind 变化才返回新对象。对象同一性既
 * 驱动计时器管理，也是异步结果的失效 token，领域 handler 不得随意复制状态。
 * 终态的 Worker 本地执行门（effectStarted / executionStarted）同样只经这里的转移改写：
 * 解释器以 kickRequestSent、kickRequestFailed、terminalAttemptUnsettled 带上发起尝试时的
 * 状态对象回投，状态已换代时转移不生效。
 * @param state 当前成员的验证状态，未记录（ABSENT）时为 undefined。
 * @param event 驱动状态机转移的验证事件。
 * @returns 转移后的下一状态、待执行副作用及持久化/计时器标志。
 */
export function transitionVerification(
  state: VerificationState | undefined,
  event: VerificationEvent
): VerificationTransition {
  switch (event.type) {
    case "join":
      return handleJoin(state, event);
    case "left":
      return handleLeft(state);
    case "trackedMessage":
      return handleTrackedMessage(state, event);
    case "confirmedThreadComment":
      return handleConfirmedThreadComment(state, event);
    case "callback":
      return handleCallback(state, event);
    case "guardDisabled":
      return handleGuardDisabled(state);
    case "adminCheckResolved":
      return handleAdminCheckResolved(state);
    case "verifyTimeout":
      return handleVerifyTimeout(state, event);
    case "terminalPersisted":
      return handleTerminalPersisted(state);
    case "terminalAttemptBudgetExhausted":
      return handleTerminalAttemptBudgetExhausted(state);
    case "timeoutInviterVerdict":
      return handleTimeoutInviterVerdict(state, event);
    case "expelSettled":
      return handleExpelSettled(state);
    case "expelNoticeSent":
      return handleExpelNoticeSent(state, event.notice);
    case "removalConfirmed":
      return handleRemovalConfirmed(state);
    case "kickRetry":
      return handleKickRetry(state);
    case "kickRequestSent":
    case "kickRequestFailed":
      return handleKickRequest(state, event);
    case "terminalAttemptUnsettled":
      return handleTerminalAttemptUnsettled(state, event.attemptState);
    case "kickSettled":
      return handleKickSettled(state, event.now);
    case "reminderLanded":
      return handleReminderLanded(state, event);
    case "dedupeExpired":
      return handleDedupeExpired(state);
  }
}
