import { describe, expect, test } from "bun:test";
import type { ChatPermissions } from "grammy/types";
import {
  LOCKDOWN_RETRIGGER_COOLDOWN_MS,
  NO_LOCKDOWN_EFFECTS,
} from "../../../packages/consts/antiRaid/lockdown";
import { handlePersistFailed, handleStatePersisted } from "../../../packages/states/lockdown/persistence";
import type { LockdownPhase } from "../../../packages/types/chatState";
import type {
  LockdownAnnouncement,
  LockdownEffect,
  LockdownState,
  LockdownTransition,
} from "../../../packages/types/states/lockdown";

const PERMS: ChatPermissions = { can_send_messages: true, can_invite_users: true };
const INTENT_ID: number = 5;
const OTHER_INTENT_ID: number = 6;
const MESSAGE_ID: number = 900;

const ANNOUNCED: LockdownAnnouncement = { announced: true, announcementPending: false, announcementMessageId: MESSAGE_ID };
/** 公告还在途：ID 未知，收尾时不删。 */
const IN_FLIGHT: LockdownAnnouncement = { announced: false, announcementPending: true, announcementMessageId: undefined };
const PERSIST_FAILED_SUPPRESSION: LockdownEffect = {
  kind: "suppressRetrigger",
  reason: "persistFailed",
  durationMs: LOCKDOWN_RETRIGGER_COOLDOWN_MS,
};

function prepared(commitStarted: boolean, announcement: LockdownAnnouncement = ANNOUNCED): LockdownState {
  return { kind: "applying", stage: "prepared", originalPermissions: PERMS, intentId: INTENT_ID, commitStarted, ...announcement };
}

function preparing(): LockdownState {
  return { kind: "applying", stage: "preparing", ...IN_FLIGHT };
}

function active(announcement: LockdownAnnouncement = ANNOUNCED): LockdownState {
  return { kind: "active", originalPermissions: PERMS, intentId: INTENT_ID, ...announcement };
}

function reconciling(reapplyAfterPersist: boolean): LockdownState {
  return { kind: "reconciling", originalPermissions: PERMS, intentId: INTENT_ID, reapplyAfterPersist, ...ANNOUNCED };
}

function restoring(restoreAfterPersist: boolean): LockdownState {
  return {
    kind: "restoring",
    originalPermissions: PERMS,
    intentId: INTENT_ID,
    restoreAfterPersist,
    restoreReason: "expired",
    ...ANNOUNCED,
  };
}

function persisted(state: LockdownState | undefined, phase: LockdownPhase, intentId: number = INTENT_ID): LockdownTransition {
  return handleStatePersisted(state, { type: "statePersisted", phase, intentId });
}

function failed(state: LockdownState | undefined, phase: LockdownPhase, intentId: number = INTENT_ID): LockdownTransition {
  return handlePersistFailed(state, { type: "persistFailed", phase, intentId });
}

/** 转移是「原样保持、无副作用」。 */
function expectUnchanged(transition: LockdownTransition, state: LockdownState | undefined): void {
  expect(transition.next).toBe(state);
  expect(transition.effects).toBe(NO_LOCKDOWN_EFFECTS);
}

/*
 * 首次与重复回执、各阶段等回执后的推进，以及提交未派发、ACTIVE/RECONCILING、等回执 RESTORING 的落盘失败，
 * 经 transitionLockdown 的场景由 test/states/lockdown.test.ts 覆盖；本文件只补那里没走到的分支。
 */
describe("handleStatePersisted：落盘回执", () => {
  test("没有状态、阶段对不上或 intent 对不上的回执一律忽略", () => {
    expectUnchanged(persisted(undefined, "active"), undefined);
    const current: LockdownState = active();
    expectUnchanged(persisted(current, "restoring"), current);
    expectUnchanged(persisted(current, "active", OTHER_INTENT_ID), current);
    const pending: LockdownState = restoring(true);
    expectUnchanged(persisted(pending, "restoring", OTHER_INTENT_ID), pending);
  });

  test("已在收紧的 RECONCILING 与 ACTIVE 的回执原样保持", () => {
    const busy: LockdownState = reconciling(false);
    expectUnchanged(persisted(busy, "reconciling"), busy);
    const current: LockdownState = active();
    expectUnchanged(persisted(current, "active"), current);
  });
});

describe("handlePersistFailed：落盘失败 fail-safe 打开", () => {
  test("没有状态、阶段对不上或 intent 对不上的失败通知一律忽略", () => {
    expectUnchanged(failed(undefined, "applying"), undefined);
    const current: LockdownState = active();
    expectUnchanged(failed(current, "reconciling"), current);
    expectUnchanged(failed(current, "active", OTHER_INTENT_ID), current);
    const committing: LockdownState = prepared(true);
    expectUnchanged(failed(committing, "applying", OTHER_INTENT_ID), committing);
    const waiting: LockdownState = restoring(true);
    expectUnchanged(failed(waiting, "restoring", OTHER_INTENT_ID), waiting);
  });

  test("APPLYING preparing 不受落盘失败影响", () => {
    const current: LockdownState = preparing();

    expectUnchanged(failed(current, "applying"), current);
  });

  test("提交未派发且公告 ID 未知：不猜 ID，不删公告", () => {
    const { next, effects }: LockdownTransition = failed(prepared(false, IN_FLIGHT), "applying");

    expect(next).toBeUndefined();
    expect(effects).toEqual([{ kind: "reportUnlock" }, PERSIST_FAILED_SUPPRESSION]);
  });

  test("提交已派发：可能在途，转 RESTORING 先落盘再恢复，公告记账原样带走", () => {
    const { next, effects }: LockdownTransition = failed(prepared(true, IN_FLIGHT), "applying");

    expect(next).toEqual({
      kind: "restoring",
      originalPermissions: PERMS,
      intentId: INTENT_ID,
      restoreAfterPersist: false,
      restoreReason: "lifted",
      ...IN_FLIGHT,
    });
    expect(effects).toEqual([
      { kind: "persistState" },
      { kind: "beginRestore", originalPermissions: PERMS },
      PERSIST_FAILED_SUPPRESSION,
    ]);
  });

  test("已在恢复的 RESTORING 收到失败通知不重复恢复", () => {
    const current: LockdownState = restoring(false);

    expectUnchanged(failed(current, "restoring"), current);
  });
});
