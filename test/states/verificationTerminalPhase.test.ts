import { describe, expect, test } from "bun:test";
import {
  checkingInviterOf,
  exemptOf,
  expellingOf,
  isTerminalVerificationPhase,
  isTerminalVerificationState,
  kickedOf,
  kickPendingOf,
} from "../../packages/states/verification/shared";
import type { ExpelSnapshot, VerificationState } from "../../packages/types/states/verification";

const SNAPSHOT: ExpelSnapshot = {
  label: "杂鱼A",
  isBot: false,
  announcementMessageId: undefined,
  reminderMessageId: undefined,
  replyReminderMessageId: undefined,
  joinedAt: 0,
  expiresAt: 0,
};

describe("验证终态执行段判定", () => {
  test("只有 kickPending / checkingInviter / expelling 属于终态执行段", () => {
    for (const phase of ["kickPending", "checkingInviter", "expelling"] as const) {
      expect(isTerminalVerificationPhase(phase)).toBeTrue();
    }
    for (const phase of ["pending", "exempt", "kicked", undefined] as const) {
      expect(isTerminalVerificationPhase(phase)).toBeFalse();
    }
  });

  test("状态对象版本与 phase 判定是同一组 kind", () => {
    const terminal: readonly VerificationState[] = [
      kickPendingOf({ label: "杂鱼A", isBot: false, requestedAt: 0, countedJoinAt: undefined, announcementMessageId: undefined }),
      checkingInviterOf(7, SNAPSHOT),
      expellingOf("flood", SNAPSHOT),
    ];
    for (const state of terminal) expect(isTerminalVerificationState(state)).toBeTrue();
    for (const state of [exemptOf("杂鱼A", false), kickedOf("杂鱼A", false, 0), undefined]) {
      expect(isTerminalVerificationState(state)).toBeFalse();
    }
  });
});
