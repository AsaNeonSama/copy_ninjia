import { describe, expect, test } from "bun:test";
import type { ChatPermissions } from "grammy/types";
import { handleAdopt } from "../../../packages/states/lockdown/adopt";
import type { LockdownPhase } from "../../../packages/types/chatState";
import type {
  LockdownMachineEvent,
  LockdownTransition,
} from "../../../packages/types/states/lockdown";

type AdoptEvent = Extract<LockdownMachineEvent, { type: "adopt" }>;

const PERMS: ChatPermissions = { can_send_messages: true, can_invite_users: true };
const INTENT_ID: number = 17;
const MESSAGE_ID: number = 900;
const REMAINING_MS: number = 42_000;

/** 落盘记录的接管事件；默认是公告过、已确认落盘的那一份。 */
function adoptEvent(phase: LockdownPhase, overrides: Partial<AdoptEvent> = {}): AdoptEvent {
  return {
    type: "adopt",
    phase,
    originalPermissions: PERMS,
    intentId: INTENT_ID,
    announced: true,
    announcementMessageId: MESSAGE_ID,
    remainingMs: REMAINING_MS,
    persisted: true,
    ...overrides,
  };
}

/** 落盘为没公告过、也没有公告 ID 的那一份。 */
const UNANNOUNCED: Partial<AdoptEvent> = { announced: false, announcementMessageId: undefined };

/*
 * 接管 ACTIVE 公告与否、APPLYING/RESTORING 各落盘状态、剩余时长与幂等跳过，经 transitionLockdown 的场景
 * 由 test/states/lockdown.test.ts 的「adopt 接管」覆盖；本文件只补那里没走到的分支。
 */

describe("handleAdopt：接管 ACTIVE", () => {
  test("ACTIVE 不看落盘确认位：未确认的记录产出同一转移", () => {
    expect(handleAdopt(undefined, adoptEvent("active", { persisted: false })))
      .toEqual(handleAdopt(undefined, adoptEvent("active")));
  });
});

describe("handleAdopt：接管 APPLYING", () => {
  test("没公告过且已确认落盘：公告排在提交之前", () => {
    const { next, effects }: LockdownTransition = handleAdopt(undefined, adoptEvent("applying", UNANNOUNCED));

    expect(next?.announcementPending).toBeTrue();
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "beginLockdownAnnouncement" },
      { kind: "commitApply" },
    ]);
  });
});

describe("handleAdopt：接管 RECONCILING", () => {
  test("已确认落盘：排恢复后立刻重新收紧", () => {
    const { next, effects }: LockdownTransition = handleAdopt(undefined, adoptEvent("reconciling"));

    expect(next).toEqual({
      kind: "reconciling",
      originalPermissions: PERMS,
      intentId: INTENT_ID,
      reapplyAfterPersist: false,
      announced: true,
      announcementPending: false,
      announcementMessageId: MESSAGE_ID,
    });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "scheduleRestore", delayMs: REMAINING_MS },
      { kind: "beginReapply" },
    ]);
  });

  test("未确认落盘且没公告过：补公告、排恢复，等回执再收紧", () => {
    const { next, effects }: LockdownTransition = handleAdopt(
      undefined,
      adoptEvent("reconciling", { ...UNANNOUNCED, persisted: false })
    );

    expect(next?.kind === "reconciling" ? next.reapplyAfterPersist : undefined).toBeTrue();
    expect(next?.announcementPending).toBeTrue();
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "beginLockdownAnnouncement" },
      { kind: "scheduleRestore", delayMs: REMAINING_MS },
    ]);
  });
});
