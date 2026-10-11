import { describe, expect, test } from "bun:test";
import type { ChatPermissions } from "grammy/types";
import { handleAnnouncementResult } from "../../../packages/states/lockdown/announcement";
import type {
  LockdownAnnouncement,
  LockdownState,
  LockdownTransition,
} from "../../../packages/types/states/lockdown";

const PERMS: ChatPermissions = { can_send_messages: true, can_invite_users: true };
const INTENT_ID: number = 3;
const MESSAGE_ID: number = 900;

/** 有一次公告在途、还没拿到结果。 */
const PENDING: LockdownAnnouncement = { announced: false, announcementPending: true, announcementMessageId: undefined };

function result(state: LockdownState | undefined, messageId: number | undefined): LockdownTransition {
  return handleAnnouncementResult(state, { type: "announcementResult", messageId });
}

function active(announcement: LockdownAnnouncement): LockdownState {
  return { kind: "active", originalPermissions: PERMS, intentId: INTENT_ID, ...announcement };
}

/*
 * 本轮已结束、没有在途公告、发送失败与 preparing 占位这几条，经 transitionLockdown 的场景由
 * test/states/lockdown.test.ts 的「封锁公告」覆盖；本文件只补各阶段落盘与不改写原状态。
 */
describe("handleAnnouncementResult：有在途公告", () => {
  test("发送成功：记下 ID、置位 announced 并落盘，原状态不被改写", () => {
    const current: LockdownState = active(PENDING);

    const { next, effects }: LockdownTransition = result(current, MESSAGE_ID);

    expect(next).toEqual(active({ announced: true, announcementPending: false, announcementMessageId: MESSAGE_ID }));
    expect(effects).toEqual([{ kind: "persistState" }]);
    expect(current).toEqual(active(PENDING));
  });

  test("prepared、RECONCILING 与 RESTORING 都有 intent：记下 ID 并落盘，其余字段不动", () => {
    const states: readonly LockdownState[] = [
      { kind: "applying", stage: "prepared", originalPermissions: PERMS, intentId: INTENT_ID, commitStarted: true, ...PENDING },
      { kind: "reconciling", originalPermissions: PERMS, intentId: INTENT_ID, reapplyAfterPersist: true, ...PENDING },
      {
        kind: "restoring",
        originalPermissions: PERMS,
        intentId: INTENT_ID,
        restoreAfterPersist: false,
        restoreReason: "expired",
        ...PENDING,
      },
    ];
    for (const current of states) {
      const { next, effects }: LockdownTransition = result(current, MESSAGE_ID);

      expect(next).toEqual({ ...current, announced: true, announcementPending: false, announcementMessageId: MESSAGE_ID });
      expect(effects).toEqual([{ kind: "persistState" }]);
    }
  });
});
