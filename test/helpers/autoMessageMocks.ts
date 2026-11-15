/**
 * `auto/message` 消息流水线测试共用的模块替身、群状态旋钮与逐用例复位。
 *
 * 统一替身 `handleIncomingMessageMiddleware` 的外部依赖（Telegram 出站、群状态、群标题记录、
 * 发送者缓存、AI Worker 投递与自发消息判定）；须在动态导入被测生产模块之前静态导入本模块。
 */

import { mock } from "bun:test";
import type { TranslateState } from "../../packages/types/translate";
import { clearAbuseMarkedUsers } from "../../packages/aiChat/abuseMark";
import { chatQaEntries } from "../../packages/cache/main/qa";

export const recordChatMessageMock = mock((..._args: unknown[]): void => {});
export const recordChatMediaMock = mock((..._args: unknown[]): void => {});
export const generateAndSendReplyMock = mock((..._args: unknown[]): void => {});
export const copyMessageMock = mock(
  async (..._args: unknown[]): Promise<number | undefined> => undefined
);
export const sendMessageMock = mock(
  async (..._args: unknown[]): Promise<number | undefined> => undefined
);
export const isBotOwnMessageMock = mock((..._args: unknown[]): boolean => false);
export const needsBotOwnMessageWaitMock = mock((..._args: unknown[]): boolean => false);
export const waitForBotOwnMessageMock = mock(
  async (..._args: unknown[]): Promise<boolean> => false
);

/**
 * 各用例可改的群状态旋钮；`getChatState` 每次读现值，改完立即生效。
 *
 * 静默存的是相对偏移而不是绝对时刻：`isQuietUntilActive` 同时判上界
 * （`quietUntil - now` 不得超过 QUIET_MAX_DURATION_MS + 容差），很远的绝对时刻会被判成「未静默」。
 */
export const autoMessageChatState: {
  isAIChatEnabled: boolean;
  isTranslationEnabled: boolean;
  /**
   * 本群是否已接管。缺省 false：问答直答那条分支只对已接管的群生效（见 auto/message/index.ts）。
   */
  isInitEnabled: boolean;
  /** 距现在的静默剩余毫秒；undefined 表示从没设过静默。 */
  quietUntilOffsetMs: number | undefined;
} = { isAIChatEnabled: true, isTranslationEnabled: false, isInitEnabled: false, quietUntilOffsetMs: 60_000 };

export const autoMessageCopyState: { targetId: number | undefined } = { targetId: undefined };

/** 各群的翻译会话；`getChatState(chatId).translate` 按群读取，没有条目即无会话。 */
export const autoMessageTranslateSessions = new Map<number, readonly TranslateState[]>();

mock.module("../../packages/infra/telegram", () => ({
  copyMessage: copyMessageMock,
  sendMessage: sendMessageMock,
  sendVoiceWithResult: async (): Promise<undefined> => undefined,
  bot: { api: {} },
  logApiError: (): void => {},
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  activeCopyTargetIdIn: (): number | undefined => autoMessageCopyState.targetId,
  persistGlobalState: async (): Promise<void> => {},
  activeCopyModeIn: (): undefined => undefined,
}));
mock.module("../../packages/infra/chatStateStorage", () => ({
  clearChatStateField: (): boolean => false,
  disableChatStateSwitch: (): boolean => false,
  getActiveProxySendTarget: (): undefined => undefined,
  getChatState: (chatId: number): Record<string, unknown> => ({
    translate: autoMessageTranslateSessions.get(chatId),
    isAIChatEnabled: autoMessageChatState.isAIChatEnabled,
    isTranslationEnabled: autoMessageChatState.isTranslationEnabled,
    isInitEnabled: autoMessageChatState.isInitEnabled,
    quietUntil: autoMessageChatState.quietUntilOffsetMs === undefined
      ? undefined
      : Date.now() + autoMessageChatState.quietUntilOffsetMs,
  }),
  getChatStateCache: (): ReadonlyMap<number, unknown> => new Map(),
  getOrCreateChatState: (): Record<string, unknown> => ({}),
  persistChatState: async (): Promise<void> => {},
  saveChatStateInBackground: (): void => {},
}));
mock.module("../../packages/infra/chatTitle", () => ({
  recordChatTitleFromChat: (): void => {},
}));
mock.module("../../packages/users/senderIdentity", () => ({
  cacheSender: (message: any): number | undefined =>
    message.sender_chat?.id ?? message.from?.id,
}));
mock.module("../../packages/aiChat", () => ({
  recordChatMessage: recordChatMessageMock,
  recordChatMedia: recordChatMediaMock,
  generateAndSendReply: generateAndSendReplyMock,
  synthesizeVoice: async (): Promise<{ ok: false; reason: "worker unavailable" }> => ({ ok: false, reason: "worker unavailable" }),
}));
mock.module("../../packages/infra/selfSentTracker", () => ({
  isSelfSent: (): boolean => false,
  isBotOwnMessage: isBotOwnMessageMock,
  needsBotOwnMessageWait: needsBotOwnMessageWaitMock,
  waitForBotOwnMessage: waitForBotOwnMessageMock,
}));

/** 逐用例复位调用记录、替身默认实现与群状态旋钮。 */
export function resetAutoMessageMocks(): void {
  recordChatMessageMock.mockClear();
  recordChatMediaMock.mockClear();
  generateAndSendReplyMock.mockClear();
  copyMessageMock.mockReset();
  copyMessageMock.mockImplementation(async (): Promise<number | undefined> => undefined);
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (): Promise<number | undefined> => undefined);
  isBotOwnMessageMock.mockReset();
  isBotOwnMessageMock.mockImplementation((): boolean => false);
  needsBotOwnMessageWaitMock.mockReset();
  needsBotOwnMessageWaitMock.mockImplementation((): boolean => false);
  waitForBotOwnMessageMock.mockReset();
  waitForBotOwnMessageMock.mockImplementation(async (): Promise<boolean> => false);
  autoMessageChatState.isAIChatEnabled = true;
  autoMessageChatState.isTranslationEnabled = false;
  autoMessageCopyState.targetId = undefined;
  autoMessageChatState.isInitEnabled = false;
  autoMessageChatState.quietUntilOffsetMs = 60_000;
  chatQaEntries.clear();
  autoMessageTranslateSessions.clear();
  clearAbuseMarkedUsers();
}
