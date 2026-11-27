import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import type { AdDetectMediaAttachment } from "../../../packages/types/antiRaid/adDetect";
import type { AdDetectAgentConfig } from "../../../packages/types/config";

const errorLogs: unknown[][] = [];
const warnLogs: unknown[][] = [];
const constructions: unknown[] = [];
const decisionsCreate = mock(async (..._args: unknown[]): Promise<unknown> => ({
  answers: {
    ad: { type: "noul", noul: 0.12, confidence: 0.88 },
    category: { type: "choice", choice: "not_ad", confidence: 0.9, probabilities: { not_ad: 0.9 } },
  },
  usage: { total_input_tokens: 180 },
}));

let currentConfig: AdDetectAgentConfig = {
  provider: "google",
  apiKey: "google-decision-key",
  baseUrl: undefined,
  model: "gemini-decision-test",
  useDecision: true,
};

const googleGenAi = await import("@google/genai");
mock.module("@google/genai", () => ({
  ...googleGenAi,
  GoogleGenAI: class FakeGoogleGenAI {
    decisions: { create: typeof decisionsCreate } = { create: decisionsCreate };
    constructor(options: unknown) { constructions.push(options); }
  },
}));
mock.module("../../../packages/config/agent", () => ({
  getAdDetectAgentConfig: (): AdDetectAgentConfig => currentConfig,
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({
    error(...args: unknown[]): void { errorLogs.push(args); },
    warn(...args: unknown[]): void { warnLogs.push(args); },
  }),
}));

const {
  classifyWithGoogleDecision,
  resolveGeminiDecisionEndpoint,
} = await import("../../../packages/workers/antiRaid/adDetect/ai/googleDecision");
const { adDetectGoogleDecisionClientHolder } = await import("../../../packages/cache/workers/antiRaid/google");
const { GEMINI_API_BASE_URL, GEMINI_API_VERSION } = await import("../../../packages/consts/aiChat/gemini");
const {
  AD_DETECT_DECISION_AD_CRITERIA,
  AD_DETECT_DECISION_AD_THRESHOLD,
  AD_DETECT_DECISION_CATEGORIES,
  AD_DETECT_DECISION_CATEGORY_INSTRUCTIONS,
  AD_DETECT_DECISION_EMOJI_PACK_CRITERIA,
  AD_DETECT_DECISION_PACK_THRESHOLD,
  AD_DETECT_DECISION_STICKER_PACK_CRITERIA,
  AD_DETECT_EMPTY_TEXT_MEDIA_PLACEHOLDER,
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
  adDetectDecisionEmojiPackInstructions,
  adDetectDecisionStickerPackInstructions,
  formatAdDetectAttachmentLabel,
} = await import("../../../packages/consts/antiRaid/adDetect");
const { installAiCacheUsageSink } = await import("../../../packages/infra/aiCacheUsage");

const SAMPLE_PNG: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
const SAMPLE_JPEG: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3, 4]);

const ATTACHMENTS: readonly AdDetectMediaAttachment[] = [
  { id: "a1", kind: "photo", packName: undefined, image: { bytes: SAMPLE_JPEG, mime: "image/jpeg" } },
  { id: "a2", kind: "sticker", packName: "PromoStickers", image: { bytes: SAMPLE_PNG, mime: "image/png" } },
  { id: "a3", kind: "custom_emoji", packName: "BannerEmojis", image: { bytes: SAMPLE_PNG, mime: "image/png" } },
];

beforeEach((): void => {
  currentConfig = {
    provider: "google",
    apiKey: "google-decision-key",
    baseUrl: undefined,
    model: "gemini-decision-test",
    useDecision: true,
  };
  adDetectGoogleDecisionClientHolder.current = null;
  constructions.length = 0;
  errorLogs.length = 0;
  warnLogs.length = 0;
  decisionsCreate.mockReset();
  decisionsCreate.mockImplementation(async (): Promise<unknown> => ({
    answers: {
      ad: { type: "noul", noul: 0.12, confidence: 0.88 },
      category: { type: "choice", choice: "not_ad", confidence: 0.9, probabilities: { not_ad: 0.9 } },
    },
    usage: { total_input_tokens: 180 },
  }));
});

afterEach((): void => {
  installAiCacheUsageSink(null);
  adDetectGoogleDecisionClientHolder.current = null;
});

describe("resolveGeminiDecisionEndpoint", () => {
  test("按缺省、完整 /decisions 路径、版本前缀与代理根路径规范化拆分 baseUrl 与 apiVersion", () => {
    expect(resolveGeminiDecisionEndpoint(undefined)).toEqual({
      baseUrl: GEMINI_API_BASE_URL,
      apiVersion: GEMINI_API_VERSION,
    });
    expect(resolveGeminiDecisionEndpoint("https://generativelanguage.googleapis.com/v1beta/decisions")).toEqual({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiVersion: "v1beta",
    });
    expect(resolveGeminiDecisionEndpoint("https://proxy.example/google/v1alpha/decisions/")).toEqual({
      baseUrl: "https://proxy.example/google",
      apiVersion: "v1alpha",
    });
    expect(resolveGeminiDecisionEndpoint("https://proxy.example/google/v1beta/")).toEqual({
      baseUrl: "https://proxy.example/google",
      apiVersion: "v1beta",
    });
    expect(resolveGeminiDecisionEndpoint("https://proxy.example/google/v1")).toEqual({
      baseUrl: "https://proxy.example/google",
      apiVersion: "v1",
    });
    expect(resolveGeminiDecisionEndpoint("https://proxy.example/google/")).toEqual({
      baseUrl: "https://proxy.example/google",
      apiVersion: GEMINI_API_VERSION,
    });
    expect(resolveGeminiDecisionEndpoint("http://127.0.0.1:8080/v1alpha/decisions")).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      apiVersion: "v1alpha",
    });
  });
});

describe("classifyWithGoogleDecision", () => {
  test("单次请求携带多模态 input 与多问题 questions，按阈值产出广告结论、包归因并上报 Decisions 用量", async () => {
    currentConfig = {
      provider: "google",
      apiKey: "google-decision-key",
      baseUrl: "https://proxy.example/google/v1alpha/decisions/",
      model: "gemini-decision-test",
      useDecision: true,
    };
    decisionsCreate.mockResolvedValueOnce({
      answers: {
        ad: { type: "noul", noul: AD_DETECT_DECISION_AD_THRESHOLD + 0.12, confidence: 0.92 },
        category: { type: "choice", choice: "spam_media", confidence: 0.85, probabilities: { spam_media: 0.85 } },
        sticker_pack_0: { type: "noul", noul: AD_DETECT_DECISION_PACK_THRESHOLD, confidence: 0.8 },
        sticker_pack_1: { type: "noul", noul: AD_DETECT_DECISION_PACK_THRESHOLD - 0.1, confidence: 0.7 },
        emoji_pack_0: { type: "noul", noul: 0.95, confidence: 0.95 },
      },
      usage: { total_input_tokens: 420, total_cached_tokens: 120 },
    });
    const reported: AiCacheUsage[] = [];
    installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });

    const verdict = await classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "decision-rules",
      fact: "fact-line",
      userContent: "",
      attachments: ATTACHMENTS,
      stickerPackCandidates: ["PromoStickers", "PromoStickers", "BenignStickers"],
      emojiPackCandidates: ["BannerEmojis"],
      errorLabel: "Test decision",
    });

    expect(constructions).toEqual([{
      apiKey: "google-decision-key",
      enterprise: false,
      httpOptions: {
        baseUrl: "https://proxy.example/google",
        apiVersion: "v1alpha",
        timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
      },
    }]);

    expect(decisionsCreate).toHaveBeenCalledTimes(1);
    const [body, options] = decisionsCreate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(options).toEqual({
      timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
      maxRetries: AD_DETECT_GOOGLE_REQUEST_ATTEMPTS - 1,
    });
    expect(body).toEqual({
      model: "gemini-decision-test",
      input: [
        { type: "text", text: `fact-line\n${AD_DETECT_EMPTY_TEXT_MEDIA_PLACEHOLDER}` },
        { type: "text", text: formatAdDetectAttachmentLabel(1, ATTACHMENTS[0]!) },
        { type: "image", mime_type: "image/jpeg", data: SAMPLE_JPEG.toBase64() },
        { type: "text", text: formatAdDetectAttachmentLabel(2, ATTACHMENTS[1]!) },
        { type: "image", mime_type: "image/png", data: SAMPLE_PNG.toBase64() },
        { type: "text", text: formatAdDetectAttachmentLabel(3, ATTACHMENTS[2]!) },
        { type: "image", mime_type: "image/png", data: SAMPLE_PNG.toBase64() },
      ],
      questions: {
        ad: {
          type: "noul",
          instructions: "decision-rules",
          criteria: { ...AD_DETECT_DECISION_AD_CRITERIA },
        },
        category: {
          type: "choice",
          instructions: AD_DETECT_DECISION_CATEGORY_INSTRUCTIONS,
          criteria: { ...AD_DETECT_DECISION_CATEGORIES },
        },
        sticker_pack_0: {
          type: "noul",
          instructions: adDetectDecisionStickerPackInstructions("PromoStickers"),
          criteria: { ...AD_DETECT_DECISION_STICKER_PACK_CRITERIA },
        },
        sticker_pack_1: {
          type: "noul",
          instructions: adDetectDecisionStickerPackInstructions("BenignStickers"),
          criteria: { ...AD_DETECT_DECISION_STICKER_PACK_CRITERIA },
        },
        emoji_pack_0: {
          type: "noul",
          instructions: adDetectDecisionEmojiPackInstructions("BannerEmojis"),
          criteria: { ...AD_DETECT_DECISION_EMOJI_PACK_CRITERIA },
        },
      },
    });

    const questions = body.questions as Record<string, { readonly criteria?: unknown }>;
    expect(questions.ad?.criteria).toBe(AD_DETECT_DECISION_AD_CRITERIA);
    expect(questions.category?.criteria).toBe(AD_DETECT_DECISION_CATEGORIES);
    expect(questions.sticker_pack_0?.criteria).toBe(AD_DETECT_DECISION_STICKER_PACK_CRITERIA);
    expect(questions.emoji_pack_0?.criteria).toBe(AD_DETECT_DECISION_EMOJI_PACK_CRITERIA);

    expect(verdict).toEqual({
      isAd: true,
      reason: `decision(${(AD_DETECT_DECISION_AD_THRESHOLD + 0.12).toFixed(2)}): spam_media`,
      adStickerPacks: ["PromoStickers"],
      adEmojiPacks: ["BannerEmojis"],
    });
    expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([{
      kind: "tokens",
      capability: "ad_detect",
      provider: "google",
      model: "gemini-decision-test",
      inputTokens: 420,
      cachedInputTokens: 120,
      outputTokens: 0,
    }]);
  });

  test("整体未达广告阈值时不输出任何包归因；客户端按 (apiKey, baseUrl, apiVersion) 复用与重建", async () => {
    decisionsCreate.mockResolvedValue({
      answers: {
        ad: { type: "noul", noul: AD_DETECT_DECISION_AD_THRESHOLD - 0.05, confidence: 0.75 },
        category: { type: "choice", choice: "not_ad", confidence: 0.8, probabilities: { not_ad: 0.8 } },
        sticker_pack_0: { type: "noul", noul: 0.99, confidence: 0.99 },
      },
      usage: { total_input_tokens: 100 },
    });

    const first = await classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "rules",
      fact: "fact",
      userContent: "1. 闲聊",
      stickerPackCandidates: ["PromoStickers"],
      errorLabel: "Test decision",
    });
    expect(first).toEqual({
      isAd: false,
      reason: `decision(${(AD_DETECT_DECISION_AD_THRESHOLD - 0.05).toFixed(2)}): not_ad`,
    });

    // 同配置复用客户端
    await classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "rules",
      fact: "fact",
      userContent: "2. 继续闲聊",
      errorLabel: "Test decision",
    });
    expect(constructions).toHaveLength(1);

    // 端点版本切换后按新 key 重建客户端
    currentConfig = {
      ...currentConfig,
      baseUrl: "https://proxy.example/v1alpha/decisions",
    };
    await classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "rules",
      fact: "fact",
      userContent: "3. 切换端点",
      errorLabel: "Test decision",
    });
    expect(constructions).toHaveLength(2);
    expect(constructions[1]).toMatchObject({
      httpOptions: {
        baseUrl: "https://proxy.example",
        apiVersion: "v1alpha",
      },
    });
  });

  test("prompt_feedback.block_reason 为 null 或空白串时不误判为拦截，非空字符串才 fail-closed", async () => {
    const reported: AiCacheUsage[] = [];
    installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });

    for (const blockReason of [null, "", "   "]) {
      decisionsCreate.mockResolvedValueOnce({
        prompt_feedback: { block_reason: blockReason },
        answers: {
          ad: { type: "noul", noul: 0.1, confidence: 0.9 },
          category: { type: "choice", choice: "not_ad", confidence: 0.9, probabilities: { not_ad: 0.9 } },
        },
        usage: { total_input_tokens: 90 },
      });
      await expect(classifyWithGoogleDecision({
        model: "gemini-decision-test",
        instructions: "rules",
        fact: "fact",
        userContent: "1. 正常消息",
        errorLabel: "Test decision",
      })).resolves.toEqual({
        isAd: false,
        reason: "decision(0.10): not_ad",
      });
    }
    expect(warnLogs).toHaveLength(0);

    // 缺少 category 回答时回退为默认类别标签（ad / not_ad）。
    decisionsCreate.mockResolvedValueOnce({
      answers: {
        ad: { type: "noul", noul: AD_DETECT_DECISION_AD_THRESHOLD + 0.05, confidence: 0.85 },
      },
      usage: { total_input_tokens: 80 },
    });
    await expect(classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "rules",
      fact: "fact",
      userContent: "1. 广告无分类",
      errorLabel: "Test decision",
    })).resolves.toEqual({
      isAd: true,
      reason: `decision(${(AD_DETECT_DECISION_AD_THRESHOLD + 0.05).toFixed(2)}): ad`,
    });

    // 拦截响应若带 usage 仍照常记账并 fail-closed。
    decisionsCreate.mockResolvedValueOnce({
      prompt_feedback: { block_reason: "safety" },
      usage: { total_input_tokens: 75 },
    });
    await expect(classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "rules",
      fact: "fact",
      userContent: "1. blocked with usage",
      errorLabel: "Test decision",
    })).resolves.toBeNull();
    expect(warnLogs).toEqual([[
      "Ad detection decision input was blocked.",
      { errorLabel: "Test decision", blockReason: "safety" },
    ]]);
    expect(reported).toHaveLength(5);
    expect(reported[4]).toMatchObject({ capability: "ad_detect", inputTokens: 75 });

    // 非 Google provider 配置拒绝构造客户端并 fail-closed。
    currentConfig = {
      provider: "openai",
      apiKey: "openai-key",
      baseUrl: undefined,
      model: "gpt-test",
    };
    await expect(classifyWithGoogleDecision({
      model: "gpt-test",
      instructions: "rules",
      fact: "fact",
      userContent: "1. wrong provider",
      errorLabel: "Test decision",
    })).resolves.toBeNull();
    expect(errorLogs).toHaveLength(1);
  });

  test("prompt_feedback 拦截、畸形答案与带数值 status 的 NextGen 异常一律 fail-closed 返回 null", async () => {
    decisionsCreate.mockResolvedValueOnce({
      prompt_feedback: { block_reason: "safety" },
    });
    await expect(classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "rules",
      fact: "fact",
      userContent: "1. blocked",
      errorLabel: "Test decision",
    })).resolves.toBeNull();
    expect(warnLogs).toEqual([[
      "Ad detection decision input was blocked.",
      { errorLabel: "Test decision", blockReason: "safety" },
    ]]);

    for (const malformed of [
      { answers: {} },
      { answers: { ad: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1 } } } },
      { answers: { ad: { type: "noul", noul: Number.NaN, confidence: 1 } } },
      { answers: { ad: { type: "noul", noul: 1.5, confidence: 1 } } },
    ]) {
      decisionsCreate.mockResolvedValueOnce(malformed);
      await expect(classifyWithGoogleDecision({
        model: "gemini-decision-test",
        instructions: "rules",
        fact: "fact",
        userContent: "1. malformed",
        errorLabel: "Test decision",
      })).resolves.toBeNull();
    }

    errorLogs.length = 0;
    const nextGenError: Error & { status: number } = Object.assign(
      new Error("quota exceeded"),
      { status: 429 }
    );
    decisionsCreate.mockRejectedValueOnce(nextGenError);
    await expect(classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "rules",
      fact: "fact",
      userContent: "1. api err",
      errorLabel: "Test decision",
    })).resolves.toBeNull();
    expect(errorLogs[0]).toEqual([
      "Ad detection decision API request failed.",
      { errorLabel: "Test decision", status: 429, errorMessage: "quota exceeded" },
    ]);

    decisionsCreate.mockRejectedValueOnce(new Error("network down"));
    await expect(classifyWithGoogleDecision({
      model: "gemini-decision-test",
      instructions: "rules",
      fact: "fact",
      userContent: "1. net err",
      errorLabel: "Test decision",
    })).resolves.toBeNull();
    expect(errorLogs[1]).toEqual([
      "Ad detection decision request failed:",
      { errorLabel: "Test decision" },
      expect.objectContaining({ message: "network down" }),
    ]);
  });
});
