import { getTimeZone } from "../../../packages/config/time";
import { afterEach, describe, expect, test } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import {
  adDetectCapacitySaturated,
  adDetectPrompts,
  adDetectQueue,
  adDetectVisionSupport,
  adPackBlacklistCounts,
  pendingAdBundleCount,
  pendingAdMessages,
  queuedAdDetectKeys,
} from "../../../packages/cache/workers/antiRaid/adDetect";
import { adDetectAnthropicClientHolder } from "../../../packages/cache/workers/antiRaid/anthropic";
import {
  adDetectGoogleClientHolder,
  adDetectGoogleDecisionClientHolder,
} from "../../../packages/cache/workers/antiRaid/google";
import { adDetectOpenAiClientHolder } from "../../../packages/cache/workers/antiRaid/openai";
import {
  adDetectAgentConfigCache,
  defaultAdDetectConfigCache,
} from "../../../packages/cache/perThread/config";
import {
  clearPendingAdBundles,
  storeBundle,
} from "../../../packages/workers/antiRaid/adDetect/queueState";
import type { AdDetectPrompts } from "../../../packages/types/antiRaid/adDetect";
import type { AdDetectAgentConfig, AdDetectConfig } from "../../../packages/types/config";

const {
  adoptAdDetectConfigMessage,
  adoptAdPackBlacklistSyncMessage,
} = await import("../../../packages/workers/antiRaid/adDetect/config");

const originalAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
const originalSamples: AdDetectConfig | null = defaultAdDetectConfigCache.current;

const reloadedAdDetect: AdDetectAgentConfig = {
  provider: "openai",
  apiKey: "reloaded-ad-key",
  baseUrl: "https://ad.example/v1",
  model: "reloaded-ad-model",
};

const OLD_PROMPTS: AdDetectPrompts = {
  instructions: "old instructions",
  justJoinedSystemPrompt: "old prompt",
  establishedSystemPrompt: "old prompt",
};

/** 装上按旧快照派生的客户端、视觉探测态与提示词缓存。 */
function seedDerivedState(): void {
  adDetectGoogleClientHolder.current = {} as GoogleGenAI;
  adDetectGoogleDecisionClientHolder.current = { key: "old", client: {} as GoogleGenAI };
  adDetectOpenAiClientHolder.current = {} as OpenAI;
  adDetectAnthropicClientHolder.current = {} as NonNullable<typeof adDetectAnthropicClientHolder.current>;
  adDetectPrompts.current = OLD_PROMPTS;
  adDetectVisionSupport.current = "unsupported";
}

afterEach((): void => {
  adDetectAgentConfigCache.current = originalAdDetect;
  defaultAdDetectConfigCache.current = originalSamples;
  adDetectGoogleClientHolder.current = null;
  adDetectGoogleDecisionClientHolder.current = null;
  adDetectOpenAiClientHolder.current = null;
  adDetectAnthropicClientHolder.current = null;
  adDetectPrompts.current = null;
  adDetectVisionSupport.current = "unknown";
  adPackBlacklistCounts.sticker = 0;
  adPackBlacklistCounts.emoji = 0;
  adDetectQueue.clear();
  queuedAdDetectKeys.clear();
  clearPendingAdBundles();
  adDetectCapacitySaturated.current = false;
});

describe("Anti-Raid Worker 接管广告检测配置", () => {
  test("新快照整体替换 holder，并丢弃旧客户端与提示词缓存", () => {
    adDetectAgentConfigCache.current = { ...reloadedAdDetect, apiKey: "old-ad-key" };
    seedDerivedState();
    const samples: AdDetectConfig = {
      punishment: { kind: "kick", blockScope: "global" },
      samples: ["新的广告示例"],
    };

    adoptAdDetectConfigMessage({
      atmosphere: "teasing",
      type: "agentConfig",
      timeZone: getTimeZone(),
      logLevel: "operation",
      adDetect: reloadedAdDetect,
      adDetectConfig: samples,
    });

    expect(adDetectAgentConfigCache.current).toBe(reloadedAdDetect);
    expect(defaultAdDetectConfigCache.current).toBe(samples);
    expect(adDetectGoogleClientHolder.current).toBeNull();
    expect(adDetectGoogleDecisionClientHolder.current).toBeNull();
    expect(adDetectOpenAiClientHolder.current).toBeNull();
    expect(adDetectAnthropicClientHolder.current).toBeNull();
    expect(adDetectPrompts.current).toBeNull();
    expect(adDetectVisionSupport.current).toBe("unknown");
  });

  test("切换为 Google provider 时整体更新快照并清空旧客户端", () => {
    const googleAdDetect: AdDetectAgentConfig = {
      provider: "google",
      apiKey: "google-ad-key",
      baseUrl: undefined,
      model: "gemini-4-argon",
      useDecision: false,
    };
    adDetectAgentConfigCache.current = { ...reloadedAdDetect };
    seedDerivedState();

    adoptAdDetectConfigMessage({
      atmosphere: "teasing",
      type: "agentConfig",
      timeZone: getTimeZone(),
      logLevel: "operation",
      adDetect: googleAdDetect,
      adDetectConfig: { punishment: { kind: "kick", blockScope: "global" }, samples: ["广告示例"] },
    });

    expect<AdDetectAgentConfig | null>(adDetectAgentConfigCache.current).toBe(googleAdDetect);
    expect(adDetectGoogleClientHolder.current).toBeNull();
    expect(adDetectOpenAiClientHolder.current).toBeNull();
    expect(adDetectPrompts.current).toBeNull();
  });

  test("仅更新广告检测示例时清空提示词缓存并重置客户端", () => {
    adDetectAgentConfigCache.current = { ...reloadedAdDetect };
    seedDerivedState();
    const updatedSamples: AdDetectConfig = {
      punishment: { kind: "kick", blockScope: "global" },
      samples: ["新的广告示例"],
    };

    adoptAdDetectConfigMessage({
      atmosphere: "teasing",
      type: "agentConfig",
      timeZone: getTimeZone(),
      logLevel: "operation",
      adDetect: reloadedAdDetect,
      adDetectConfig: updatedSamples,
    });

    expect(defaultAdDetectConfigCache.current).toBe(updatedSamples);
    expect(adDetectGoogleClientHolder.current).toBeNull();
    expect(adDetectOpenAiClientHolder.current).toBeNull();
    expect(adDetectPrompts.current).toBeNull();
  });

  test("adPackBlacklistSync 只更新黑名单计数镜像，绝不清空 AI SDK 客户端、提示词缓存或视觉探测态", () => {
    adDetectAgentConfigCache.current = { ...reloadedAdDetect };
    seedDerivedState();
    const googleClient: GoogleGenAI | null = adDetectGoogleClientHolder.current;
    const googleDecisionClient = adDetectGoogleDecisionClientHolder.current;
    const openAiClient: OpenAI | null = adDetectOpenAiClientHolder.current;
    const anthropicClient: typeof adDetectAnthropicClientHolder.current = adDetectAnthropicClientHolder.current;

    adoptAdPackBlacklistSyncMessage({
      type: "adPackBlacklistSync",
      stickerCount: 2,
      emojiCount: 1,
    });

    expect(adPackBlacklistCounts).toEqual({ sticker: 2, emoji: 1 });
    expect(adDetectGoogleClientHolder.current).toBe(googleClient);
    expect(adDetectGoogleDecisionClientHolder.current).toBe(googleDecisionClient);
    expect(adDetectOpenAiClientHolder.current).toBe(openAiClient);
    expect(adDetectAnthropicClientHolder.current).toBe(anthropicClient);
    expect(adDetectPrompts.current).toBe(OLD_PROMPTS);
    expect(adDetectVisionSupport.current).toBe("unsupported");
  });

  test("广告检测不可用时示例 holder 与提示词缓存保持不动，ad_detect 显式写 null", () => {
    adDetectAgentConfigCache.current = { ...reloadedAdDetect };
    seedDerivedState();

    adoptAdDetectConfigMessage({
      atmosphere: "teasing",
      type: "agentConfig",
      timeZone: getTimeZone(),
      logLevel: "operation",
      adDetect: null,
      adDetectConfig: null,
    });

    expect(adDetectAgentConfigCache.current).toBeNull();
    expect(defaultAdDetectConfigCache.current).toBe(originalSamples);
    expect(adDetectPrompts.current).toBe(OLD_PROMPTS);
    expect(adDetectGoogleClientHolder.current).toBeNull();
    expect(adDetectOpenAiClientHolder.current).toBeNull();
  });

  test("热重载使广告检测整体不可用时清空待检队列、消息串索引与容量饱和标记", () => {
    const seedPending = (): void => {
      queuedAdDetectKeys.add("-1001:7");
      adDetectQueue.push("-1001:7");
      storeBundle({
        key: "-1001:7",
        chatId: -1001,
        senderId: 7,
        meta: { firstName: "Spam", lastName: "", username: "spam" },
        senderName: "Spam",
        isChannel: false,
        justJoined: false,
        entries: [],
        pendingDeleteIds: [],
        pendingDeleteOverflowed: false,
        uncheckedEvicted: false,
        nextSeq: 1,
        checkedSeq: 0,
      });
      adDetectCapacitySaturated.current = true;
    };

    seedPending();
    adoptAdDetectConfigMessage({
      atmosphere: "teasing",
      type: "agentConfig",
      timeZone: getTimeZone(),
      logLevel: "operation",
      adDetect: null,
      adDetectConfig: {
        punishment: { kind: "kick", blockScope: "global" },
        samples: [],
      },
    });
    expect(adDetectQueue.size).toBe(0);
    expect(queuedAdDetectKeys.size).toBe(0);
    expect(pendingAdMessages.size).toBe(0);
    expect(pendingAdBundleCount.current).toBe(0);
    expect(adDetectCapacitySaturated.current).toBeFalse();

    seedPending();
    adoptAdDetectConfigMessage({
      atmosphere: "teasing",
      type: "agentConfig",
      timeZone: getTimeZone(),
      logLevel: "operation",
      adDetect: reloadedAdDetect,
      adDetectConfig: null,
    });
    expect(adDetectQueue.size).toBe(0);
    expect(queuedAdDetectKeys.size).toBe(0);
    expect(pendingAdMessages.size).toBe(0);
    expect(pendingAdBundleCount.current).toBe(0);
    expect(adDetectCapacitySaturated.current).toBeFalse();
  });
});
