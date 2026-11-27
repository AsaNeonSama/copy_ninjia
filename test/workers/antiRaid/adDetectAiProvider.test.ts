import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AdDetectJsonRequestParams,
  AdDetectProviderResult,
  AdVerdict,
} from "../../../packages/types/antiRaid/adDetect";
import type { AgentProvider } from "../../../packages/types/config";

let provider: AgentProvider = "google";
const requestGoogleAdDetectJson = mock(
  async (_params: AdDetectJsonRequestParams): Promise<AdDetectProviderResult> => ({ status: "ok", body: "google" })
);
const requestOpenAiAdDetectJson = mock(
  async (_params: AdDetectJsonRequestParams): Promise<AdDetectProviderResult> => ({ status: "ok", body: "openai" })
);
const requestAnthropicAdDetectJson = mock(
  async (_params: AdDetectJsonRequestParams): Promise<AdDetectProviderResult> => ({ status: "ok", body: "anthropic" })
);
const classifyWithGoogleDecision = mock(
  async (_params: unknown): Promise<AdVerdict | null> => ({ isAd: true, reason: "decision(0.95): promo_contact" })
);

mock.module("../../../packages/config/agent", () => ({
  getAdDetectAgentConfig: () => ({ provider }),
}));
mock.module("../../../packages/workers/antiRaid/adDetect/ai/google", () => ({ requestGoogleAdDetectJson }));
mock.module("../../../packages/workers/antiRaid/adDetect/ai/openai", () => ({ requestOpenAiAdDetectJson }));
mock.module("../../../packages/workers/antiRaid/adDetect/ai/anthropic", () => ({ requestAnthropicAdDetectJson }));
mock.module("../../../packages/workers/antiRaid/adDetect/ai/googleDecision", () => ({ classifyWithGoogleDecision }));

const {
  requestAdDetectDecision,
  requestAdDetectJson,
} = await import("../../../packages/workers/antiRaid/adDetect/ai/provider");

const params: AdDetectJsonRequestParams = {
  model: "ad-model",
  instructions: "只输出 JSON",
  fact: "【系统事实】夹具事实",
  systemPrompt: "只输出 JSON\n【系统事实】夹具事实",
  userContent: "1. 在吗",
  temperature: 0.5,
  maxOutputTokens: 256,
  errorLabel: "Test ad request",
};

beforeEach((): void => {
  provider = "google";
  requestGoogleAdDetectJson.mockClear();
  requestOpenAiAdDetectJson.mockClear();
  requestAnthropicAdDetectJson.mockClear();
  classifyWithGoogleDecision.mockClear();
});

describe("广告检测 provider 分派", () => {
  test("Anthropic 配置只调用 Anthropic 传输", async () => {
    provider = "anthropic";

    await expect(requestAdDetectJson(params)).resolves.toEqual({ status: "ok", body: "anthropic" });
    expect(requestAnthropicAdDetectJson).toHaveBeenCalledWith(params);
    expect(requestGoogleAdDetectJson).not.toHaveBeenCalled();
    expect(requestOpenAiAdDetectJson).not.toHaveBeenCalled();
  });

  test("Google 配置只调用 Google 传输并原样转发请求", async () => {
    await expect(requestAdDetectJson(params)).resolves.toEqual({ status: "ok", body: "google" });
    expect(requestGoogleAdDetectJson).toHaveBeenCalledWith(params);
    expect(requestOpenAiAdDetectJson).not.toHaveBeenCalled();
  });

  test("OpenAI 配置只调用 OpenAI 兼容传输", async () => {
    provider = "openai";

    await expect(requestAdDetectJson(params)).resolves.toEqual({ status: "ok", body: "openai" });
    expect(requestOpenAiAdDetectJson).toHaveBeenCalledWith(params);
    expect(requestGoogleAdDetectJson).not.toHaveBeenCalled();
  });

  test("requestAdDetectDecision 原样转发给 Google Decisions 传输", async () => {
    const decisionParams = {
      model: "gemini-decision",
      instructions: "rules",
      fact: "fact",
      userContent: "1. hi",
      errorLabel: "Decision test",
    };
    await expect(requestAdDetectDecision(decisionParams)).resolves.toEqual({
      isAd: true,
      reason: "decision(0.95): promo_contact",
    });
    expect(classifyWithGoogleDecision).toHaveBeenCalledWith(decisionParams);
  });
});
