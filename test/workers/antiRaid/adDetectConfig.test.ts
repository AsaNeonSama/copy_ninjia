import { getTimeZone } from "../../../packages/config/time";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { adDetectPrompts } from "../../../packages/cache/workers/antiRaid/adDetect";
import { adDetectGeminiContextCache } from "../../../packages/cache/workers/antiRaid/geminiContextCache";
import { adDetectGoogleClientHolder } from "../../../packages/cache/workers/antiRaid/google";
import { adDetectOpenAiClientHolder } from "../../../packages/cache/workers/antiRaid/openai";
import {
  adDetectAgentConfigCache,
  defaultAdSampleConfigCache,
} from "../../../packages/cache/perThread/config";
import type { AdDetectPrompts } from "../../../packages/types/antiRaid/adDetect";
import type { AdDetectAgentConfig, AdSampleConfig } from "../../../packages/types/config";
import type { GeminiContextCacheRegistry } from "../../../packages/types/geminiContextCache";

const probeGeminiContextCache = mock((..._args: unknown[]): void => {});
const realGeminiContextCache = await import("../../../packages/infra/geminiContextCache");
mock.module("../../../packages/infra/geminiContextCache", () => ({
  ...realGeminiContextCache,
  probeGeminiContextCache,
}));

const { adoptAdDetectConfigMessage } = await import("../../../packages/workers/antiRaid/adDetect/config");
const { AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE } = await import("../../../packages/workers/antiRaid/adDetect/ai/google");
const { createGeminiContextCacheRegistry } = realGeminiContextCache;

const originalAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
const originalSamples: AdSampleConfig | null = defaultAdSampleConfigCache.current;

const reloadedAdDetect: AdDetectAgentConfig = {
  provider: "openai",
  apiKey: "reloaded-ad-key",
  baseUrl: "https://ad.example/v1",
  headers: undefined,
  model: "reloaded-ad-model",
};

const OLD_PROMPTS: AdDetectPrompts = {
  instructions: "old instructions",
  justJoinedSystemPrompt: "old prompt",
  establishedSystemPrompt: "old prompt",
};

/** 装上按旧快照派生的客户端、提示词缓存与显式缓存状态；返回装上的登记表。 */
function seedDerivedState(): GeminiContextCacheRegistry {
  adDetectGoogleClientHolder.current = {} as GoogleGenAI;
  adDetectOpenAiClientHolder.current = {} as OpenAI;
  adDetectPrompts.current = OLD_PROMPTS;
  const registry: GeminiContextCacheRegistry = createGeminiContextCacheRegistry({} as GoogleGenAI);
  adDetectGeminiContextCache.current = registry;
  return registry;
}

beforeEach((): void => {
  probeGeminiContextCache.mockClear();
});

afterEach((): void => {
  adDetectAgentConfigCache.current = originalAdDetect;
  defaultAdSampleConfigCache.current = originalSamples;
  adDetectGoogleClientHolder.current = null;
  adDetectOpenAiClientHolder.current = null;
  adDetectPrompts.current = null;
  adDetectGeminiContextCache.current = null;
});

describe("Anti-Raid Worker 接管广告检测配置", () => {
  test("新快照整体替换 holder，并丢弃旧客户端、提示词缓存与显式缓存状态", () => {
    adDetectAgentConfigCache.current = { ...reloadedAdDetect, apiKey: "old-ad-key" };
    seedDerivedState();
    const samples: AdSampleConfig = ["新的广告示例"];

    adoptAdDetectConfigMessage({ atmosphere: "teasing", type: "agentConfig", timeZone: getTimeZone(), adDetect: reloadedAdDetect, adSamples: samples });

    expect(adDetectAgentConfigCache.current).toBe(reloadedAdDetect);
    expect(defaultAdSampleConfigCache.current).toBe(samples);
    expect(adDetectGoogleClientHolder.current).toBeNull();
    expect(adDetectOpenAiClientHolder.current).toBeNull();
    expect(adDetectPrompts.current).toBeNull();
    expect(adDetectGeminiContextCache.current).toBeNull();
    expect(probeGeminiContextCache).not.toHaveBeenCalled();
  });

  test("ad_detect 启动或切换为 Google provider 时启动显式缓存支持度探测，ad_detect 不变时不重复探测", () => {
    const googleAdDetect: AdDetectAgentConfig = {
      provider: "google",
      apiKey: "google-ad-key",
      baseUrl: undefined,
      headers: undefined,
      model: "gemini-4-argon",
    };
    adDetectAgentConfigCache.current = { ...reloadedAdDetect };
    seedDerivedState();

    adoptAdDetectConfigMessage({ atmosphere: "teasing", type: "agentConfig", timeZone: getTimeZone(), adDetect: googleAdDetect, adSamples: ["广告示例"] });

    expect<AdDetectAgentConfig | null>(adDetectAgentConfigCache.current).toBe(googleAdDetect);
    expect(adDetectGeminiContextCache.current).toBeNull();
    expect(probeGeminiContextCache).toHaveBeenCalledTimes(1);
    expect(probeGeminiContextCache).toHaveBeenCalledWith(AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE);

    probeGeminiContextCache.mockClear();
    adoptAdDetectConfigMessage({ atmosphere: "teasing", type: "agentConfig", timeZone: getTimeZone(), adDetect: googleAdDetect, adSamples: ["新的广告示例"] });
    expect(probeGeminiContextCache).not.toHaveBeenCalled();
  });

  test("ad_detect 不变、只换示例时保留显式缓存登记表，只清提示词", () => {
    adDetectAgentConfigCache.current = { ...reloadedAdDetect };
    const registry: GeminiContextCacheRegistry = seedDerivedState();

    adoptAdDetectConfigMessage({ atmosphere: "teasing", type: "agentConfig", timeZone: getTimeZone(), adDetect: reloadedAdDetect, adSamples: ["新的广告示例"] });

    expect(adDetectGeminiContextCache.current).toBe(registry);
    expect(adDetectPrompts.current).toBeNull();
    expect(probeGeminiContextCache).not.toHaveBeenCalled();
  });

  test("广告检测不可用时示例 holder 与提示词缓存保持不动，ad_detect 显式写 null", () => {
    adDetectAgentConfigCache.current = { ...reloadedAdDetect };
    seedDerivedState();

    adoptAdDetectConfigMessage({ atmosphere: "teasing", type: "agentConfig", timeZone: getTimeZone(), adDetect: null, adSamples: null });

    expect(adDetectAgentConfigCache.current).toBeNull();
    expect(defaultAdSampleConfigCache.current).toBe(originalSamples);
    expect(adDetectPrompts.current).toBe(OLD_PROMPTS);
    expect(adDetectGoogleClientHolder.current).toBeNull();
    expect(adDetectOpenAiClientHolder.current).toBeNull();
    // ad_detect 从有到无：旧登记表一并丢弃。
    expect(adDetectGeminiContextCache.current).toBeNull();
    expect(probeGeminiContextCache).not.toHaveBeenCalled();
  });
});
