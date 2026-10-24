import { describe, expect, test } from "bun:test";
import {
  joinCreatesNewRecord,
  transitionVerification,
} from "../../packages/states/verification";
import type { PendingState, VerificationState } from "../../packages/types/states/verification";
import {
  ANTI_RAID_PER_MINUTE_LIMIT,
  JOIN_WINDOW_MS,
} from "../../packages/consts/antiRaid/lockdown";
import { VERIFICATION_TIMEOUT_MS } from "../../packages/consts/antiRaid/verification";
import {
  effectKinds,
  joinEvent,
  kickedState,
  kickPendingState,
  pendingState,
} from "../helpers/verificationStateFixtures";

/** 已要求过回复式提醒的 pending：三个字段同真并带锚点（唯一写入点见 states/verification/pending.ts）。 */
const REPLY_REMINDER_REQUESTED: Partial<PendingState> = {
  replyReminderRequested: true,
  reminderSuperseded: true,
  welcomeAnchorMessageId: 40,
};

describe("join：ABSENT 起步", () => {
  test("普通入群验证窗口为 VERIFICATION_TIMEOUT_MS", () => {
    const { next } = transitionVerification(undefined, joinEvent({ now: 7_000 }));
    expect((next as PendingState).expiresAt).toBe(7_000 + VERIFICATION_TIMEOUT_MS);
  });

  test("普通自主入群 → PENDING + 发原始提醒，不挂管理员核查", () => {
    const event = joinEvent({ announcementMessageId: 7 });
    expect(joinCreatesNewRecord(undefined, event)).toBe(true);
    const { next, effects } = transitionVerification(undefined, event);
    expect(next?.kind).toBe("pending");
    // 公告显式持有；成员发言不会进入任何待删除 id 列表。
    expect((next as PendingState).announcementMessageId).toBe(7);
    expect((next as PendingState).invitedBy).toBeUndefined();
    expect((next as PendingState).expiresAt).toBe(VERIFICATION_TIMEOUT_MS);
    expect(effectKinds(effects)).toEqual(["sendReminder"]);
  });

  test("被他人拉入群（缓存冷）→ PENDING 记录拉人者 + 挂异步核查 + 发提醒", () => {
    const event = joinEvent({ actorId: 999 });
    const { next, effects } = transitionVerification(undefined, event);
    expect((next as PendingState).invitedBy).toBe(999);
    expect(effectKinds(effects)).toEqual(["startAdminCheck", "sendReminder"]);
  });

  test("被他人拉入群（缓存热，同步快路径已判过非管理员）→ PENDING 记录拉人者 + 只发提醒，不再挂异步核查", () => {
    const event = joinEvent({ actorId: 999, adminCacheFresh: true });
    const { next, effects } = transitionVerification(undefined, event);
    expect((next as PendingState).invitedBy).toBe(999);
    expect(effectKinds(effects)).toEqual(["sendReminder"]);
  });

  test("管理员身份入群 → EXEMPT，不计入刷群统计", () => {
    const event = joinEvent({ identityExempt: true });
    expect(joinCreatesNewRecord(undefined, event)).toBe(false);
    const { next, effects } = transitionVerification(undefined, event);
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([]);
  });

  test("非匿名管理员缓存命中的拉人 → EXEMPT", () => {
    const { next } = transitionVerification(undefined, joinEvent({ actorId: 999, actorSyncExempt: true }));
    expect(next?.kind).toBe("exempt");
  });

  test("评论区活动先到 → EXEMPT、不计数并在对应消息下欢迎", () => {
    const event = joinEvent({ recentComment: { messageId: 55 } });
    expect(joinCreatesNewRecord(undefined, event)).toBe(false);
    const { next, effects } = transitionVerification(undefined, event);
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([{ kind: "sendWelcome", variant: "channelComment", targetLabel: "杂鱼A", anchorMessageId: 55 }]);
  });

  test("私密模式普通入群先进入可持久化 KICK_PENDING，不在落盘前执行踢人", () => {
    const event = joinEvent({ lockdownActive: true, announcementMessageId: 7 });
    expect(joinCreatesNewRecord(undefined, event)).toBe(true); // 秒踢的入群也计入刷群统计
    const { next, effects } = transitionVerification(undefined, event);
    expect(next).toMatchObject({
      kind: "kickPending",
      announcementMessageId: 7,
    });
    expect(effects).toEqual([]);
  });

  test("私密模式期间评论或楼中楼回复触发的入群仍豁免且不计数", () => {
    const event = joinEvent({ lockdownActive: true, recentComment: { messageId: 55 } });
    expect(joinCreatesNewRecord(undefined, event)).toBe(false);
    const { next, effects } = transitionVerification(undefined, event);
    expect(next?.kind).toBe("exempt");
    expect(effectKinds(effects)).toEqual(["sendWelcome"]);
    expect(effectKinds(effects)).not.toContain("kickMember");
  });

  test("私密模式期间管理员拉人（同步缓存命中）→ 照常 EXEMPT，不踢", () => {
    const { next, effects } = transitionVerification(undefined, joinEvent({ lockdownActive: true, actorId: 999, actorSyncExempt: true }));
    expect(next?.kind).toBe("exempt");
    expect(effectKinds(effects)).not.toContain("kickMember");
  });
});

describe("join：重复投递（chat_member 与服务消息各到一次）", () => {
  test("PENDING 上的迟到公告 → 记进独立字段，不重发提醒", () => {
    const state = pendingState();
    const result = transitionVerification(state, joinEvent({ announcementMessageId: 9 }));
    const { next, effects } = result;
    expect(next).toBe(state);
    expect(state.announcementMessageId).toBe(9);
    expect(effects).toEqual([]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("PENDING 上出现第二条入群公告 → 立即删掉多余服务消息", () => {
    const state = pendingState({ announcementMessageId: 8 });
    const { effects } = transitionVerification(state, joinEvent({ announcementMessageId: 9 }));
    expect(state.announcementMessageId).toBe(8);
    expect(effects).toEqual([{ kind: "deleteMessage", messageId: 9 }]);
  });

  test("PENDING + 本路带拉人者且缓存冷 → 补挂核查并记录 invitedBy", () => {
    const state = pendingState();
    const result = transitionVerification(state, joinEvent({ actorId: 999, adminCacheFresh: false }));
    expect(state.invitedBy).toBe(999);
    expect(effectKinds(result.effects)).toEqual(["startAdminCheck"]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("PENDING + 缓存热（同步快路径已判过非管理员）→ 补记 invitedBy 且不再挂核查", () => {
    const state = pendingState();
    const result = transitionVerification(state, joinEvent({ actorId: 999, adminCacheFresh: true }));
    expect(state.invitedBy).toBe(999);
    expect(result.effects).toEqual([]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("KICK_PENDING 上的迟到公告（去重宽限期内）→ 异号顺手删除，同号不重复删", () => {
    const state = kickPendingState({ requestedAt: 0 });
    const { next, effects } = transitionVerification(state, joinEvent({ announcementMessageId: 9, now: 1000 }));
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "deleteMessage", messageId: 9 }]);

    const withAnnouncement = kickPendingState({ requestedAt: 0, announcementMessageId: 9 });
    const duplicateSame = transitionVerification(
      withAnnouncement,
      joinEvent({ announcementMessageId: 9, now: 1000 })
    );
    expect(duplicateSame.next).toBe(withAnnouncement);
    expect(duplicateSame.effects).toEqual([]);
  });

  test("KICKED 占位遇到真的重新入群：按新入群计数，私密模式仍开启时换成待落盘 kickPending 且不双重删公告，已解除时转入正常 pending", () => {
    const state = kickedState({ kickedAt: 0 });
    const lockedJoin = joinEvent({ now: 10_000, lockdownActive: true, announcementMessageId: 19 });
    expect(joinCreatesNewRecord(state, lockedJoin)).toBeTrue();
    const { next, effects } = transitionVerification(state, lockedJoin);
    expect(next).not.toBe(state);
    expect(next).toMatchObject({
      kind: "kickPending",
      label: "杂鱼A",
      isBot: false,
      requestedAt: 10_000,
      countedJoinAt: 10_000,
      announcementMessageId: 19,
    });
    expect(effects).toEqual([]);

    const unlockedJoin = joinEvent({ now: 10_000, lockdownActive: false, announcementMessageId: 20 });
    expect(joinCreatesNewRecord(state, unlockedJoin)).toBeTrue();
    const unlocked = transitionVerification(state, unlockedJoin);
    expect(unlocked.next).toMatchObject({
      kind: "pending",
      label: "杂鱼A",
      isBot: false,
      joinedAt: 10_000,
      announcementMessageId: 20,
    });
    expect(unlocked.effects).toEqual([{ kind: "sendReminder", label: "杂鱼A", isBot: false }]);
  });

  test("重新入群本身触发私密模式：计数判定与刷新后的转移一致，countedJoinAt 记下这次计数", () => {
    const state = kickedState({ kickedAt: 0 });
    const event = joinEvent({ now: 10_000, lockdownActive: false });
    expect(joinCreatesNewRecord(state, event)).toBeTrue();
    // 调用方 recordJoin 后刷新 lockdownActive 再派发（见 workers/antiRaid/verificationEvents.ts）。
    event.lockdownActive = true;
    const { next } = transitionVerification(state, event);
    expect(next).toMatchObject({ kind: "kickPending", requestedAt: 10_000, countedJoinAt: 10_000 });
  });

  test("KICK_PENDING 超出宽限期：异号公告按重新入群并删除旧公告；同号公告仍是同一次入群的重复投递", () => {
    const state = kickPendingState({ requestedAt: 0, countedJoinAt: 0, announcementMessageId: 9 });
    const rejoin = joinEvent({ now: 10_000, lockdownActive: true, announcementMessageId: 10 });
    expect(joinCreatesNewRecord(state, rejoin)).toBeTrue();
    const replaced = transitionVerification(state, rejoin);
    expect(replaced.next).toMatchObject({ kind: "kickPending", requestedAt: 10_000, countedJoinAt: 10_000, announcementMessageId: 10 });
    expect(replaced.effects).toEqual([{ kind: "deleteMessage", messageId: 9 }]);

    const redelivered = joinEvent({ now: 10_000, lockdownActive: true, announcementMessageId: 9 });
    expect(joinCreatesNewRecord(state, redelivered)).toBeFalse();
    const duplicate = transitionVerification(state, redelivered);
    expect(duplicate.next).toBe(state);
    expect(duplicate.effects).toEqual([]);
  });

  test("豁免入群撞上已开的验证窗口 → 撤销并删提醒，且按精确时刻撤销此前记的那次刷群计数", () => {
    const state = pendingState({ reminderMessageId: 30, replyReminderMessageId: 31, joinedAt: 12_345 });
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: 31 },
      { kind: "retractJoinCount", joinedAt: 12_345 },
    ]);
  });

  test("豁免入群在踢人请求发出前到达 → 失效旧动作并撤销刷群计数", () => {
    const state = kickPendingState({ requestedAt: 12_345, countedJoinAt: 12_345 });
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toEqual({ kind: "exempt", label: "杂鱼A", isBot: false });
    expect(effects).toEqual([{ kind: "retractJoinCount", joinedAt: 12_345 }]);
  });

  test("重进补踢建出的占位没计过数 → 晚到的豁免一格都不撤", () => {
    // 这一路 joinCreatesNewRecord 为 false（状态已存在），调用方没有 recordJoin：晚到的豁免不撤销任何计数。
    const state = kickPendingState({ requestedAt: 12_345 });
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toEqual({ kind: "exempt", label: "杂鱼A", isBot: false });
    expect(effects).toEqual([]);
  });

  test("豁免入群在踢人请求已发出后到达 → 保持占位并记录不可撤销诊断", () => {
    const state = kickPendingState({ executionStarted: true });
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "logUncancelableKickExemption", label: "杂鱼A" }]);
  });

  test("豁免入群撞上已有 KICKED 占位 → 保持占位不动，只留一条日志方便人工纠正", () => {
    const state = kickedState();
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "logUncancelableKickExemption", label: "杂鱼A" }]);
  });

  test("豁免入群撞上已有 EXEMPT 占位 → 保持占位不动，无需额外日志（本就已经豁免，没有被误踢）", () => {
    const state: VerificationState = { kind: "exempt", label: "杂鱼A", isBot: false };
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

describe("trackedMessage", () => {
  test("时钟回拨后落在未来的时间戳照样驱逐，没刷屏的人不会被判成 flood", () => {
    // 窗口同时清理过旧与落在未来的时间戳（NTP 往回跳之后留下的）；同一个阈值的另一半（lockdownRuntime 的入群窗口）
    // 走共享的窗口判定，两边对回拨给出同一种语义。
    const now: number = 1_000_000;
    const state = pendingState({
      // 全部「来自未来」：时钟往回跳超过一个窗口之后就是这个形态。
      trackedMessageTimes: Array.from(
        { length: ANTI_RAID_PER_MINUTE_LIMIT },
        (_unused: unknown, index: number): number => now + JOIN_WINDOW_MS + index
      ),
    });

    const { next } = transitionVerification(state, { type: "trackedMessage", messageId: 41, inCommentThread: false, now });

    expect(next?.kind).toBe("pending");
    // 只剩本次这一条：越界的全被驱逐，没有凭空多出来的配额消耗。
    expect((next as PendingState).trackedMessageTimes).toEqual([now]);
  });

  test("待验证成员的普通发言 → 只计数并改提醒锚点，不登记删除 id", () => {
    const state = pendingState({ reminderMessageId: 30 });
    const result = transitionVerification(state, { type: "trackedMessage", messageId: 40, inCommentThread: false, now: 1_000 });
    const { effects } = result;
    expect("messageIds" in state).toBeFalse();
    expect(state.trackedMessageTimes).toEqual([1_000]);
    expect(state.reminderMessageId).toBeUndefined();
    expect(state.reminderSuperseded).toBe(true);
    expect(state.welcomeAnchorMessageId).toBe(40);
    // 补发提醒排在删旧提醒之前：解释器会 await deleteMessage，等待期间状态可能被其它投递替换。
    expect(effects).toEqual([
      { kind: "sendReplyReminder", label: "杂鱼A", isBot: false, targetMessageId: 40 },
      { kind: "deleteMessage", messageId: 30 },
    ]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("待验证机器人成员的普通发言 → 回复式提醒携带 isBot: true", () => {
    const state = pendingState({ isBot: true, reminderMessageId: 31 });
    const result = transitionVerification(state, { type: "trackedMessage", messageId: 41, inCommentThread: false, now: 1_000 });
    expect(result.effects).toEqual([
      { kind: "sendReplyReminder", label: "杂鱼A", isBot: true, targetMessageId: 41 },
      { kind: "deleteMessage", messageId: 31 },
    ]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("入群更新先到、楼中楼回复后到 → 转 EXEMPT 并撤销此前入群计数", () => {
    const state = pendingState({ reminderMessageId: 30, joinedAt: 999 });
    const { next, effects } = transitionVerification(state, {
      type: "trackedMessage",
      messageId: 40,
      inCommentThread: true,
      now: 1_000,
    });
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "retractJoinCount", joinedAt: 999 },
      { kind: "sendWelcome", variant: "channelComment", targetLabel: "杂鱼A", anchorMessageId: 40 },
    ]);
  });

  test("连发多条只补发一次回复式提醒", () => {
    const state = pendingState(REPLY_REMINDER_REQUESTED);
    const result = transitionVerification(state, { type: "trackedMessage", messageId: 41, inCommentThread: false, now: 1_000 });
    expect(state.trackedMessageTimes).toEqual([1_000]);
    expect(result.effects).toEqual([]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("评论区活动 → 转 EXEMPT + 欢迎，且撤销此前记的那次刷群计数", () => {
    const state = pendingState({ reminderMessageId: 30, trackedMessageTimes: Array(ANTI_RAID_PER_MINUTE_LIMIT).fill(1_000) });
    const { next, effects } = transitionVerification(state, { type: "trackedMessage", messageId: 42, inCommentThread: true, now: 1_000 });
    expect(next?.kind).toBe("exempt");
    expect(effectKinds(effects)).toEqual(["deleteReminders", "retractJoinCount", "sendWelcome"]);
    expect(state.trackedMessageTimes).toHaveLength(ANTI_RAID_PER_MINUTE_LIMIT);
  });

  test("同一分钟第 45 条继续追踪，第 46 条同步终结并进入刷屏提前踢出", () => {
    const state = pendingState(REPLY_REMINDER_REQUESTED);
    for (let count = 1; count <= ANTI_RAID_PER_MINUTE_LIMIT; count++) {
      const result = transitionVerification(state, {
        type: "trackedMessage",
        messageId: count,
        inCommentThread: false,
        now: 10_000,
      });
      expect(result.next).toBe(state);
      expect(effectKinds(result.effects)).not.toContain("expelFlood");
    }

    const overflow = transitionVerification(state, {
      type: "trackedMessage",
      messageId: ANTI_RAID_PER_MINUTE_LIMIT + 1,
      inCommentThread: false,
      now: 10_000,
    });
    expect(overflow.next).toMatchObject({
      kind: "expelling",
      reason: "flood",
    });
    if (overflow.next?.kind !== "expelling") throw new Error("Expected expelling state");
    expect("messageIds" in overflow.next.snapshot).toBeFalse();
    expect(overflow.effects).toEqual([]);
    const persisted = transitionVerification(overflow.next, { type: "terminalPersisted" });
    expect(effectKinds(persisted.effects)).toEqual(["expelFlood"]);
  });

  test("冷缓存确认可撤回由同一消息触发、但尚未开始执行的 flood 终态", () => {
    const state = pendingState({
      reminderMessageId: 30,
      trackedMessageTimes: Array(ANTI_RAID_PER_MINUTE_LIMIT).fill(10_000),
    });
    const overflow = transitionVerification(state, {
      type: "trackedMessage",
      messageId: 46,
      inCommentThread: false,
      now: 10_000,
    });
    expect(overflow.next?.kind).toBe("expelling");

    const confirmed = transitionVerification(overflow.next, {
      type: "confirmedThreadComment",
      messageId: 46,
      now: 10_000,
      allowFloodTerminalExemption: true,
    });
    expect(confirmed.next).toEqual({
      kind: "exempt",
      label: "杂鱼A",
      isBot: false,
    });
    expect(confirmed.effects).toEqual([
      {
        kind: "deleteReminders",
        reminderMessageId: 30,
        replyReminderMessageId: undefined,
      },
      { kind: "retractJoinCount", joinedAt: 0 },
      {
        kind: "sendWelcome",
        variant: "channelComment",
        targetLabel: "杂鱼A",
        anchorMessageId: 46,
      },
    ]);
  });

  test("冷缓存确认不能撤回已开始执行或不属于该 owner 的 flood 终态", () => {
    const terminal = transitionVerification(
      pendingState({
        trackedMessageTimes:
          Array(ANTI_RAID_PER_MINUTE_LIMIT).fill(10_000),
      }),
      {
        type: "trackedMessage",
        messageId: 46,
        inCommentThread: false,
        now: 10_000,
      }
    ).next;
    expect(terminal?.kind).toBe("expelling");
    if (terminal?.kind !== "expelling") throw new Error("expected expelling");

    expect(
      transitionVerification(terminal, {
        type: "confirmedThreadComment",
        messageId: 46,
        now: 10_000,
        allowFloodTerminalExemption: false,
      }).next
    ).toBe(terminal);
    terminal.executionStarted = true;
    expect(
      transitionVerification(terminal, {
        type: "confirmedThreadComment",
        messageId: 46,
        now: 10_000,
        allowFloodTerminalExemption: true,
      }).next
    ).toBe(terminal);
  });

  test("窗口修剪一分钟外的旧消息，且不同成员/群各自持有独立计数", () => {
    const first = pendingState({ ...REPLY_REMINDER_REQUESTED, trackedMessageTimes: [0, 1_000] });
    transitionVerification(first, {
      type: "trackedMessage",
      messageId: 90,
      inCommentThread: false,
      now: JOIN_WINDOW_MS,
    });
    expect(first.trackedMessageTimes).toEqual([1_000, JOIN_WINDOW_MS]);

    const otherMember = pendingState(REPLY_REMINDER_REQUESTED);
    const otherChat = pendingState(REPLY_REMINDER_REQUESTED);
    transitionVerification(otherMember, { type: "trackedMessage", messageId: 91, inCommentThread: false, now: JOIN_WINDOW_MS });
    transitionVerification(otherChat, { type: "trackedMessage", messageId: 92, inCommentThread: false, now: JOIN_WINDOW_MS });
    expect(otherMember.trackedMessageTimes).toEqual([JOIN_WINDOW_MS]);
    expect(otherChat.trackedMessageTimes).toEqual([JOIN_WINDOW_MS]);
    expect(first.trackedMessageTimes).toHaveLength(2);
  });

  test("占位记录（kicked/exempt）不追踪消息", () => {
    const state: VerificationState = { kind: "exempt", label: "杂鱼A", isBot: false };
    const { next, effects } = transitionVerification(state, { type: "trackedMessage", messageId: 43, inCommentThread: false, now: 1_000 });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
