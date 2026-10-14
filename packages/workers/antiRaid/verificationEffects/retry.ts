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
 * 终态动作本轮未结算时复位本地执行门，并按 `terminalRetries` 安排带上限的指数退避重试。
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
