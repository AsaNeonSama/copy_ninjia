import type { JoinEvent, PendingState, VerificationState } from "../../packages/types/states/verification";

/**
 * 造一个 join 事件，默认是「自主入群、无豁免、无锁定」，用覆盖项表达各场景。
 * @param overrides 需要覆盖的入群事件字段。
 * @returns 构造出的 JoinEvent。
 */
export function joinEvent(overrides: Partial<JoinEvent> = {}): JoinEvent {
  return {
    type: "join",
    memberId: 100,
    label: "杂鱼A",
    isBot: false,
    identityExempt: false,
    actorSyncExempt: false,
    adminCacheFresh: false,
    lockdownActive: false,
    now: 0,
    ...overrides,
  };
}

/**
 * 造一个已踢占位状态。
 * @param overrides 需要覆盖的 kicked 状态字段。
 * @returns 构造出的 VerificationState。
 */
export function kickedState(
  overrides: Partial<VerificationState & { kind: "kicked" }> = {}
): VerificationState {
  return { kind: "kicked", label: "杂鱼A", isBot: false, kickedAt: 0, ...overrides };
}

/**
 * 造一个私密模式待踢状态。
 * @param overrides 需要覆盖的 kickPending 状态字段。
 * @returns 构造出的 kickPending 状态。
 */
export function kickPendingState(
  overrides: Partial<VerificationState & { kind: "kickPending" }> = {}
): VerificationState & { kind: "kickPending" } {
  return {
    kind: "kickPending",
    label: "杂鱼A",
    isBot: false,
    requestedAt: 0,
    countedJoinAt: undefined,
    announcementMessageId: undefined,
    effectStarted: false,
    executionStarted: false,
    ...overrides,
  };
}

/**
 * 造一个待验证状态。
 * @param overrides 需要覆盖的 pending 状态字段。
 * @returns 构造出的 PendingState。
 */
export function pendingState(overrides: Partial<PendingState> = {}): PendingState {
  return {
    kind: "pending",
    label: "杂鱼A",
    isBot: false,
    announcementMessageId: undefined,
    invitedBy: undefined,
    reminderMessageId: undefined,
    replyReminderMessageId: undefined,
    replyReminderRequested: false,
    welcomeAnchorMessageId: undefined,
    reminderSuperseded: false,
    joinedAt: 0,
    expiresAt: 120_000,
    ...overrides,
    trackedMessageTimes: overrides.trackedMessageTimes ?? [],
  };
}

/**
 * 提取副作用列表中的 kind 名称序列。
 * @param effects 副作用数组。
 * @returns kind 字符串数组。
 */
export function effectKinds(effects: readonly { kind: string }[]): string[] {
  return effects.map((effect: { kind: string }): string => effect.kind);
}
