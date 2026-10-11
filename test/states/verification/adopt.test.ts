import { describe, expect, test } from "bun:test";
import { JOIN_WINDOW_MS } from "../../../packages/consts/antiRaid/lockdown";
import { adoptVerificationState } from "../../../packages/states/verification/adopt";
import type {
  CheckingInviterVerificationSnapshot,
  ExpellingVerificationSnapshot,
  KickPendingVerificationSnapshot,
  PendingVerificationSnapshot,
  VerificationSnapshotBase,
} from "../../../packages/types/antiRaid/verification";
import type { VerificationState } from "../../../packages/types/states/verification";

const NOW: number = 20_000_000;

/** 只含必填字段的快照底座：可选的消息 id 与拉人者全部缺省。 */
function minimalBase(): VerificationSnapshotBase {
  return {
    chatId: -1001,
    userId: 7,
    generation: 2,
    revision: 9,
    label: "杂鱼C",
    isBot: true,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: NOW - 30_000,
    expiresAt: NOW + 90_000,
  };
}

/** 可选字段全部写上的快照底座。 */
function fullBase(): VerificationSnapshotBase {
  return {
    ...minimalBase(),
    announcementMessageId: 601,
    invitedBy: 77,
    reminderMessageId: 602,
    replyReminderMessageId: 603,
    welcomeAnchorMessageId: 604,
  };
}

/** 落盘元数据只属于快照，不进内存状态。 */
const SNAPSHOT_ONLY_KEYS: readonly string[] = ["chatId", "userId", "generation", "revision", "phase"];

function expectNoSnapshotMetadata(state: VerificationState): void {
  for (const key of SNAPSHOT_ONLY_KEYS) expect(Object.keys(state)).not.toContain(key);
}

describe("adoptVerificationState：pending", () => {
  test("缺省的可选字段重建为 undefined，键集合与全字段快照一致", () => {
    const minimal: VerificationState = adoptVerificationState({ ...minimalBase(), phase: "pending" }, NOW);
    const full: VerificationState = adoptVerificationState({ ...fullBase(), phase: "pending" }, NOW);

    expect(minimal).toEqual({
      kind: "pending",
      label: "杂鱼C",
      isBot: true,
      announcementMessageId: undefined,
      trackedMessageTimes: [],
      invitedBy: undefined,
      reminderMessageId: undefined,
      replyReminderMessageId: undefined,
      replyReminderRequested: false,
      welcomeAnchorMessageId: undefined,
      reminderSuperseded: false,
      joinedAt: NOW - 30_000,
      expiresAt: NOW + 90_000,
    });
    expect(Object.keys(minimal)).toEqual(Object.keys(full));
    expectNoSnapshotMetadata(full);
  });

  test("发言窗口返回新数组，落盘快照里的数组不被修改", () => {
    const times: number[] = [NOW - 10, NOW - 5];
    const record: PendingVerificationSnapshot = { ...minimalBase(), phase: "pending", trackedMessageTimes: times };

    const state: VerificationState = adoptVerificationState(record, NOW);

    const tracked: number[] | undefined = state.kind === "pending" ? state.trackedMessageTimes : undefined;
    expect(tracked).toEqual([NOW - 10, NOW - 5]);
    expect(tracked).not.toBe(times);
    expect(record.trackedMessageTimes).toEqual([NOW - 10, NOW - 5]);
  });

  test("窗口内一条都不剩时得到空数组", () => {
    const record: PendingVerificationSnapshot = {
      ...minimalBase(),
      phase: "pending",
      trackedMessageTimes: [NOW - 2 * JOIN_WINDOW_MS, NOW - JOIN_WINDOW_MS, NOW + 1],
    };

    const state: VerificationState = adoptVerificationState(record, NOW);

    expect(state.kind === "pending" ? state.trackedMessageTimes : undefined).toEqual([]);
  });
});

describe("adoptVerificationState：终态", () => {
  test("kickPending 只取自己的字段，发言窗口、拉人者与提醒 id 都不带入", () => {
    const record: KickPendingVerificationSnapshot = {
      ...fullBase(),
      phase: "kickPending",
      trackedMessageTimes: [NOW - 1],
      requestedAt: NOW - 100,
    };

    const state: VerificationState = adoptVerificationState(record, NOW);

    expect(state).toEqual({
      kind: "kickPending",
      label: "杂鱼C",
      isBot: true,
      requestedAt: NOW - 100,
      countedJoinAt: undefined,
      announcementMessageId: 601,
      effectStarted: false,
      executionStarted: false,
    });
    expectNoSnapshotMetadata(state);
  });

  test("kickPending 缺省公告与计数时间戳时键集合不变", () => {
    const minimal: VerificationState = adoptVerificationState({ ...minimalBase(), phase: "kickPending", requestedAt: NOW }, NOW);
    const full: VerificationState = adoptVerificationState(
      { ...fullBase(), phase: "kickPending", requestedAt: NOW, countedJoinAt: NOW - 1 },
      NOW
    );

    expect(minimal.kind === "kickPending" ? minimal.announcementMessageId : "missing").toBeUndefined();
    expect(Object.keys(minimal)).toEqual(Object.keys(full));
  });

  test("checkingInviter 缺省消息 id 时快照里对应项为 undefined，键集合不变", () => {
    const minimalRecord: CheckingInviterVerificationSnapshot = { ...minimalBase(), phase: "checkingInviter", terminalInviterId: 88 };
    const fullRecord: CheckingInviterVerificationSnapshot = { ...fullBase(), phase: "checkingInviter", terminalInviterId: 88 };

    const minimal: VerificationState = adoptVerificationState(minimalRecord, NOW);
    const full: VerificationState = adoptVerificationState(fullRecord, NOW);

    expect(minimal).toEqual({
      kind: "checkingInviter",
      inviterId: 88,
      snapshot: {
        label: "杂鱼C",
        isBot: true,
        announcementMessageId: undefined,
        reminderMessageId: undefined,
        replyReminderMessageId: undefined,
        joinedAt: NOW - 30_000,
        expiresAt: NOW + 90_000,
      },
      executionStarted: false,
    });
    expect(Object.keys(minimal)).toEqual(Object.keys(full));
    expect(full.kind === "checkingInviter" ? Object.keys(full.snapshot) : [])
      .toEqual(minimal.kind === "checkingInviter" ? Object.keys(minimal.snapshot) : ["missing"]);
  });

  test("expelling 只带回落盘里出现的播报记账，单独的 failureNoticeSent 原样保留", () => {
    const record: ExpellingVerificationSnapshot = {
      ...fullBase(),
      phase: "expelling",
      expelReason: "timeout",
      failureNoticeSent: true,
    };

    const state: VerificationState = adoptVerificationState(record, NOW);

    expect(state).toEqual({
      kind: "expelling",
      reason: "timeout",
      snapshot: {
        label: "杂鱼C",
        isBot: true,
        announcementMessageId: 601,
        reminderMessageId: 602,
        replyReminderMessageId: 603,
        joinedAt: NOW - 30_000,
        expiresAt: NOW + 90_000,
      },
      executionStarted: false,
      failureNoticeSent: true,
      unconfirmedNoticeSent: undefined,
      successNoticeSent: undefined,
      removalConfirmed: undefined,
    });
    expectNoSnapshotMetadata(state);
  });

  test("expelling 有无播报记账时键集合一致", () => {
    const bare: VerificationState = adoptVerificationState({ ...minimalBase(), phase: "expelling", expelReason: "flood" }, NOW);
    const noted: VerificationState = adoptVerificationState(
      {
        ...fullBase(),
        phase: "expelling",
        expelReason: "flood",
        failureNoticeSent: true,
        unconfirmedNoticeSent: true,
        successNoticeSent: true,
        removalConfirmed: true,
      },
      NOW
    );

    expect(Object.keys(bare)).toEqual(Object.keys(noted));
  });
});
