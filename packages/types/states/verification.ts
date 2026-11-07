/**
 * 入群验证状态机的契约：状态、事件、效果与转移结果。
 *
 * 状态对象的缺省字段一律写成必填的 `T | undefined`，不用 `field?:`：每个构造点一次写全，
 * 同一个 kind 的对象形状恒定（见 docs/cn/04-invariants.md，口径同
 * types/aiChat/speaker.ts 与 workers/aiChat/bufferedMessage.ts），构造顺序由声明顺序固定。
 * 除 pending 外各 kind 的构造统一收在 states/verification/shared.ts（exemptOf、
 * kickPendingOf、kickedOf、checkingInviterOf、expellingOf），adopt 重建与状态机新建共用
 * 同一份；pending 以同一字段顺序的对象字面量分别构造于 states/verification/join.ts（新建）
 * 与 adopt.ts（重建）。值为 undefined 的字段在
 * `JSON.stringify` 时照常省略。
 *
 * 事件与 VerificationTransition 是每次转移现造现用的短命对象，不适用本条。
 */

/** 早于入群更新到达、被暂存下来的评论区留言。 */
export interface RecentComment {
  messageId: number;
}

/** 正在等待点击验证按钮的成员。 */
export interface PendingState {
  kind: "pending";
  label: string;
  isBot: boolean;
  /**
   * 入群公告的消息 id（机器人自己制造的那条痕迹）。
   */
  announcementMessageId: number | undefined;
  /** 最近 JOIN_WINDOW_MS 内由该成员发送的消息时间。 */
  trackedMessageTimes: number[];
  /** 被他人拉入群时的拉人者 ID；超时前要做最终管理员核查。 */
  invitedBy: number | undefined;
  reminderMessageId: number | undefined;
  replyReminderMessageId: number | undefined;
  replyReminderRequested: boolean;
  welcomeAnchorMessageId: number | undefined;
  reminderSuperseded: boolean;
  /** 创建记录的入群时刻，也是刷群窗口中待精确撤销的时间戳。 */
  joinedAt: number;
  /** 验证结束的绝对毫秒时刻；恢复时据此重建剩余时间。 */
  expiresAt: number;
}

/** 已豁免的短期去重占位。 */
export interface ExemptState {
  kind: "exempt";
  label: string;
  isBot: boolean;
}

/** 私密模式踢人尚未发出或仍在途；状态替换会使未发出的动作失效。 */
export interface KickPendingState {
  kind: "kickPending";
  label: string;
  isBot: boolean;
  /** 与 announcementMessageId 一起区分同一次入群的重复投递与真正重新入群（见 states/verification/join.ts 的 isKickRejoin）。 */
  requestedAt: number;
  /**
   * 本次入群计入刷群统计时用的那个时间戳；没计过数时为 undefined。
   *
   * 只有 joinCreatesNewRecord 为真的那次入群才由调用方 recordJoin；撤销只使用本字段，
   * 不使用 requestedAt，按值删除队列里第一个相等的时间戳（见 packages/libs/timestampDeque.ts
   * 的 removeValue）。
   */
  countedJoinAt: number | undefined;
  /** 入群公告 id；首次动作须在落盘回执后先清理该痕迹再踢人。携带同号公告的投递恒按同一次入群去重。 */
  announcementMessageId: number | undefined;
  /**
   * 本轮踢人尝试已开始（kickMember 已派发、尚未结算或排上重试）。Worker 本地幂等门，不持久化，
   * 重建后允许安全重放；只经状态机改写：terminalPersisted 与 kickRetry 置位，terminalAttemptUnsettled 复位。
   */
  effectStarted: boolean;
  /**
   * Telegram 踢人请求已同步发出，之后到达的豁免已无法撤销这次调用。Worker 本地，不持久化；只经状态机
   * 改写：kickRequestSent 置位，kickRequestFailed 与 terminalAttemptUnsettled 复位。
   */
  executionStarted: boolean;
}

/** 私密模式踢人请求已经结算后的短期去重占位。 */
export interface KickedState {
  kind: "kicked";
  label: string;
  isBot: boolean;
  /** 用于区分同一次入群的双路投递与真正重新入群。 */
  kickedAt: number;
}

/** 供终核与最终清理使用的不可变语义快照。 */
export interface ExpelSnapshot {
  readonly label: string;
  readonly isBot: boolean;
  /** 入群公告 id；只清理机器人/Telegram 制造的验证痕迹，不删除成员发言。 */
  readonly announcementMessageId: number | undefined;
  readonly reminderMessageId: number | undefined;
  readonly replyReminderMessageId: number | undefined;
  readonly joinedAt: number;
  readonly expiresAt: number;
}

/** 已持久化后才可执行拉人者终核；Worker/进程重建会继续本阶段。 */
export interface CheckingInviterState {
  kind: "checkingInviter";
  inviterId: number;
  snapshot: ExpelSnapshot;
  /**
   * 本轮终核已开始。Worker 本地幂等门，不持久化，构造与重建时为 false，Worker 重建后允许安全重放；
   * 只经状态机改写：terminalPersisted 置位，terminalAttemptUnsettled 复位。
   */
  executionStarted: boolean;
}

/**
 * expelling 终态的处置原因：`timeout` 验证超时，`flood` 待验证期刷屏，`wrongAnswer` 本人选错算术题答案。
 * 随快照持久化为 `expelReason`（见 types/antiRaid/verification.ts）。
 */
export type VerificationExpelReason = "timeout" | "flood" | "wrongAnswer";

/** 已持久化后才可执行验证痕迹清理/踢人；这些 API 均按幂等方式重放。 */
export interface ExpellingState {
  kind: "expelling";
  reason: VerificationExpelReason;
  snapshot: ExpelSnapshot;
  /**
   * 本轮处置已开始；flood 终态开始执行后不再接受评论区豁免。Worker 本地幂等门，不持久化，构造与
   * 重建时为 false，Worker 重建后允许安全重放；只经状态机改写：terminalPersisted 置位，
   * terminalAttemptUnsettled 复位。
   */
  executionStarted: boolean;
  /**
   * 「想踢却踢不动」（缺 can_restrict_members）这条告警已发送。
   *
   * 与 unconfirmedNoticeSent 各自独立记录，两条告警互不占用名额。随快照持久化，
   * Worker 重生/进程重启后不重发；发出去的那条消息本身走统一临时发送边界，到期自删
   * （见 workers/antiRaid/verificationEffects/terminal.ts 调用 infra/telegram/workerClient.ts 的 sendTemporaryMessageFromMain）。
   */
  failureNoticeSent: true | undefined;
  /** 「没能确认成员是否仍在群里或群类型」告警已发送；语义同 failureNoticeSent。 */
  unconfirmedNoticeSent: true | undefined;
  /**
   * 成功播报已经发出并进入持久化快照。落盘确认后可直接结束终态，Worker
   * 重建不再重放踢人、删消息和成功播报。
   */
  successNoticeSent: true | undefined;
  /**
   * 踢人请求已被 Telegram 确认成功，但那条成功播报还没发出去。
   *
   * 随快照持久化，只在播报发送失败时写（正常一轮里踢人与播报同轮结算）。
   * 下一轮据此把成员探测得到的「不在群里」认作本机器人踢人成功，继续发送成功播报。
   */
  removalConfirmed: true | undefined;
}

/** pending 超时、刷屏或答错之后的两段处置终态；都持有冻结的 ExpelSnapshot。 */
export type VerificationExpelState = CheckingInviterState | ExpellingState;
/**
 * 落盘回执到达后才执行动作的终态：私密模式秒踢与两段处置终态。与 states/verification/shared.ts 的
 * isTerminalVerificationPhase 判定同一组 kind。
 */
export type VerificationTerminalState = KickPendingState | VerificationExpelState;
/** 入群验证状态机单个（群, 用户）条目的状态联合。 */
export type VerificationState =
  | PendingState
  | ExemptState
  | KickedState
  | VerificationTerminalState;

/**
 * 一次入群的豁免结论（states/verification/join.ts 的 resolveJoinExemption）；各组合各有
 * 一份共享只读常量（consts/antiRaid/verification.ts），调用方只读字段。
 */
export interface JoinExemption {
  readonly exempt: boolean;
  readonly viaChannelComment: boolean;
}

/** 新成员入群（chat_member 权威更新或入群服务消息）触发的验证状态机事件。 */
export interface JoinEvent {
  type: "join";
  memberId: number;
  label: string;
  isBot: boolean;
  announcementMessageId?: number;
  /** undefined 或 memberId 表示自主入群，否则是拉人者。 */
  actorId?: number;
  identityExempt: boolean;
  actorSyncExempt: boolean;
  /** 管理员缓存是否未过期；决定是否还需异步核查。 */
  adminCacheFresh: boolean;
  /** 必须在 recordJoin 可能触发锁定之后读取。 */
  lockdownActive: boolean;
  recentComment?: RecentComment;
  now: number;
}

/** 待验证成员在群内发出一条被追踪发言时触发的状态机事件。 */
export interface TrackedMessageEvent {
  type: "trackedMessage";
  messageId: number;
  inCommentThread: boolean;
  now: number;
}

/** 冷缓存 getChat 回来后，对精确状态 token 投递的权威评论区确认。 */
export interface ConfirmedThreadCommentEvent {
  type: "confirmedThreadComment";
  messageId: number;
  now: number;
  /** 只允许撤回由本 owner 覆盖消息同步触发、且尚未开始执行的 flood 终态。 */
  allowFloodTerminalExemption: boolean;
}

/**
 * 本人作答按钮所选数值与 Worker 运行态缓存题目的比对结论：`correct` 答对，`wrong` 答错，
 * `missing` 本条验证当前没有缓存题目（Worker 重建或同代重放后运行态条目已重建）。
 */
export type VerificationAnswerVerdict = "correct" | "wrong" | "missing";

/** 验证按钮点击事件两种按钮共有的字段。 */
interface VerificationCallbackEventBase {
  type: "callback";
  callbackQueryId: string;
  /** 点击者就是待验证成员本人（由可信的 callback_query.from.id 算出）。 */
  isSelf: boolean;
  /**
   * 点击者是否为本群非匿名管理员（唯一的代点资格）。
   * `undefined` 表示身份没查出来，状态机只应答「稍后再试」，不改记录。
   */
  fromCanApprove: boolean | undefined;
  fromLabel: string;
}

/** 本人作答按钮（算术题选项）的点击，只认本人。 */
export interface SelfAnswerCallbackEvent extends VerificationCallbackEventBase {
  action: "self";
  /** 按钮所在消息 ID；只认 pending 当前登记的提醒消息，Telegram 未给出消息时为 undefined。 */
  messageId: number | undefined;
  /** 所选数值与 Worker 运行态缓存题目的比对结论。 */
  answerVerdict: VerificationAnswerVerdict;
}

/** 「通过」按钮的点击，只认代点资格。 */
export interface ApproveCallbackEvent extends VerificationCallbackEventBase {
  action: "approve";
}

/** 验证按钮点击；`action` 区分本人作答与「通过」两类按钮。 */
export type VerificationCallbackEvent = SelfAnswerCallbackEvent | ApproveCallbackEvent;

/** 入群验证倒计时到期事件。 */
export interface VerifyTimeoutEvent {
  type: "verifyTimeout";
  now: number;
}

/** 超时或刷屏进入 checkingInviter 后，拉人者是否为群管理员的终核结论事件。 */
export interface TimeoutInviterVerdictEvent {
  type: "timeoutInviterVerdict";
  inviterIsAdmin: boolean;
}

/** 私密模式踢人请求即将同步发出（kickRequestSent），或已返回但没有结算（kickRequestFailed）。 */
export interface KickRequestEvent {
  type: "kickRequestSent" | "kickRequestFailed";
  /** 发起这次踢人时捕获的执行 token；条目已换成别的状态对象时转移不生效。 */
  attemptState: KickPendingState;
}

/** 本轮终态动作没有结算、解释器即将按退避排一次重试。 */
export interface TerminalAttemptUnsettledEvent {
  type: "terminalAttemptUnsettled";
  /** 发起这一轮尝试时捕获的执行 token；条目已换成别的状态对象时转移不生效。 */
  attemptState: VerificationTerminalState;
}

/** 入群验证按钮提示消息（首次提示或回复提示）在 Telegram 成功落地后的回执事件。 */
export interface ReminderLandedEvent {
  type: "reminderLanded";
  reminderKind: "original" | "reply";
  messageId: number;
  now: number;
}

/** 驱逐播报的三类：成功处置、踢不动、没能确认；各对应 ExpellingState 的一个持久标记。 */
export type ExpelNoticeKind = "success" | "failure" | "unconfirmed";

/** 驱动入群验证状态机（packages/states/verification.ts）转移的输入事件联合。 */
export type VerificationEvent =
  | JoinEvent
  | { type: "left" }
  /**
   * 本群的入群守卫被 `/antiraid disable` 关掉了（见 commands/antiRaid.ts）。
   *
   * 与 `left` 的区别：`left` 是这个成员离开了群，验证自然作废；本事件是功能本身被关掉，
   * 每一种状态都就地收摊，包括已经落盘、正等着执行的各终态，不再踢人。
   */
  | { type: "guardDisabled" }
  | TrackedMessageEvent
  | ConfirmedThreadCommentEvent
  | VerificationCallbackEvent
  | { type: "adminCheckResolved" }
  | VerifyTimeoutEvent
  | { type: "terminalPersisted" }
  /** 本进程执行预算耗尽或当前执行许可无法确认；保留磁盘快照并延后至进程重启。 */
  | { type: "terminalAttemptBudgetExhausted" }
  | TimeoutInviterVerdictEvent
  | { type: "expelSettled" }
  /** 驱逐播报已发出：expelling 终态置位 notice 对应的标记并发布快照，其余状态不变。 */
  | { type: "expelNoticeSent"; notice: ExpelNoticeKind }
  /** 踢人已确认成功、成功播报未发出：expelling 终态记下 removalConfirmed 并发布快照，其余状态不变。 */
  | { type: "removalConfirmed" }
  | { type: "kickRetry" }
  | KickRequestEvent
  | TerminalAttemptUnsettledEvent
  | { type: "kickSettled"; now: number }
  | ReminderLandedEvent
  | { type: "dedupeExpired" };

/** 状态机只描述意图；antiRaid Worker 按顺序解释这些副作用。 */
export type VerificationEffect =
  | { kind: "deleteMessage"; messageId: number }
  | { kind: "kickMember" }
  | { kind: "sendReminder"; label: string; isBot: boolean }
  | { kind: "sendReplyReminder"; label: string; isBot: boolean; targetMessageId: number }
  | { kind: "sendWelcome"; variant: "verified" | "approved" | "vouchedBot" | "channelComment"; targetLabel: string; fromLabel?: string; anchorMessageId?: number }
  | { kind: "answerCallback"; callbackQueryId: string; reply: "ok" | "invalid" | "notYourButton" | "useSelfButton" | "notApprover" | "approverUnknown" | "staleReminder" | "wrongAnswer" | "challengeRefreshed" }
  | { kind: "deleteReminders"; reminderMessageId?: number; replyReminderMessageId?: number }
  | { kind: "startAdminCheck"; actorId: number }
  | { kind: "logUncancelableKickExemption"; label: string }
  | { kind: "retractJoinCount"; joinedAt: number }
  | { kind: "recheckInviter"; inviterId: number; snapshot: ExpelSnapshot }
  | { kind: "expel"; reason: VerificationExpelReason; snapshot: ExpelSnapshot };

/** 入群验证状态机单步转移的输出：下一状态、待执行副作用及快照/计时器重排标记。 */
export interface VerificationTransition {
  /** undefined = 删除；同一引用 = 原地更新。 */
  next: VerificationState | undefined;
  /** 只读：无副作用时是共享的 NO_VERIFICATION_EFFECTS（consts/antiRaid/verification.ts）。 */
  effects: readonly VerificationEffect[];
  /** 原地修改 pending 或 expelling 状态、需要重发持久化快照时置 true。 */
  snapshotChanged?: boolean;
  /** expiresAt 原地变化时通知解释器重建验证 timer。 */
  rescheduleTimer?: boolean;
  /** 删除 Worker 运行态但保留最后一份持久化快照，不发布 tombstone。 */
  retainPersistedSnapshot?: boolean;
}
