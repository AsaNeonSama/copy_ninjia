import { describe, expect, test } from "bun:test";
import { transitionVerification } from "../../packages/states/verification";
import { checkingInviterOf, expellingOf, snapshotOf } from "../../packages/states/verification/shared";
import type { VerificationState } from "../../packages/types/states/verification";
import {
  VERIFICATION_REMINDER_UNDELIVERED_MAX_MS,
  VERIFICATION_TIMEOUT_MS,
} from "../../packages/consts/antiRaid/verification";
import {
  effectKinds,
  joinEvent,
  kickedState,
  kickPendingState,
  pendingState,
} from "../helpers/verificationStateFixtures";

describe("私密模式踢人结算", () => {
  test("KICK_PENDING 只有收到精确落盘回执后才按删公告、踢人的顺序执行", () => {
    const state = kickPendingState({ announcementMessageId: 7 });
    expect(transitionVerification(state, { type: "terminalPersisted" })).toEqual({
      next: state,
      effects: [
        { kind: "deleteMessage", messageId: 7 },
        { kind: "kickMember" },
      ],
    });
    expect(state.effectStarted).toBeTrue();
    expect(transitionVerification(state, { type: "terminalPersisted" }).effects).toEqual([]);
  });

  test("只有当前 KICK_PENDING 才转为 KICKED 并从结算时刻开始去重", () => {
    const state = kickPendingState();
    const settled = transitionVerification(state, { type: "kickSettled", now: 5_000 });
    expect(settled.next).toEqual({
      kind: "kicked",
      label: "杂鱼A",
      isBot: false,
      kickedAt: 5_000,
    });
    expect(settled.effects).toEqual([]);

    const replacement = pendingState();
    expect(
      transitionVerification(replacement, { type: "kickSettled", now: 6_000 }).next
    ).toBe(replacement);
  });

  test("kickRetry 只为尚未执行的 KICK_PENDING 重新产生踢人效果", () => {
    const state = kickPendingState();
    expect(transitionVerification(state, { type: "kickRetry" })).toEqual({
      next: state,
      effects: [{ kind: "kickMember" }],
    });
    expect(state.effectStarted).toBeTrue();

    // 上一轮踢人效果还在执行（效果门已开）时，重复的 kickRetry 不再产生第二次效果。
    expect(transitionVerification(state, { type: "kickRetry" })).toEqual({
      next: state,
      effects: [],
    });

    state.effectStarted = false;
    state.executionStarted = true;
    expect(transitionVerification(state, { type: "kickRetry" })).toEqual({
      next: state,
      effects: [],
    });
    expect(
      transitionVerification(pendingState(), { type: "kickRetry" }).effects
    ).toEqual([]);
  });

  test("踢人请求发出后豁免无法撤销；请求失败后豁免又能替换 token，本轮尝试仍占着效果门", () => {
    const state = kickPendingState({ requestedAt: 12_345, countedJoinAt: 12_345 });
    transitionVerification(state, { type: "terminalPersisted" });

    expect(transitionVerification(state, { type: "kickRequestSent", attemptState: state }))
      .toEqual({ next: state, effects: [] });
    expect(state.executionStarted).toBeTrue();
    expect(transitionVerification(state, joinEvent({ identityExempt: true }))).toEqual({
      next: state,
      effects: [{ kind: "logUncancelableKickExemption", label: "杂鱼A" }],
    });

    expect(transitionVerification(state, { type: "kickRequestFailed", attemptState: state }))
      .toEqual({ next: state, effects: [] });
    expect(state.executionStarted).toBeFalse();
    expect(state.effectStarted).toBeTrue();
    expect(transitionVerification(state, { type: "kickRetry" }).effects).toEqual([]);
    expect(transitionVerification(state, joinEvent({ identityExempt: true }))).toEqual({
      next: { kind: "exempt", label: "杂鱼A", isBot: false },
      effects: [{ kind: "retractJoinCount", joinedAt: 12_345 }],
    });
  });

  test("terminalAttemptUnsettled 复位执行门，到点的重试事件能重新发出动作", () => {
    const kickPending = kickPendingState();
    transitionVerification(kickPending, { type: "terminalPersisted" });
    transitionVerification(kickPending, { type: "kickRequestSent", attemptState: kickPending });
    expect(transitionVerification(kickPending, { type: "terminalAttemptUnsettled", attemptState: kickPending }))
      .toEqual({ next: kickPending, effects: [] });
    expect(kickPending.effectStarted).toBeFalse();
    expect(kickPending.executionStarted).toBeFalse();
    expect(transitionVerification(kickPending, { type: "kickRetry" }).effects).toEqual([{ kind: "kickMember" }]);

    const checking = checkingInviterOf(7, snapshotOf(pendingState()));
    expect(transitionVerification(checking, { type: "terminalPersisted" }).effects)
      .toEqual([{ kind: "recheckInviter", inviterId: 7, snapshot: checking.snapshot }]);
    expect(transitionVerification(checking, { type: "terminalPersisted" }).effects).toEqual([]);
    transitionVerification(checking, { type: "terminalAttemptUnsettled", attemptState: checking });
    expect(checking.executionStarted).toBeFalse();
    expect(transitionVerification(checking, { type: "terminalPersisted" }).effects)
      .toEqual([{ kind: "recheckInviter", inviterId: 7, snapshot: checking.snapshot }]);

    // flood 终态退回未执行后，权威评论区确认重新可以撤回它。
    const flood = expellingOf("flood", snapshotOf(pendingState()));
    transitionVerification(flood, { type: "terminalPersisted" });
    const comment = {
      type: "confirmedThreadComment",
      messageId: 46,
      now: 10_000,
      allowFloodTerminalExemption: true,
    } as const;
    expect(transitionVerification(flood, comment).next).toBe(flood);
    transitionVerification(flood, { type: "terminalAttemptUnsettled", attemptState: flood });
    expect(transitionVerification(flood, comment).next?.kind).toBe("exempt");
  });

  test("执行门事件只作用于发起尝试的那个状态对象，已换代的 token 不改当前记录", () => {
    const stale = kickPendingState();
    const current = kickPendingState({ effectStarted: true, executionStarted: true });
    for (const type of ["kickRequestSent", "kickRequestFailed", "terminalAttemptUnsettled"] as const) {
      expect(transitionVerification(current, { type, attemptState: stale }))
        .toEqual({ next: current, effects: [] });
      expect(transitionVerification(undefined, { type, attemptState: stale }))
        .toEqual({ next: undefined, effects: [] });
    }
    expect(current.effectStarted).toBeTrue();
    expect(current.executionStarted).toBeTrue();

    const terminal = expellingOf("timeout", snapshotOf(pendingState()));
    terminal.executionStarted = true;
    transitionVerification(terminal, {
      type: "terminalAttemptUnsettled",
      attemptState: expellingOf("timeout", snapshotOf(pendingState())),
    });
    expect(terminal.executionStarted).toBeTrue();
  });
});

describe("callback", () => {
  type CallbackOverrides = Partial<{
    action: "self" | "approve";
    isSelf: boolean;
    fromCanApprove: boolean | undefined;
  }>;
  const cb = (overrides: CallbackOverrides = {}) =>
    ({
      type: "callback",
      callbackQueryId: "q1",
      action: "self",
      isSelf: true,
      fromCanApprove: false,
      fromLabel: "点击者",
      ...overrides,
    }) as const;
  const answer = (
    reply: "ok" | "invalid" | "notYourButton" | "useSelfButton" | "notApprover" | "approverUnknown"
  ) => [{ kind: "answerCallback" as const, callbackQueryId: "q1", reply }];

  test("本人点「我是良民」→ 通过：清记录 + 应答 + 删提醒 + 欢迎", () => {
    const state = pendingState({ reminderMessageId: 30, welcomeAnchorMessageId: 40 });
    const { next, effects } = transitionVerification(state, cb());
    expect(next).toBeUndefined();
    expect(effects).toEqual([
      { kind: "answerCallback", callbackQueryId: "q1", reply: "ok" },
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "sendWelcome", variant: "verified", targetLabel: "杂鱼A", fromLabel: "点击者", anchorMessageId: 40 },
    ]);
  });

  test("别人点「我是良民」→ 驳回，状态不动；管理员也不例外", () => {
    const state = pendingState();
    for (const fromCanApprove of [false, true]) {
      const { next, effects } = transitionVerification(state, cb({ isSelf: false, fromCanApprove }));
      expect(next).toBe(state);
      expect(effects).toEqual(answer("notYourButton"));
    }
  });

  test("管理员点「通过」→ 以作保通过；真人与机器人各有欢迎语", () => {
    const human = pendingState({ reminderMessageId: 30, welcomeAnchorMessageId: 40 });
    const approvedHuman = transitionVerification(human, cb({ action: "approve", isSelf: false, fromCanApprove: true }));
    expect(approvedHuman.next).toBeUndefined();
    expect(approvedHuman.effects).toEqual([
      { kind: "answerCallback", callbackQueryId: "q1", reply: "ok" },
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "sendWelcome", variant: "approved", targetLabel: "杂鱼A", fromLabel: "点击者", anchorMessageId: 40 },
    ]);

    const bot = pendingState({ isBot: true });
    const approvedBot = transitionVerification(bot, cb({ action: "approve", isSelf: false, fromCanApprove: true }));
    expect(approvedBot.next).toBeUndefined();
    expect(approvedBot.effects[2]).toMatchObject({ kind: "sendWelcome", variant: "vouchedBot" });
  });

  test("非管理员点「通过」→ 驳回，机器人目标也一样", () => {
    for (const state of [pendingState(), pendingState({ isBot: true })]) {
      const { next, effects } = transitionVerification(state, cb({ action: "approve", isSelf: false }));
      expect(next).toBe(state);
      expect(effects).toEqual(answer("notApprover"));
    }
  });

  test("本人点「通过」→ 提示改点「我是良民」，即使本人有管理员身份", () => {
    const state = pendingState();
    for (const fromCanApprove of [false, true]) {
      const { next, effects } = transitionVerification(state, cb({ action: "approve", isSelf: true, fromCanApprove }));
      expect(next).toBe(state);
      expect(effects).toEqual(answer("useSelfButton"));
    }
  });

  test("管理员身份没查出来 → 只应答稍后再试，记录不动", () => {
    const state = pendingState();
    const { next, effects } = transitionVerification(
      state,
      cb({ action: "approve", isSelf: false, fromCanApprove: undefined })
    );
    expect(next).toBe(state);
    expect(effects).toEqual(answer("approverUnknown"));
  });

  test("记录已不在（已通过/已踢/已豁免）→ 两颗按钮都只应答失效", () => {
    for (const state of [undefined, { kind: "exempt", label: "杂鱼A", isBot: false } as VerificationState]) {
      for (const event of [cb(), cb({ action: "approve", isSelf: false, fromCanApprove: true })]) {
        const { next, effects } = transitionVerification(state, event);
        expect(next).toBe(state);
        expect(effects).toEqual(answer("invalid"));
      }
    }
  });
});

describe("超时与拉人者终核", () => {
  test("提醒从未成功落地时不踢人，延长完整窗口并重发原始提醒", () => {
    const state = pendingState({ expiresAt: 1_000 });
    const result = transitionVerification(state, { type: "verifyTimeout", now: 2_000 });

    expect(result.next).toBe(state);
    expect(state.expiresAt).toBe(2_000 + VERIFICATION_TIMEOUT_MS);
    expect(result.effects).toEqual([{ kind: "sendReminder", label: "杂鱼A", isBot: false }]);
    expect(result.snapshotChanged).toBeTrue();
    expect(result.rescheduleTimer).toBeTrue();
  });

  test("已请求回复式提醒但未落地时，续窗后仍只补发回复式提醒", () => {
    const state = pendingState({
      replyReminderRequested: true,
      reminderSuperseded: true,
      welcomeAnchorMessageId: 88,
    });
    const result = transitionVerification(state, { type: "verifyTimeout", now: 2_000 });

    expect(result.next).toBe(state);
    expect(result.effects).toEqual([{ kind: "sendReplyReminder", label: "杂鱼A", isBot: false, targetMessageId: 88 }]);
    expect(state.expiresAt).toBe(2_000 + VERIFICATION_TIMEOUT_MS);
  });

  test("机器人成员已请求回复式提醒但未落地时，续窗后补发的回复式提醒携带 isBot: true", () => {
    const state = pendingState({
      isBot: true,
      replyReminderRequested: true,
      reminderSuperseded: true,
      welcomeAnchorMessageId: 89,
    });
    const result = transitionVerification(state, { type: "verifyTimeout", now: 2_000 });

    expect(result.next).toBe(state);
    expect(result.effects).toEqual([{ kind: "sendReplyReminder", label: "杂鱼A", isBot: true, targetMessageId: 89 }]);
    expect(state.expiresAt).toBe(2_000 + VERIFICATION_TIMEOUT_MS);
  });

  test("提醒一直发不出去时续期有尽头，超过总时长按普通超时结算", () => {
    const state = pendingState({ joinedAt: 1_000 });
    const late: number = 1_000 + VERIFICATION_REMINDER_UNDELIVERED_MAX_MS;

    const { next, effects } = transitionVerification(state, { type: "verifyTimeout", now: late });
    expect(next).toMatchObject({ kind: "expelling", reason: "timeout" });
    expect(effects).toEqual([]);

    // 上限之内照常续期。
    const fresh = pendingState({ joinedAt: 1_000 });
    expect(transitionVerification(fresh, { type: "verifyTimeout", now: late - 1 }).next).toBe(fresh);
  });

  test("超时且非被拉入群 → 先持久化 expelling，再收尾踢人；成功播报落盘后收到 terminalPersisted 直接清除", () => {
    const state = pendingState({ reminderMessageId: 2 });
    const { next, effects } = transitionVerification(state, { type: "verifyTimeout", now: 120_000 });
    expect(next).toMatchObject({ kind: "expelling", reason: "timeout", snapshot: { reminderMessageId: 2 } });
    expect(effects).toEqual([]);
    expect(effectKinds(transitionVerification(next, { type: "terminalPersisted" }).effects)).toEqual(["expel"]);
    expect(transitionVerification(next, { type: "terminalPersisted" }).effects).toEqual([]);
    const noticeSent = transitionVerification(next, { type: "expelNoticeSent", notice: "success" }).next;
    expect(noticeSent).toMatchObject({ kind: "expelling", executionStarted: true, successNoticeSent: true });
    expect(transitionVerification(noticeSent, { type: "terminalPersisted" })).toEqual({
      next: undefined,
      effects: [],
    });
  });

  test("超时且被拉入群 → 先持久化 checkingInviter，再做终核", () => {
    const state = pendingState({ invitedBy: 999, reminderMessageId: 30 });
    const { next, effects } = transitionVerification(state, { type: "verifyTimeout", now: 120_000 });
    expect(next).toMatchObject({ kind: "checkingInviter", inviterId: 999 });
    expect(effects).toEqual([]);
    expect(transitionVerification(next, { type: "terminalPersisted" }).effects[0]).toMatchObject({ kind: "recheckInviter", inviterId: 999 });
    expect(transitionVerification(next, { type: "terminalPersisted" }).effects).toEqual([]);
  });

  test("终核：拉人者确是管理员 → 补豁免占位，只删提醒不踢人，且按精确时刻撤销此前记的那次刷群计数", () => {
    const snapshot = { label: "杂鱼A", isBot: false, announcementMessageId: undefined, reminderMessageId: 30, replyReminderMessageId: undefined, joinedAt: 54_321, expiresAt: 120_000 };
    const checking: VerificationState = checkingInviterOf(999, snapshot);
    const { next, effects } = transitionVerification(checking, { type: "timeoutInviterVerdict", inviterIsAdmin: true });
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "retractJoinCount", joinedAt: 54_321 },
    ]);
  });

  test("终核：等待期间已有新记录 → 不覆盖它", () => {
    const fresh = pendingState({ label: "重新进群的同一人" });
    const { next } = transitionVerification(fresh, { type: "timeoutInviterVerdict", inviterIsAdmin: true });
    expect(next).toBe(fresh);
  });

  test("终核：拉人者不是管理员 → 先持久化 expelling，再收尾踢人", () => {
    const snapshot = { label: "杂鱼A", isBot: false, announcementMessageId: undefined, reminderMessageId: undefined, replyReminderMessageId: undefined, joinedAt: 0, expiresAt: 120_000 };
    const checking: VerificationState = checkingInviterOf(999, snapshot);
    const { next, effects } = transitionVerification(checking, { type: "timeoutInviterVerdict", inviterIsAdmin: false });
    expect(next).toMatchObject({ kind: "expelling", reason: "timeout", snapshot });
    expect(effects).toEqual([]);
  });

  test("终核：拉人者不是管理员，但等待期间已有新记录 → 不踢、不覆盖它", () => {
    const fresh = pendingState({ label: "重新进群的同一人" });
    const { next, effects } = transitionVerification(fresh, { type: "timeoutInviterVerdict", inviterIsAdmin: false });
    expect(next).toBe(fresh);
    expect(effectKinds(effects)).not.toContain("expel");
    expect(effects).toEqual([]);
  });
});

describe("异步核查通过 / 离群 / 提醒回填 / 去重到期", () => {
  test("adminCheckResolved → 转 EXEMPT + 删提醒 + 按精确时刻撤销此前记的那次刷群计数", () => {
    const state = pendingState({ reminderMessageId: 30, joinedAt: 99_999 });
    const { next, effects } = transitionVerification(state, { type: "adminCheckResolved" });
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "retractJoinCount", joinedAt: 99_999 },
    ]);
  });

  test("待验证中途离群 → 删记录 + 只删提醒（公告/发言不动）", () => {
    const state = pendingState({ reminderMessageId: 30 });
    const { next, effects } = transitionVerification(state, { type: "left" });
    expect(next).toBeUndefined();
    expect(effects).toEqual([{ kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined }]);
  });

  test("占位记录离群 → 删记录，无可删提醒", () => {
    const { next, effects } = transitionVerification(kickedState(), { type: "left" });
    expect(next).toBeUndefined();
    expect(effects).toEqual([]);
  });

  test("原始提醒落地回填", () => {
    const state = pendingState();
    const result = transitionVerification(state, { type: "reminderLanded", reminderKind: "original", messageId: 30, now: 1_000 });
    expect(state.reminderMessageId).toBe(30);
    expect(state.expiresAt).toBe(1_000 + VERIFICATION_TIMEOUT_MS);
    expect(result.snapshotChanged).toBeTrue();
    expect(result.rescheduleTimer).toBeTrue();
  });

  test("原始提醒落地时已被取代 → 落地即自删", () => {
    const state = pendingState({ reminderSuperseded: true });
    const { effects } = transitionVerification(state, { type: "reminderLanded", reminderKind: "original", messageId: 30, now: 1_000 });
    expect(effects).toEqual([{ kind: "deleteMessage", messageId: 30 }]);
    expect(state.reminderMessageId).toBeUndefined();
  });

  test("回复式提醒落地回填不受取代标记影响", () => {
    const state = pendingState({ reminderSuperseded: true });
    const result = transitionVerification(state, { type: "reminderLanded", reminderKind: "reply", messageId: 31, now: 1_000 });
    expect(state.replyReminderMessageId).toBe(31);
    expect(result.snapshotChanged).toBeTrue();
    expect(result.rescheduleTimer).toBeTrue();
  });

  test("original/reply 提醒只回填各自显式 id，不创建混合消息列表", () => {
    for (const reminderKind of ["original", "reply"] as const) {
      const state = pendingState();

      transitionVerification(state, {
        type: "reminderLanded",
        reminderKind,
        messageId: 9_999,
        now: 1_000,
      });

      expect("messageIds" in state).toBeFalse();
      expect(
        reminderKind === "original"
          ? state.reminderMessageId
          : state.replyReminderMessageId
      ).toBe(9_999);
    }
  });

  test("guardDisabled：PENDING 停止触发，并清理已经失效的验证按钮", () => {
    // 主动关闭后按钮不再有有效 owner，由这条状态机路径删除；入群公告和成员自己的消息不在 effect 里，关闭功能不清理群成员内容。
    const state = pendingState({ reminderMessageId: 11, replyReminderMessageId: 12 });

    const { next, effects } = transitionVerification(state, { type: "guardDisabled" });

    expect(next).toBeUndefined();
    expect(effects).toEqual([{
      kind: "deleteReminders",
      reminderMessageId: 11,
      replyReminderMessageId: 12,
    }]);
  });

  test("guardDisabled：两段处置终态一并作废，不再踢人", () => {
    // 处置终态是「已经决定要踢、正等落盘回执」：开关关掉之后不踢人，返回 undefined 让解释器发 tombstone，重启也不复活。
    const snapshot = {
      label: "杂鱼A",
      isBot: false,
      announcementMessageId: undefined,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
      joinedAt: 0,
      expiresAt: 120_000,
    };

    for (const state of [
      checkingInviterOf(7, snapshot),
      expellingOf("timeout", snapshot),
    ]) {
      const { next, effects } = transitionVerification(state, { type: "guardDisabled" });

      expect(next).toBeUndefined();
      expect(effects).toEqual([{
        kind: "deleteReminders",
        reminderMessageId: 21,
        replyReminderMessageId: 22,
      }]);
    }
  });

  test("回归：新入群取代终态记录时，先删掉旧记录留下的验证提醒", () => {
    // 旧记录被替换后，它的 expel 收尾因对象同一性复核不过而整段跳过；替换发生时由这条转移路径直接发出 deleteReminders。
    const snapshot = {
      label: "杂鱼A",
      isBot: false,
      announcementMessageId: undefined,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
      joinedAt: 0,
      expiresAt: 120_000,
    };

    for (const state of [
      checkingInviterOf(7, snapshot),
      expellingOf("timeout", snapshot),
    ]) {
      const { next, effects } = transitionVerification(state, joinEvent({ now: 500_000 }));

      expect(next?.kind).toBe("pending");
      expect(effects[0]).toEqual({
        kind: "deleteReminders",
        reminderMessageId: 21,
        replyReminderMessageId: 22,
      });
    }
  });

  test("guardDisabled：内存态与 ABSENT 都直接清空，不产生副作用", () => {
    for (const state of [
      undefined,
      { kind: "exempt", label: "杂鱼A", isBot: false } as const,
      kickedState(),
      kickPendingState(),
    ]) {
      const { next, effects } = transitionVerification(state, { type: "guardDisabled" });

      expect(next).toBeUndefined();
      expect(effects).toEqual([]);
    }
  });

  test("去重窗口到期 → 占位清除；PENDING 不受影响", () => {
    expect(transitionVerification({ kind: "exempt", label: "杂鱼A", isBot: false }, { type: "dedupeExpired" }).next).toBeUndefined();
    const state = pendingState();
    expect(transitionVerification(state, { type: "dedupeExpired" }).next).toBe(state);
  });
});
