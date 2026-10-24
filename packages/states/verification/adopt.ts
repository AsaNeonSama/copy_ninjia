import { JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import { trimSlidingWindowArray } from "../../libs/slidingWindowRateLimit";
import type { VerificationSnapshot } from "../../types/antiRaid/verification";
import type { VerificationState } from "../../types/states/verification";
import { checkingInviterOf, expellingOf, kickPendingOf, snapshotOf } from "./shared";

/**
 * 将落盘验证快照重建为内存状态（纯转换，计时器与补投由 workers/antiRaid/verificationRuntime.ts 的 adoptVerifications 安排）。
 * `executionStarted`、`effectStarted` 为 Worker 本地幂等门，重建时初始化为 false；pending 发言滑窗按 JOIN_WINDOW_MS 裁剪。
 * @param record 落盘快照；phase 决定必填字段（见 types/antiRaid/verification.ts）。
 * @param now 本次重建的观测时刻，用于裁剪发言窗口。
 * @returns 重建后的内存验证状态。
 */
export function adoptVerificationState(record: VerificationSnapshot, now: number): VerificationState {
  switch (record.phase) {
    case "kickPending":
      return kickPendingOf({
        label: record.label,
        isBot: record.isBot,
        requestedAt: record.requestedAt,
        countedJoinAt: record.countedJoinAt,
        announcementMessageId: record.announcementMessageId,
      });
    case "checkingInviter":
      return checkingInviterOf(record.terminalInviterId, snapshotOf(record));
    case "expelling":
      return expellingOf(record.expelReason, snapshotOf(record), record);
    case "pending":
      return {
        kind: "pending",
        label: record.label,
        isBot: record.isBot,
        announcementMessageId: record.announcementMessageId,
        trackedMessageTimes: trimSlidingWindowArray({
          timestamps: record.trackedMessageTimes,
          windowMs: JOIN_WINDOW_MS,
          now,
        }),
        invitedBy: record.invitedBy,
        reminderMessageId: record.reminderMessageId,
        replyReminderMessageId: record.replyReminderMessageId,
        replyReminderRequested: record.replyReminderRequested,
        welcomeAnchorMessageId: record.welcomeAnchorMessageId,
        reminderSuperseded: record.reminderSuperseded,
        joinedAt: record.joinedAt,
        expiresAt: record.expiresAt,
      };
  }
}
