import { expect, test } from "bun:test";
import type { ChatPermissions } from "grammy/types";
import {
  activeOf,
  preparedOf,
  preparingOf,
  reconcilingOf,
  restoringOf,
} from "../../packages/states/lockdown/shared";
import type {
  LockdownActiveState,
  LockdownAnnouncement,
  LockdownPreparedState,
  LockdownPreparingState,
  LockdownReconcilingState,
  LockdownRestoringState,
} from "../../packages/types/states/lockdown";

/**
 * 私密模式五个阶段构造函数产出对象的属性顺序固定为类型声明顺序（阶段专有字段在前，
 * LockdownAnnouncement 三字段在末），并用编译期 `Record<keyof State, true>` 锁定字段全集。
 */
test("私密模式五个阶段构造函数按类型声明顺序产出全部字段", () => {
  const announcement: LockdownAnnouncement = {
    announced: true,
    announcementPending: false,
    announcementMessageId: 900,
  };
  const originalPermissions: ChatPermissions = { can_send_messages: true };

  const preparingKeys: Record<keyof LockdownPreparingState, true> = {
    kind: true,
    stage: true,
    announced: true,
    announcementPending: true,
    announcementMessageId: true,
  };
  const preparedKeys: Record<keyof LockdownPreparedState, true> = {
    kind: true,
    stage: true,
    originalPermissions: true,
    intentId: true,
    commitStarted: true,
    announced: true,
    announcementPending: true,
    announcementMessageId: true,
  };
  const activeKeys: Record<keyof LockdownActiveState, true> = {
    kind: true,
    originalPermissions: true,
    intentId: true,
    announced: true,
    announcementPending: true,
    announcementMessageId: true,
  };
  const reconcilingKeys: Record<keyof LockdownReconcilingState, true> = {
    kind: true,
    originalPermissions: true,
    intentId: true,
    reapplyAfterPersist: true,
    announced: true,
    announcementPending: true,
    announcementMessageId: true,
  };
  const restoringKeys: Record<keyof LockdownRestoringState, true> = {
    kind: true,
    originalPermissions: true,
    intentId: true,
    restoreAfterPersist: true,
    restoreReason: true,
    announced: true,
    announcementPending: true,
    announcementMessageId: true,
  };

  expect(Object.keys(preparingOf())).toEqual(Object.keys(preparingKeys));
  expect(
    Object.keys(
      preparedOf({
        originalPermissions,
        intentId: 1,
        commitStarted: false,
        announcement,
      })
    )
  ).toEqual(Object.keys(preparedKeys));
  expect(Object.keys(activeOf(originalPermissions, 1, announcement))).toEqual(
    Object.keys(activeKeys)
  );
  expect(
    Object.keys(
      reconcilingOf({
        originalPermissions,
        intentId: 1,
        reapplyAfterPersist: true,
        announcement,
      })
    )
  ).toEqual(Object.keys(reconcilingKeys));
  expect(
    Object.keys(
      restoringOf({
        originalPermissions,
        intentId: 1,
        restoreAfterPersist: true,
        restoreReason: "expired",
        announcement,
      })
    )
  ).toEqual(Object.keys(restoringKeys));
});
