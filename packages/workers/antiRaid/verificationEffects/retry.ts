import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import {
  VERIFICATION_TERMINAL_RETRY_MAX_MS,
  VERIFICATION_TERMINAL_RETRY_MS,
} from "../../../consts/antiRaid/verification";
import { cappedExponentialMs } from "../../../libs/backoff";
import { verificationKey } from "../../../libs/verificationKey";
import type { VerificationDispatcher, VerificationEntry } from "../../../types/antiRaid/internal";
import type { VerificationEvent, VerificationTerminalState } from "../../../types/states/verification";

export interface RetryTerminalAttemptParams {
  chatId: number;
  userId: number;
  /** 发起这一轮尝试时捕获的执行 token；条目已换成别的状态对象时什么也不做。 */
  state: VerificationTerminalState;
  dispatchVerification: VerificationDispatcher;
}

/**
 * 终态动作（私密模式踢人、拉人者终核、处置）这一轮没有结算时的收尾：先投递
 * terminalAttemptUnsettled，由状态机复位 Worker 本地执行门，让权威豁免可以替换 token；
 * 再清掉条目上的旧计时器，按 terminalRetries 算出第几次有上限的指数退避并加一，到点投递
 * kickRetry（kickPending）或 terminalPersisted（checkingInviter、expelling）。
 * 条目已换成别的状态对象时什么也不做；到点时条目、状态或计时器任一已换也不投递。
 */
export function retryTerminalAttempt({
  chatId,
  userId,
  state,
  dispatchVerification,
}: RetryTerminalAttemptParams): void {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  if (entry?.state !== state) return;
  dispatchVerification(chatId, userId, { type: "terminalAttemptUnsettled", attemptState: state });
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  const delayMs: number = cappedExponentialMs(
    VERIFICATION_TERMINAL_RETRY_MS,
    entry.terminalRetries,
    VERIFICATION_TERMINAL_RETRY_MAX_MS
  );
  entry.terminalRetries += 1;
  const event: Extract<VerificationEvent, { type: "kickRetry" | "terminalPersisted" }> =
    state.kind === "kickPending" ? { type: "kickRetry" } : { type: "terminalPersisted" };
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    if (
      verificationEntries.get(key) !== entry ||
      entry.state !== state ||
      entry.timer !== timer
    ) return;
    entry.timer = undefined;
    dispatchVerification(chatId, userId, event);
  }, delayMs);
  entry.timer = timer;
  timer.unref();
}
