/**
 * 主线程消息 ingress（antiRaid/updateIngress.ts）里广告候选投递结果的边沿日志：Worker 重建或已放弃
 * 自愈期间每条开着广告检测的群消息都会被拒，错误只在由收转拒时记一行，恢复只在由拒转收时记一行。
 *
 * 候选构建与临时免检累计整层替换成夹具，本文件只看 ingress 怎样按 postAntiRaid 的结果切换日志状态；
 * 入群守卫开关的投递边界见 joinGuardSwitch.test.ts。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import { botPermissions } from "../helpers/botPermissions";
import type { Message } from "grammy/types";
import type { AdCandidateMessage, AdDetectionMessageContext } from "../../packages/types/antiRaid/adDetect";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid/protocol";
import type { ChatState } from "../../packages/types/chatState";

const CHAT_ID: number = -1001;
const BOT_ID: number = 999;

/** postAntiRaid 的返回值；false 模拟 Worker 正在重建或已放弃重建。 */
const delivery: { accepts: boolean } = { accepts: true };
/** 每次投递尝试按顺序记下，不论 Worker 收没收。 */
const attemptedPosts: AntiRaidWorkerMessage[] = [];
const loggerLog = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ log: loggerLog, error: loggerError }),
}));
mock.module("../../packages/antiRaid/workerBridge/controller", () => ({
  postAntiRaid: (message: AntiRaidWorkerMessage): boolean => {
    attemptedPosts.push(message);
    return delivery.accepts;
  },
}));
mock.module("../../packages/antiRaid/adCandidate", () => ({
  adDetectionSenderId: (message: Message): number | undefined => message.from?.id,
  buildAdCandidate: ({ message, now, senderId }: AdDetectionMessageContext): AdCandidateMessage => ({
    type: "adCandidate",
    chatId: message.chat.id,
    senderId,
    messageId: message.message_id,
    observedAt: now,
    text: message.text ?? "",
    firstName: message.from?.first_name ?? "",
    lastName: "",
    username: "",
    isChannel: false,
    isForwarded: false,
    blocked: false,
    justJoined: false,
    linkUrls: undefined,
    sampleQuote: undefined,
    sampleReplyTo: undefined,
  }),
}));
mock.module("../../packages/antiRaid/temporaryAdBypass", () => ({
  recordEligibleTemporaryAdBypassActivity: (_context: AdDetectionMessageContext): boolean => false,
}));

const { handleAntiRaidMessageIngress } = await import("../../packages/antiRaid/updateIngress");
const { adCandidatePostRejected } = await import("../../packages/cache/main/antiRaid/proxy");
const { getOrCreateChatState } = await import("../../packages/infra/storage/stateStore");

/** 一条开着广告检测的超级群里的普通文本消息；只有 message_id 逐条不同。 */
function ingest(messageId: number, chatId: number = CHAT_ID): boolean | Promise<boolean> {
  return handleAntiRaidMessageIngress({
    chat: { id: chatId, type: "supergroup", title: "群" },
    message_id: messageId,
    date: 1,
    from: { id: 42, is_bot: false, first_name: "Zako" },
    text: "普通群消息",
  } as Message, BOT_ID);
}

/** 已尝试投递的广告候选 message_id，按投递顺序。 */
function attemptedCandidateIds(): number[] {
  const ids: number[] = [];
  for (const message of attemptedPosts) {
    if (message.type === "adCandidate") ids.push(message.messageId);
  }
  return ids;
}

beforeEach((): void => {
  delivery.accepts = true;
  attemptedPosts.length = 0;
  loggerLog.mockClear();
  loggerError.mockClear();
  adCandidatePostRejected.current = false;
  const chatState: ChatState = getOrCreateChatState(CHAT_ID);
  // 已确证的管理员群：ingress 走同步快路径，不现查权限。
  chatState.botPermissions = botPermissions();
  chatState.isAdDetectEnabled = true;
});

describe("广告候选被 Worker 拒收的边沿日志", () => {
  test("一直被收下时不记日志，状态保持在接收", () => {
    for (const messageId of [1, 2, 3]) expect(ingest(messageId)).toBe(false);

    expect(attemptedCandidateIds()).toEqual([1, 2, 3]);
    expect(loggerError).not.toHaveBeenCalled();
    expect(loggerLog).not.toHaveBeenCalled();
    expect(adCandidatePostRejected.current).toBeFalse();
  });

  test("连续拒收只记一次错误，恢复后记一次恢复，再次拒收重新记一次错误", () => {
    delivery.accepts = false;
    for (const messageId of [1, 2, 3]) ingest(messageId);

    expect(loggerError).toHaveBeenCalledTimes(1);
    // 只点名第一条被拒候选所在的群；单个参数，不带错误对象。
    expect(loggerError.mock.calls[0]).toEqual([expect.stringContaining(String(CHAT_ID))]);
    expect(loggerLog).not.toHaveBeenCalled();
    expect(adCandidatePostRejected.current).toBeTrue();

    delivery.accepts = true;
    for (const messageId of [4, 5]) ingest(messageId);

    expect(loggerLog).toHaveBeenCalledTimes(1);
    expect(loggerLog.mock.calls[0]).toEqual([expect.any(String)]);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(adCandidatePostRejected.current).toBeFalse();

    delivery.accepts = false;
    for (const messageId of [6, 7]) ingest(messageId);

    expect(loggerError).toHaveBeenCalledTimes(2);
    expect(loggerLog).toHaveBeenCalledTimes(1);
    expect(adCandidatePostRejected.current).toBeTrue();
    // 日志静默不影响投递：每条候选都照样尝试投出，被拒的只是丢掉。
    expect(attemptedCandidateIds()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("拒收状态跨群共用：别的群的拒收不再重复记错误，任一群被收下即恢复", () => {
    const otherChatId: number = -1002;
    const otherState: ChatState = getOrCreateChatState(otherChatId);
    otherState.botPermissions = botPermissions();
    otherState.isAdDetectEnabled = true;
    delivery.accepts = false;
    ingest(1);
    ingest(2, otherChatId);

    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]).toEqual([expect.stringContaining(String(CHAT_ID))]);

    delivery.accepts = true;
    ingest(3, otherChatId);
    expect(loggerLog).toHaveBeenCalledTimes(1);
    expect(adCandidatePostRejected.current).toBeFalse();
  });
});
