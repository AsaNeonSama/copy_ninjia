import { describe, expect, test } from "bun:test";
import { NO_VERIFICATION_EFFECTS } from "../../../packages/consts/antiRaid/verification";
import { handleGuardDisabled } from "../../../packages/states/verification/disable";
import type {
  ExpelSnapshot,
  PendingState,
  VerificationState,
  VerificationTransition,
} from "../../../packages/types/states/verification";

const NOW: number = 30_000_000;

function pending(reminderMessageId: number | undefined, replyReminderMessageId: number | undefined): PendingState {
  return {
    kind: "pending",
    label: "杂鱼D",
    isBot: false,
    announcementMessageId: 701,
    trackedMessageTimes: [NOW - 1],
    invitedBy: 77,
    reminderMessageId,
    replyReminderMessageId,
    replyReminderRequested: replyReminderMessageId !== undefined,
    welcomeAnchorMessageId: 704,
    reminderSuperseded: false,
    joinedAt: NOW - 10_000,
    expiresAt: NOW + 50_000,
  };
}

const SNAPSHOT: ExpelSnapshot = {
  label: "杂鱼D",
  isBot: false,
  announcementMessageId: 801,
  reminderMessageId: 802,
  replyReminderMessageId: 803,
  joinedAt: NOW - 10_000,
  expiresAt: NOW,
};

describe("handleGuardDisabled：关闭入群守卫时的收尾", () => {
  test("没有记录：保持 ABSENT，无副作用", () => {
    const { next, effects }: VerificationTransition = handleGuardDisabled(undefined);

    expect(next).toBeUndefined();
    expect(effects).toBe(NO_VERIFICATION_EFFECTS);
  });

  test("pending：删掉两类提醒后回到 ABSENT，不踢人、不撤计数、不动入群公告", () => {
    const transition: VerificationTransition = handleGuardDisabled(pending(502, 503));

    expect(transition).toEqual({
      next: undefined,
      effects: [{ kind: "deleteReminders", reminderMessageId: 502, replyReminderMessageId: 503 }],
    });
  });

  test("pending 只发出过原提醒：回复提醒 id 为 undefined", () => {
    const { effects }: VerificationTransition = handleGuardDisabled(pending(502, undefined));

    expect(effects).toEqual([{ kind: "deleteReminders", reminderMessageId: 502, replyReminderMessageId: undefined }]);
  });

  test("pending 一条提醒都没发出：仍交给解释器一条两项均为 undefined 的删除", () => {
    const { next, effects }: VerificationTransition = handleGuardDisabled(pending(undefined, undefined));

    expect(next).toBeUndefined();
    expect(effects).toEqual([{ kind: "deleteReminders", reminderMessageId: undefined, replyReminderMessageId: undefined }]);
  });

  test("checkingInviter：按冻结快照里的提醒 id 删除，放弃拉人者终核", () => {
    const state: VerificationState = { kind: "checkingInviter", inviterId: 88, snapshot: SNAPSHOT, executionStarted: true };

    expect(handleGuardDisabled(state)).toEqual({
      next: undefined,
      effects: [{ kind: "deleteReminders", reminderMessageId: 802, replyReminderMessageId: 803 }],
    });
  });

  test("expelling：两种原因都只删提醒，不再踢人或播报", () => {
    for (const reason of ["timeout", "flood"] as const) {
      const state: VerificationState = {
        kind: "expelling",
        reason,
        snapshot: SNAPSHOT,
        executionStarted: false,
        failureNoticeSent: undefined,
        unconfirmedNoticeSent: undefined,
        successNoticeSent: undefined,
        removalConfirmed: true,
      };

      expect(handleGuardDisabled(state)).toEqual({
        next: undefined,
        effects: [{ kind: "deleteReminders", reminderMessageId: 802, replyReminderMessageId: 803 }],
      });
    }
  });

  test("kickPending、exempt、kicked 没有提醒可删：直接回到 ABSENT", () => {
    const states: readonly VerificationState[] = [
      {
        kind: "kickPending",
        label: "杂鱼D",
        isBot: false,
        requestedAt: NOW,
        countedJoinAt: NOW,
        announcementMessageId: 701,
        effectStarted: true,
        executionStarted: true,
      },
      { kind: "exempt", label: "杂鱼D", isBot: false },
      { kind: "kicked", label: "杂鱼D", isBot: true, kickedAt: NOW },
    ];
    for (const state of states) {
      const { next, effects }: VerificationTransition = handleGuardDisabled(state);

      expect(next).toBeUndefined();
      expect(effects).toBe(NO_VERIFICATION_EFFECTS);
    }
  });

  test("不改写传入的状态对象", () => {
    const state: PendingState = pending(502, 503);

    handleGuardDisabled(state);

    expect(state).toEqual(pending(502, 503));
  });
});
