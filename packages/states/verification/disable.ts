import { NO_VERIFICATION_EFFECTS } from "../../consts/antiRaid/verification";
import type {
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import { remindersOf } from "./shared";

/**
 * `/antiraid disable` 关闭入群守卫时，将单个成员的验证记录收敛回 ABSENT，
 * 并对 pending、checkingInviter、expelling 发出删除验证提醒的副作用。
 * 解释器随后为已落盘记录发布 tombstone（见 verificationRuntime.ts 的 dispatchVerification）。
 * @param state 当前成员的验证状态，未记录时为 undefined。
 * @returns 收敛至 undefined 的状态转移结果及清理验证提醒副作用。
 */
export function handleGuardDisabled(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "pending") {
    return { next: undefined, effects: [remindersOf(state)] };
  }
  if (state?.kind === "checkingInviter" || state?.kind === "expelling") {
    return { next: undefined, effects: [remindersOf(state.snapshot)] };
  }
  return { next: undefined, effects: NO_VERIFICATION_EFFECTS };
}
