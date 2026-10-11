/**
 * AI Worker 消息路由里的转交分支（workers/aiChatWorker.ts 的 handleAiChatWorkerMessage）：语音合成撤回、
 * 摘要组稿与撤回各自交给 Worker 侧的转交模块，语音合成计数的恢复值写进本线程的权威计数。
 * 本文件只替换这两个转交模块，计数恢复走真实实现。
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AiCancelVoiceSynthesisMessage,
  AiCancelWebDigestMessage,
  AiChatWorkerMessage,
  AiComposeWebDigestMessage,
  AiSynthesizeVoiceMessage,
} from "../../../packages/types/aiChat/protocol";
import type { TtsDailyUsage } from "../../../packages/types/aiChat/voiceMessage";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });

/** 两个转交模块按收到顺序记下的分支名。 */
const routed: string[] = [];
const handleSynthesizeVoice = mock((_msg: AiSynthesizeVoiceMessage): void => { routed.push("synthesizeVoice"); });
const handleCancelVoiceSynthesis = mock((_msg: AiCancelVoiceSynthesisMessage): void => {
  routed.push("cancelVoiceSynthesis");
});
const handleComposeWebDigest = mock((_msg: AiComposeWebDigestMessage): void => { routed.push("composeWebDigest"); });
const handleCancelWebDigest = mock((_msg: AiCancelWebDigestMessage): void => { routed.push("cancelWebDigest"); });
mock.module("../../../packages/workers/aiChat/voiceSynthesis", () => ({
  handleCancelVoiceSynthesis,
  handleSynthesizeVoice,
}));
mock.module("../../../packages/workers/aiChat/webDigest", () => ({
  handleCancelWebDigest,
  handleComposeWebDigest,
}));

const { handleAiChatWorkerMessage } = await import("../../../packages/workers/aiChatWorker");
const { ttsDailyUsage } = await import("../../../packages/cache/workers/aiChat/ttsUsage");

beforeEach((): void => {
  routed.length = 0;
  postMessage.mockClear();
  for (const mocked of [
    handleSynthesizeVoice,
    handleCancelVoiceSynthesis,
    handleComposeWebDigest,
    handleCancelWebDigest,
  ]) mocked.mockClear();
  ttsDailyUsage.current = null;
});

afterAll((): void => {
  ttsDailyUsage.current = null;
  if (originalSelfDescriptor === undefined) Reflect.deleteProperty(globalThis, "self");
  else Object.defineProperty(globalThis, "self", originalSelfDescriptor);
});

describe("AI Worker 转交分支路由", () => {
  test("摘要组稿请求与撤回按原消息交给组稿模块，不串到语音合成", () => {
    const compose: AiChatWorkerMessage = {
      type: "composeWebDigest",
      requestId: 3,
      request: { topic: "今日要闻", language: "zh", maxItems: 3, instructions: undefined },
    };
    const cancel: AiChatWorkerMessage = { type: "cancelWebDigest", requestId: 3 };

    handleAiChatWorkerMessage(compose);
    handleAiChatWorkerMessage(cancel);

    expect(routed).toEqual(["composeWebDigest", "cancelWebDigest"]);
    expect(handleComposeWebDigest.mock.calls).toEqual([[compose]]);
    expect(handleCancelWebDigest.mock.calls).toEqual([[cancel]]);
    expect(handleSynthesizeVoice).not.toHaveBeenCalled();
    expect(handleCancelVoiceSynthesis).not.toHaveBeenCalled();
    // 回执由组稿模块结算后自己发；路由本身不回任何消息。
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("同一 requestId 的两类撤回各回各的模块：语音撤回不碰组稿，组稿撤回不碰语音", () => {
    const cancelVoice: AiChatWorkerMessage = { type: "cancelVoiceSynthesis", requestId: 5 };
    const cancelDigest: AiChatWorkerMessage = { type: "cancelWebDigest", requestId: 5 };

    handleAiChatWorkerMessage(cancelVoice);
    handleAiChatWorkerMessage(cancelDigest);
    handleAiChatWorkerMessage(cancelVoice);

    expect(routed).toEqual(["cancelVoiceSynthesis", "cancelWebDigest", "cancelVoiceSynthesis"]);
    expect(handleCancelVoiceSynthesis.mock.calls).toEqual([[cancelVoice], [cancelVoice]]);
    expect(handleCancelWebDigest.mock.calls).toEqual([[cancelDigest]]);
    expect(handleComposeWebDigest).not.toHaveBeenCalled();
  });

  test("hydrateTtsUsage 以恢复值整份替换本线程计数，null 恢复成从没用过，且不回传主线程", () => {
    const previous: TtsDailyUsage = { windowStartedAt: 1_000, agentCount: 9, reserveCount: 9 };
    const restored: TtsDailyUsage = { windowStartedAt: 2_000, agentCount: 1, reserveCount: 0 };
    ttsDailyUsage.current = previous;

    handleAiChatWorkerMessage({ type: "hydrateTtsUsage", usage: restored });
    // 恢复值原样接管，不与旧计数合并。
    expect(ttsDailyUsage.current).toBe(restored);

    handleAiChatWorkerMessage({ type: "hydrateTtsUsage", usage: null });
    expect(ttsDailyUsage.current).toBeNull();

    // 恢复值本来就来自主线程（启动灌入或重建重放），不再作为 ttsUsage 回执发回去。
    expect(postMessage).not.toHaveBeenCalled();
    expect(routed).toEqual([]);
  });
});
