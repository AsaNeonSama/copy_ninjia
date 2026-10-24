import { diskIOStub } from "../helpers/diskIOMock";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { VerificationSnapshot } from "../../packages/types/antiRaid/verification";
import type { DiskBusinessMessage } from "../../packages/types/diskIO/messages";

const diskPosts: DiskBusinessMessage[] = [];

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO(message: DiskBusinessMessage): boolean {
    diskPosts.push(message);
    return true;
  },
})));

const {
  acceptVerificationDeferred,
  advanceDeferredVerificationGeneration,
  deleteDeferredVerificationsForChat,
  grantVerificationAttempt,
  resetVerificationAttemptRuntime,
  settlePersistedVerificationDeferral,
} = await import("../../packages/antiRaid/verificationAttempts");
const { antiRaidRuntimeState } = await import(
  "../../packages/cache/main/antiRaid/proxy"
);
const {
  activeVerificationSnapshots,
  clearActiveVerificationSnapshots,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
  setActiveVerificationSnapshot,
  terminalVerificationAttempts,
} = await import("../../packages/cache/main/antiRaid/verificationMirror");
const { VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS } = await import(
  "../../packages/consts/antiRaid/verification"
);

const KEY: string = "-1001:42";

function terminalRecord(generation: number, revision: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId: 42,
    generation,
    revision,
    phase: "expelling",
    label: "待处置成员",
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: true,
    joinedAt: 1_000,
    expiresAt: 2_000,
    expelReason: "timeout",
  };
}

beforeEach(() => {
  diskPosts.length = 0;
  clearActiveVerificationSnapshots();
  pendingVerificationDeletes.clear();
  persistedVerificationRevisions.clear();
  resetVerificationAttemptRuntime();
  antiRaidRuntimeState.generation = 1;
});

describe("verification terminal process budget", () => {
  test("许可先计数且跨 Worker 代际保留，第 16 次不再批准", () => {
    setActiveVerificationSnapshot(KEY, terminalRecord(1, 3));

    expect(grantVerificationAttempt({
      operation: "verificationAttemptPermit",
      key: KEY,
      generation: 0,
      revision: 3,
    })).toEqual({ status: "stale", attempt: 0 });

    for (
      let attempt: number = 1;
      attempt <= VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS;
      attempt++
    ) {
      expect(grantVerificationAttempt({
        operation: "verificationAttemptPermit",
        key: KEY,
        generation: 1,
        revision: 3,
      })).toEqual({ status: "granted", attempt });
    }
    expect(grantVerificationAttempt({
      operation: "verificationAttemptPermit",
      key: KEY,
      generation: 1,
      revision: 3,
    })).toEqual({
      status: "exhausted",
      attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
    });
  });

  test("最新 revision 未落盘前保留完整镜像，精确回执后才转最小延后索引", () => {
    setActiveVerificationSnapshot(KEY, terminalRecord(1, 3));
    persistedVerificationRevisions.set(KEY, { generation: 1, revision: 2 });
    terminalVerificationAttempts.set(
      KEY,
      VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS
    );

    expect(acceptVerificationDeferred({
      type: "verificationDeferred",
      record: { chatId: -1001, userId: 42, generation: 1, revision: 3 },
    })).toBeTrue();
    expect(activeVerificationSnapshots.get(KEY)?.revision).toBe(3);
    expect(pendingVerificationDeferrals.get(KEY)?.revision).toBe(3);
    expect(deferredVerificationRecords.has(KEY)).toBeFalse();
    expect(diskPosts).toEqual([]);

    expect(settlePersistedVerificationDeferral(KEY, 1, 2)).toBeFalse();
    expect(settlePersistedVerificationDeferral(KEY, 1, 3)).toBeTrue();
    expect(activeVerificationSnapshots.has(KEY)).toBeFalse();
    expect(pendingVerificationDeferrals.has(KEY)).toBeFalse();
    expect(deferredVerificationRecords.get(KEY)).toEqual({
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 3,
    });
    expect(diskPosts).toEqual([]);
  });

  test("延后闩锁随 Worker 代际提升，显式关闭时才写 tombstone", () => {
    setActiveVerificationSnapshot(KEY, terminalRecord(1, 3));
    persistedVerificationRevisions.set(KEY, { generation: 1, revision: 3 });
    expect(acceptVerificationDeferred({
      type: "verificationDeferred",
      record: { chatId: -1001, userId: 42, generation: 1, revision: 3 },
    })).toBeTrue();

    antiRaidRuntimeState.generation = 2;
    advanceDeferredVerificationGeneration(2);
    expect(deferredVerificationRecords.get(KEY)?.generation).toBe(2);
    expect(deleteDeferredVerificationsForChat(-1001)).toBe(1);
    expect(deferredVerificationRecords.has(KEY)).toBeFalse();
    expect(terminalVerificationAttempts.has(KEY)).toBeFalse();
    expect(diskPosts).toEqual([{
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 2,
      revision: 4,
    }]);
  });

  test("终态许可与延后接纳对缺失快照、非终态、修订号不匹配及已延后记录保持拒绝且不改计数", () => {
    expect(grantVerificationAttempt({
      operation: "verificationAttemptPermit",
      key: KEY,
      generation: 1,
      revision: 3,
    })).toEqual({ status: "stale", attempt: 0 });
    expect(terminalVerificationAttempts.has(KEY)).toBeFalse();

    setActiveVerificationSnapshot(KEY, {
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 3,
      phase: "pending",
      label: "待验证成员",
      isBot: false,
      trackedMessageTimes: [],
      replyReminderRequested: false,
      reminderSuperseded: false,
      joinedAt: 1_000,
      expiresAt: 2_000,
    });
    expect(grantVerificationAttempt({
      operation: "verificationAttemptPermit",
      key: KEY,
      generation: 1,
      revision: 3,
    })).toEqual({ status: "stale", attempt: 0 });
    expect(terminalVerificationAttempts.has(KEY)).toBeFalse();

    setActiveVerificationSnapshot(KEY, terminalRecord(1, 3));
    expect(grantVerificationAttempt({
      operation: "verificationAttemptPermit",
      key: KEY,
      generation: 1,
      revision: 2,
    })).toEqual({ status: "stale", attempt: 0 });
    expect(terminalVerificationAttempts.has(KEY)).toBeFalse();

    expect(acceptVerificationDeferred({
      type: "verificationDeferred",
      record: { chatId: -1001, userId: 42, generation: 1, revision: 2 },
    })).toBeFalse();
    expect(terminalVerificationAttempts.has(KEY)).toBeFalse();

    deferredVerificationRecords.set(KEY, {
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 3,
    });
    expect(grantVerificationAttempt({
      operation: "verificationAttemptPermit",
      key: KEY,
      generation: 1,
      revision: 3,
    })).toEqual({ status: "exhausted", attempt: 0 });
    expect(terminalVerificationAttempts.has(KEY)).toBeFalse();
  });
});
