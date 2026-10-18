/**
 * `/gag` 参数渲染、状态机、消息与 inline 入口及定时刷新的替身与工厂。
 *
 * mock.module 装配、会话工厂与隔离钩子由各用例文件共用，各文件只保留领域断言。
 * 每个文件都要在顶层调用一次 installGagTestHooks()。
 */

import { afterEach, beforeEach, jest, mock } from "bun:test";
import { loggerStub } from "./loggerMock";
import type {
  InlineKeyboardMarkup,
  Message,
  MessageEntity,
} from "grammy/types";
import { GAG_THUMBNAIL_URL } from "../../packages/consts/ui/assets";
import type { CachedUser } from "../../packages/types/chatState";
import type { GagSession } from "../../packages/types/gag";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "./botPermissions";
import { replyCommandNoticeVia, settleTestBatch } from "./common";
// 这三个模块不在被替身覆盖的范围内（只依赖 consts/types/libs），静态导入即可；
// 被测的 packages/commands/gag 由各用例文件在本模块的 mock.module 生效之后自行 await import。
import * as identity from "../../packages/commands/gag/identity";
import * as rendering from "../../packages/commands/gag/rendering";
import {
  activeGagSessionCount,
  gagBackgroundTasks,
  gagRuntimeAccepting,
  gagSessionCount,
  gagSessionsByChat,
} from "../../packages/cache/main/gag";
import { inlineResultSources } from "../../packages/cache/main/inlineResultSources";
import { botAtmosphereState } from "../../packages/cache/main/atmosphere";

export {
  activeGagSessionCount,
  gagBackgroundTasks,
  gagSessionCount,
  gagSessionsByChat,
  identity,
  rendering,
};

export interface TextMessageParams {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
  readonly keyboard?: InlineKeyboardMarkup;
  /** 论坛话题落点；General 与非论坛群为 undefined。 */
  readonly messageThreadId?: number;
  readonly onSent?: (messageId: number) => void;
}

export interface EphemeralMessageParams extends TextMessageParams {
  readonly receiverUserId: number;
}

export interface EphemeralDeletionParams {
  readonly chatId: number;
  readonly receiverUserId: number;
  readonly ephemeralMessageId: number;
}

export type InlineResult = Record<string, unknown>;
export type InlineAnswerOptions = Record<string, unknown>;

/** 下列替身的默认实现；声明处与 installGagTestHooks 的 mockReset 之后共用同一份。 */
async function sendCommandMessageStub(_params: TextMessageParams): Promise<number | undefined> {
  return 56;
}
/** 与真实发送边界同一契约：成功时先经 onSent 同步登记 id，再返回同一个 id。 */
async function sendMessageStub(params: TextMessageParams): Promise<number | undefined> {
  params.onSent?.(56);
  return 56;
}
async function sendEphemeralMessageStub(params: EphemeralMessageParams): Promise<number | undefined> {
  params.onSent?.(57);
  return 57;
}
async function deleteEphemeralMessageStub(_params: EphemeralDeletionParams): Promise<string> {
  return "deleted";
}
async function deleteMessageStub(_chatId: number, _messageId: number): Promise<string> {
  return "deleted";
}
async function probeChatMembershipStub(_chatId: number, _userId: number): Promise<boolean | undefined> {
  return true;
}
async function resolveCommandTargetStub(_params: unknown): Promise<CachedUser | undefined> {
  return { id: 7, first_name: "Alice", username: "alice" };
}
async function answerInlineQueryStub(
  _results: readonly InlineResult[],
  _options: InlineAnswerOptions,
  _signal?: unknown
): Promise<void> {}

export const sendCommandMessage = mock(sendCommandMessageStub);
export const sendMessage = mock(sendMessageStub);
export const sendEphemeralMessage = mock(sendEphemeralMessageStub);
export const deleteEphemeralMessageWithOutcome = mock(deleteEphemeralMessageStub);
export const deleteMessageWithOutcome = mock(deleteMessageStub);
export const probeChatMembership = mock(probeChatMembershipStub);
export const resolveCommandTarget = mock(resolveCommandTargetStub);
export const answerInlineQuery = mock(answerInlineQueryStub);
/** 开关由用例直接改写；mock 出口在每次调用时读取当前值。 */
export const gagTestSwitches: {
  permissionAllowed: boolean;
  /** false 时机器人权限快照查不到（`botChatPermissionsIn` 给 undefined）。 */
  botPermissionsKnown: boolean;
  /** false 时快照确证机器人不是本群管理员，此时各权限位恒为 false。 */
  botIsAdministrator: boolean;
  canDeleteMessages: boolean;
} = {
  permissionAllowed: true,
  botPermissionsKnown: true,
  botIsAdministrator: true,
  canDeleteMessages: true,
};

mock.module("../../packages/infra/botAdmin", () => ({
  botChatPermissionsIn: async (): Promise<BotChatPermissions | undefined> => {
    if (!gagTestSwitches.botPermissionsKnown) return undefined;
    if (!gagTestSwitches.botIsAdministrator) {
      return botPermissions({ isAdministrator: false, canManageChat: false });
    }
    return botPermissions({
      canDeleteMessages: gagTestSwitches.canDeleteMessages,
      canRestrictMembers: true,
    });
  },
}));
mock.module("../../packages/infra/chatTeardownRegistry", () => ({
  registerChatTeardown: (): void => undefined,
}));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub(),
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (): Readonly<Record<string, never>> => ({}),
  getGagThumbnailUrl: (): string => GAG_THUMBNAIL_URL,
}));
mock.module("../../packages/infra/telegram", () => ({
  deleteEphemeralMessageWithOutcome,
  deleteMessageWithOutcome,
  logApiError: (): void => undefined,
  probeChatMembership,
  sendCommandMessage,
  replyCommandNotice: replyCommandNoticeVia(sendCommandMessage),
  sendEphemeralMessage,
  sendMessage,
}));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 100 && key === "isCanGag" && gagTestSwitches.permissionAllowed,
}));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));

const originalDateNow: () => number = Date.now;

/**
 * 入口换新是 fire-and-forget 的后台任务（见 commands/gag/inline.ts）。断言换新结果前先把这批
 * 任务排空，等价于生产里 drainGagRuntime 的那一步。
 */
export async function settleGagBackgroundTasks(): Promise<void> {
  while (gagBackgroundTasks.size > 0) {
    await settleTestBatch([...gagBackgroundTasks]);
  }
}

export interface ContextOverrides {
  readonly chatId?: number;
  readonly chatType?: "group" | "supergroup" | "private";
  readonly match?: string;
  readonly replyToMessage?: Message;
}

export function commandContext({
  chatId = -1001,
  chatType = "supergroup",
  match = "@alice 5",
  replyToMessage,
}: ContextOverrides = {}): never {
  const message: Record<string, unknown> = {
    message_id: 10,
    chat: { id: chatId, type: chatType },
    from: { id: 100, first_name: "Admin" },
  };
  if (replyToMessage !== undefined) message.reply_to_message = replyToMessage;
  return {
    chat: { id: chatId, type: chatType, title: "测试群" },
    from: { id: 100, first_name: "Admin" },
    me: { id: 999, username: "test_bot" },
    msg: message,
    msgId: 10,
    match,
  } as never;
}

export interface SessionOverrides {
  readonly chatId?: number;
  readonly targetId?: number;
  readonly tool?: string;
  readonly phase?: GagSession["phase"];
  readonly expiresAt?: number;
  readonly publicNoticeMessageId?: number;
  readonly speakNoticeMessageId?: number;
  readonly pendingSpeakNoticeMessageId?: number;
  readonly retiredSpeakNoticeMessageId?: number;
  /** 入口当前挂在哪个论坛话题；缺省为 General/非论坛群。 */
  readonly speakNoticeThreadId?: number;
  readonly messagesSinceSpeakNotice?: number;
  readonly targetProfileUrl?: string;
}

export function createSession({
  chatId = -1001,
  targetId = 7,
  tool = "口塞",
  phase = "active",
  expiresAt = 1_300_000,
  publicNoticeMessageId,
  speakNoticeMessageId,
  pendingSpeakNoticeMessageId = 0,
  retiredSpeakNoticeMessageId = 0,
  speakNoticeThreadId,
  messagesSinceSpeakNotice = 0,
  targetProfileUrl,
}: SessionOverrides = {}): GagSession {
  return {
    chatId,
    targetId,
    targetProfileUrl: targetProfileUrl ??
      identity.createGagTargetProfileUrl({ id: targetId }),
    targetLabel: "Alice (@alice)",
    chatLabel: `群 ${chatId}`,
    tool,
    durationMinutes: 5,
    phase,
    expiresAt,
    publicNoticeMessageId:
      publicNoticeMessageId ?? (targetId > 0 ? 54 : 0),
    speakNoticeMessageId:
      speakNoticeMessageId ?? (targetId > 0 ? 55 : 54),
    pendingSpeakNoticeMessageId,
    retiredSpeakNoticeMessageId,
    speakNoticeThreadId,
    messagesSinceSpeakNotice,
    lastTargetMessageAt: Date.now(),
    speakNoticeRefreshTask: null,
    speakNoticeRefreshTimer: null,
    noticePending: false,
    timer: null,
    cleanupRetryIndex: 0,
    cleanupTimer: null,
    endingTask: null,
  };
}

export function addSession(session: GagSession): void {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(session.chatId);
  if (sessions === undefined) gagSessionsByChat.set(session.chatId, [session]);
  else sessions.push(session);
}

export function sessionFor(chatId: number, targetId: number = 7): GagSession | undefined {
  return gagSessionsByChat.get(chatId)?.find((session: GagSession): boolean =>
    session.targetId === targetId
  );
}

export function gagInlineEntities(session: GagSession): MessageEntity[] {
  const prefix: string = rendering.gagSpeechPrefix(session.tool);
  return [{
    type: "text_link",
    offset: 0,
    length: prefix.length,
    url: identity.createGagInlineMarkerUrl(session),
  }];
}

export function normalMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    message_id: 88,
    chat: { id: -1001, type: "supergroup", title: "测试群" },
    date: 1,
    from: { id: 7, is_bot: false, first_name: "Alice" },
    text: "普通消息",
    ...overrides,
  } as Message;
}

export function lastCommandText(): string {
  return (sendCommandMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

export function lastStateText(): string {
  return (sendMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

export function lastEphemeralText(): string {
  return (sendEphemeralMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

/**
 * 清空会话表、在途后台任务与全部 timer。等价于 commands/gag/runtime.ts 的
 * resetGagSessions，但只碰 cache/main/gag，不需要先 await import 被测模块。
 */
function resetGagTestState(): void {
  for (const sessions of gagSessionsByChat.values()) {
    for (const session of sessions) {
      if (session.timer !== null) clearTimeout(session.timer);
      if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
      if (session.speakNoticeRefreshTimer !== null) clearTimeout(session.speakNoticeRefreshTimer);
      session.timer = null;
      session.cleanupTimer = null;
      session.speakNoticeRefreshTimer = null;
    }
  }
  gagSessionsByChat.clear();
  gagBackgroundTasks.clear();
  inlineResultSources.clear();
  gagRuntimeAccepting.current = true;
}

/**
 * gag 用例文件共用的隔离钩子。每份都登记，使会话表、Date.now 替身与 mock 实现不跨用例泄漏。
 */
export function installGagTestHooks(): void {
  const preloadedAtmosphere: typeof botAtmosphereState.current = botAtmosphereState.current;
  beforeEach(() => {
    resetGagTestState();
    gagTestSwitches.permissionAllowed = true;
    gagTestSwitches.botPermissionsKnown = true;
    gagTestSwitches.botIsAdministrator = true;
    gagTestSwitches.canDeleteMessages = true;
    // 普通通知风格的用例自行改成 plain；每个用例从雌小鬼语气起步。
    botAtmosphereState.current = "teasing";
    Date.now = (): number => 1_000_000;
    for (const mocked of [
      deleteEphemeralMessageWithOutcome,
      sendCommandMessage,
      sendEphemeralMessage,
      sendMessage,
      deleteMessageWithOutcome,
      probeChatMembership,
      resolveCommandTarget,
      answerInlineQuery,
    ]) mocked.mockReset();
    sendCommandMessage.mockImplementation(sendCommandMessageStub);
    sendEphemeralMessage.mockImplementation(sendEphemeralMessageStub);
    deleteEphemeralMessageWithOutcome.mockImplementation(deleteEphemeralMessageStub);
    sendMessage.mockImplementation(sendMessageStub);
    deleteMessageWithOutcome.mockImplementation(deleteMessageStub);
    probeChatMembership.mockImplementation(probeChatMembershipStub);
    resolveCommandTarget.mockImplementation(resolveCommandTargetStub);
    answerInlineQuery.mockImplementation(answerInlineQueryStub);
  });

  afterEach(() => {
    resetGagTestState();
    Date.now = originalDateNow;
    botAtmosphereState.current = preloadedAtmosphere;
  });
}

/**
 * 定时换新与沉默刷新用例共用的假时钟钩子，在 installGagTestHooks 之后调用：每条用例从 1_000_000 起
 * 走 jest 假 timer，Date.now 读假时钟；临时提示的 id 从 100 起逐条递增，区分前后几次换新发出的入口。
 * 用例结束先撤掉会话与 timer，再换回真 timer。
 */
export function installGagFakeClockHooks(): void {
  beforeEach((): void => {
    jest.useFakeTimers({ now: 1_000_000 });
    Date.now = (): number => new Date().getTime();
    let nextNoticeId: number = 100;
    sendEphemeralMessage.mockImplementation(async (params: EphemeralMessageParams): Promise<number> => {
      const noticeId: number = nextNoticeId++;
      params.onSent?.(noticeId);
      return noticeId;
    });
  });
  afterEach((): void => {
    resetGagTestState();
    jest.useRealTimers();
  });
}

/** 推进假时钟并排空随之触发的 gag 后台任务。 */
export async function advanceGagTime(milliseconds: number): Promise<void> {
  jest.advanceTimersByTime(milliseconds);
  await settleGagBackgroundTasks();
}

/** 连续向 gag 消息入口投递普通可见群消息并排空每次衍生的后台任务。 */
export async function sendVisibleMessages(count: number): Promise<void> {
  const { handleGagMessageIngress } = await import("../../packages/commands/gag");
  for (let index: number = 0; index < count; index++) {
    await handleGagMessageIngress(normalMessage({
      message_id: 200 + index,
      from: { id: 8, is_bot: false, first_name: "Bob" },
    }), 999);
    await settleGagBackgroundTasks();
  }
}
