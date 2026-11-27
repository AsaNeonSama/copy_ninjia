import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type {
  AdDetectJsonRequestParams,
  AdDetectMediaAttachment,
} from "../../../packages/types/antiRaid/adDetect";

const errorLogs: unknown[][] = [];
const constructions: unknown[] = [];
const generateContent = mock(async (..._args: unknown[]): Promise<unknown> => ({
  candidates: [{ finishReason: "STOP" }],
  text: "{\"ad\":false,\"reason\":\"闲聊\"}",
}));

class FakeApiError extends Error {
  status: number = 429;
  constructor(message: string, status: number = 429) {
    super(message);
    this.status = status;
  }
}

let currentProvider: string = "google";

const googleGenAi = await import("@google/genai");
mock.module("@google/genai", () => ({
  ...googleGenAi,
  ApiError: FakeApiError,
  GoogleGenAI: class FakeGoogleGenAI {
    models: { generateContent: typeof generateContent } = { generateContent };
    constructor(options: unknown) { constructions.push(options); }
  },
}));
mock.module("../../../packages/config/agent", () => ({
  getAdDetectAgentConfig: () => ({
    provider: currentProvider,
    apiKey: "google-ad-key",
    baseUrl: "https://google.example",
    model: "gemini-ad",
    useDecision: false,
  }),
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error(...args: unknown[]): void { errorLogs.push(args); } }),
}));

const { requestGoogleAdDetectJson } = await import("../../../packages/workers/antiRaid/adDetect/ai/google");
const { adDetectStopping } = await import("../../../packages/cache/workers/antiRaid/adDetect");
const { GEMINI_API_VERSION, GEMINI_SAFETY_SETTINGS } = await import("../../../packages/consts/aiChat/gemini");
const { adDetectGoogleClientHolder } = await import("../../../packages/cache/workers/antiRaid/google");
const { installAiCacheUsageSink } = await import("../../../packages/infra/aiCacheUsage");
import type { AiCacheUsage } from "../../../packages/types/aiCache";
const {
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
  AD_DETECT_JSON_SCHEMA,
  AD_DETECT_PACK_JSON_SCHEMA,
  formatAdDetectAttachmentLabel,
} = await import("../../../packages/consts/antiRaid/adDetect");

const params: AdDetectJsonRequestParams = {
  model: "gemini-ad",
  instructions: "规则与示例",
  fact: "【系统事实】夹具事实",
  systemPrompt: "规则与示例\n【系统事实】夹具事实",
  userContent: "1. 在吗",
  temperature: 0.5,
  maxOutputTokens: 256,
  errorLabel: "Test request",
};

/** 一次 generateContent 请求体里本测试关心的字段。 */
interface SentRequest {
  readonly model: string;
  readonly contents: unknown;
  readonly config: {
    readonly cachedContent?: string;
    readonly systemInstruction?: string;
    readonly temperature?: number;
    readonly responseMimeType?: string;
    readonly responseJsonSchema?: unknown;
    readonly maxOutputTokens?: number;
    readonly safetySettings?: unknown;
  };
}

function sentAt(index: number): SentRequest {
  return generateContent.mock.calls[index]![0] as SentRequest;
}

beforeEach((): void => {
  currentProvider = "google";
  adDetectStopping.current = false;
  adDetectGoogleClientHolder.current = null;
  constructions.length = 0;
  errorLogs.length = 0;
  generateContent.mockReset();
  generateContent.mockImplementation(async (): Promise<unknown> => ({
    candidates: [{ finishReason: "STOP" }],
    text: "{\"ad\":false,\"reason\":\"闲聊\"}",
  }));
});

afterEach((): void => {
  adDetectStopping.current = false;
});

describe("Google 广告检测请求入口", () => {
  test("使用独立凭据、端点与结构化 JSON 请求；系统事实作为正文之前的独立 part", async () => {
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({
      status: "ok",
      body: "{\"ad\":false,\"reason\":\"闲聊\"}",
    });
    expect(constructions[0]).toEqual({
      apiKey: "google-ad-key",
      enterprise: false,
      httpOptions: {
        baseUrl: "https://google.example",
        apiVersion: GEMINI_API_VERSION,
        timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
        retryOptions: { attempts: AD_DETECT_GOOGLE_REQUEST_ATTEMPTS },
      },
    });
    expect(sentAt(0)).toMatchObject({
      model: "gemini-ad",
      contents: [{ role: "user", parts: [{ text: params.fact }, { text: params.userContent }] }],
      config: {
        systemInstruction: params.instructions,
        responseMimeType: "application/json",
        responseJsonSchema: AD_DETECT_JSON_SCHEMA,
        maxOutputTokens: params.maxOutputTokens,
      },
    });
    expect(sentAt(0).config.cachedContent).toBeUndefined();
    expect(sentAt(0).config.temperature).toBeUndefined();
    expect(sentAt(0).config.safetySettings).toEqual([...GEMINI_SAFETY_SETTINGS]);
  });

  test("多模态附件携带 inlineData，仅在存在贴纸/表情包候选时切换为 AD_DETECT_PACK_JSON_SCHEMA", async () => {
    const bytes: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const photoAttachment: AdDetectMediaAttachment = {
      id: "img-1",
      kind: "photo",
      packName: undefined,
      image: { bytes, mime: "image/png" },
    };
    const stickerAttachment: AdDetectMediaAttachment = {
      id: "stk-1",
      kind: "sticker",
      packName: "AdPack",
      image: { bytes, mime: "image/png" },
    };

    await expect(requestGoogleAdDetectJson({
      ...params,
      attachments: [photoAttachment],
    })).resolves.toEqual({ status: "ok", body: "{\"ad\":false,\"reason\":\"闲聊\"}" });
    expect(sentAt(0).config.responseJsonSchema).toEqual(AD_DETECT_JSON_SCHEMA);
    expect(sentAt(0).contents).toEqual([{
      role: "user",
      parts: [
        { text: params.fact },
        { text: params.userContent },
        { text: formatAdDetectAttachmentLabel(1, photoAttachment) },
        { inlineData: { mimeType: "image/png", data: bytes.toBase64() } },
      ],
    }]);

    await expect(requestGoogleAdDetectJson({
      ...params,
      attachments: [stickerAttachment],
      stickerPackCandidates: ["AdPack"],
    })).resolves.toEqual({ status: "ok", body: "{\"ad\":false,\"reason\":\"闲聊\"}" });
    expect(sentAt(1).config.responseJsonSchema).toEqual(AD_DETECT_PACK_JSON_SCHEMA);
    expect(sentAt(1).contents).toEqual([{
      role: "user",
      parts: [
        { text: params.fact },
        { text: params.userContent },
        { text: formatAdDetectAttachmentLabel(1, stickerAttachment) },
        { inlineData: { mimeType: "image/png", data: bytes.toBase64() } },
      ],
    }]);
  });

  test("带图请求遇明确不支持图片输入错误时返回 visionUnsupported 且不记错误日志", async () => {
    const attachment: AdDetectMediaAttachment = {
      id: "img-1",
      kind: "photo",
      packName: undefined,
      image: { bytes: new Uint8Array([1, 2]), mime: "image/jpeg" },
    };
    generateContent.mockImplementationOnce((): never => {
      throw new FakeApiError("This model does not support image input.", 400);
    });
    await expect(requestGoogleAdDetectJson({
      ...params,
      attachments: [attachment],
    })).resolves.toEqual({ status: "visionUnsupported" });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(errorLogs).toEqual([]);
  });

  test("成功响应按 ad_detect 上报 Gemini 用量", async () => {
    const reported: AiCacheUsage[] = [];
    installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
    generateContent.mockImplementationOnce(async (): Promise<unknown> => ({
      candidates: [{ finishReason: "STOP" }],
      text: "{\"ad\":false,\"reason\":\"闲聊\"}",
      usageMetadata: { promptTokenCount: 700, cachedContentTokenCount: 512, candidatesTokenCount: 9 },
    }));
    try {
      await requestGoogleAdDetectJson(params);
    } finally {
      installAiCacheUsageSink(null);
    }
    expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([
      { kind: "tokens", capability: "ad_detect", provider: "google", model: "gemini-ad", inputTokens: 700, cachedInputTokens: 512, outputTokens: 9 },
    ]);
  });

  test("请求错误不叠加业务重试", async () => {
    generateContent.mockImplementationOnce((): never => { throw new FakeApiError("rate limited"); });
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({ status: "failed" });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(errorLogs[0]).toEqual([
      "Ad detection API request failed.",
      { errorLabel: "Test request", status: 429, errorMessage: "rate limited" },
    ]);

    generateContent.mockImplementationOnce((): never => { throw new Error("socket hang up"); });
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({ status: "failed" });
    expect(errorLogs[1]).toEqual([
      "Ad detection request failed:",
      { errorLabel: "Test request" },
      expect.objectContaining({ message: "socket hang up" }),
    ]);

    currentProvider = "openai";
    adDetectGoogleClientHolder.current = null;
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({ status: "failed" });
    expect(constructions).toHaveLength(1);
  });

  test("非 STOP 结束或空正文有限重试，耗尽后连同最后一次的收尾原因与详情记一条错误并返回 failed", async () => {
    generateContent.mockImplementation(async (): Promise<unknown> => ({
      candidates: [{ finishReason: "MAX_TOKENS" }],
      text: "{\"ad\":",
    }));
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({ status: "failed" });
    expect(generateContent).toHaveBeenCalledTimes(AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS);
    expect(errorLogs).toEqual([[
      "Ad detection request returned no usable body.",
      {
        errorLabel: "Test request",
        attempts: AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
        abnormalReason: "abnormal finish",
        finishReason: "MAX_TOKENS",
        finishDetails: null,
      },
    ]]);

    errorLogs.length = 0;
    const safetyRatings = [{ category: "HARM_CATEGORY_HARASSMENT", probability: "HIGH", blocked: true }];
    generateContent.mockImplementation(async (): Promise<unknown> => ({ candidates: [{ finishReason: "SAFETY", safetyRatings }] }));
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({ status: "failed" });
    expect(errorLogs).toEqual([[
      "Ad detection request returned no usable body.",
      {
        errorLabel: "Test request",
        attempts: AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
        abnormalReason: "abnormal finish",
        finishReason: "SAFETY",
        finishDetails: JSON.stringify({ safetyRatings }),
      },
    ]]);

    errorLogs.length = 0;
    generateContent.mockImplementation(async (): Promise<unknown> => ({ candidates: [{ finishReason: "STOP" }], text: " " }));
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({ status: "failed" });
    expect(errorLogs).toEqual([[
      "Ad detection request returned no usable body.",
      {
        errorLabel: "Test request",
        attempts: AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
        abnormalReason: null,
        finishReason: "STOP",
        finishDetails: null,
      },
    ]]);
  });

  test("空白正文按不可用处理，下一次拿到正文即返回", async () => {
    generateContent
      .mockImplementationOnce(async (): Promise<unknown> => ({ candidates: [{ finishReason: "STOP" }], text: "   " }))
      .mockImplementationOnce(async (): Promise<unknown> => ({ candidates: [{ finishReason: "STOP" }], text: " {\"ad\":true,\"reason\":\"引流\"} " }));
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({
      status: "ok",
      body: "{\"ad\":true,\"reason\":\"引流\"}",
    });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(errorLogs).toEqual([]);
  });
  test("两个系统事实变体共用完全相同的 systemInstruction，fact 置于正文之前以复用隐式前缀缓存", async () => {
    await requestGoogleAdDetectJson({ ...params, fact: "【系统事实】刚入群", systemPrompt: "规则与示例\n【系统事实】刚入群" });
    await requestGoogleAdDetectJson({ ...params, fact: "【系统事实】非刚入群", systemPrompt: "规则与示例\n【系统事实】非刚入群", userContent: "2. 另一条消息" });

    const first: SentRequest = sentAt(0);
    const second: SentRequest = sentAt(1);
    expect(first.config.systemInstruction).toBe(params.instructions);
    expect(second.config.systemInstruction).toBe(params.instructions);
    expect(first.config.cachedContent).toBeUndefined();
    expect(second.config.cachedContent).toBeUndefined();
    expect(first.contents).toEqual([{ role: "user", parts: [{ text: "【系统事实】刚入群" }, { text: params.userContent }] }]);
    expect(second.contents).toEqual([{ role: "user", parts: [{ text: "【系统事实】非刚入群" }, { text: "2. 另一条消息" }] }]);
  });

  test("首轮空正文后进入停机状态时停止第 2 轮重试并静默返回 failed", async () => {
    generateContent.mockImplementationOnce(async (): Promise<unknown> => {
      adDetectStopping.current = true;
      return { candidates: [{ finishReason: "STOP" }], text: "" };
    });
    await expect(requestGoogleAdDetectJson(params)).resolves.toEqual({ status: "failed" });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(errorLogs).toEqual([]);
  });
});
