/**
 * AI 能力门面与供应商路由入口（归属 AI 闲聊 Worker）。
 * 各能力按部署配置的 `provider` 路由到对应实现并经配额 lane 排队。
 * @see ../../docs/cn/04-invariants.md
 */

import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { TEXT_GEMINI_CONTEXT_CACHE_SCOPE } from "./gemini/contextCache";
import { openAiProvider } from "./openai";
import {
  aiProviderFacades,
  resetAiProviderFacades,
} from "../cache/workers/aiChat/providerScheduler";
import { geminiClientCache } from "../cache/workers/aiChat/gemini";
import { textGeminiContextCache } from "../cache/workers/aiChat/geminiContextCache";
import { resetMediaInputSupport } from "../cache/workers/aiChat/mediaInputSupport";
import { openAiClientCache } from "../cache/workers/aiChat/openai";
import { anthropicClientCache } from "../cache/workers/aiChat/anthropic";
import { adoptAgentDeploymentConfig, getAgentDeploymentConfig, requireAgentCapabilityConfig } from "../config/agent";
import { probeGeminiContextCache } from "../infra/geminiContextCache";
import { logger } from "../infra/logger";
import {
  createImageFacade,
  createMediaFacade,
  createSpeechFacade,
  createStructuredTextFacade,
  createSummaryFacade,
  createTextFacade,
  createWebSearchFacade,
} from "./providerFacades";
import { pruneQuotaLanes } from "./providerLanes";
import type {
  AgentDeploymentConfig,
  AgentCapabilityConfig,
  AgentImageCapabilityConfig,
  AgentTtsCapabilityConfig,
} from "../types/config";
import type {
  AiChatProvider,
  AiImageProvider,
  AiMediaProvider,
  AiProviderTaskPriority,
  AiSpeechFacade,
  AiSummaryProvider,
  AiTextProvider,
  AiStructuredTextProvider,
  AiWebSearchFacade,
} from "../types/aiChat/provider";

/** provider 到实现包的映射。 */
const AI_CHAT_PROVIDERS: Readonly<Record<AgentCapabilityConfig["provider"], AiChatProvider>> = {
  google: geminiProvider,
  openai: openAiProvider,
  anthropic: anthropicProvider,
};

/**
 * 获取带工具往返的群聊正文门面（交互优先级）。
 * @returns 缓存或新建的群聊正文门面。
 */
export function textAiProvider(): AiTextProvider {
  if (aiProviderFacades.text !== undefined) return aiProviderFacades.text;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("text");
  const facade: AiTextProvider = createTextFacade(AI_CHAT_PROVIDERS[config.provider], config);
  aiProviderFacades.text = facade;
  return facade;
}

/**
 * 获取记忆压缩与贴纸包简介的无状态摘要门面（后台优先级）。
 * @returns 缓存或新建的摘要生成门面。
 */
export function summaryAiProvider(): AiSummaryProvider {
  if (aiProviderFacades.summary !== undefined) return aiProviderFacades.summary;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("summary");
  const facade: AiSummaryProvider = createSummaryFacade(AI_CHAT_PROVIDERS[config.provider], config);
  aiProviderFacades.summary = facade;
  return facade;
}

/**
 * 获取视觉描述与语音转写门面；默认交互优先级，可显式指定后台优先级。
 * @param priority 配额 lane 调度优先级，默认 `"interactive"`。
 * @returns 对应优先级的缓存或新建媒体门面。
 */
export function mediaAiProvider(
  priority: AiProviderTaskPriority = "interactive"
): AiMediaProvider {
  const cached: AiMediaProvider | undefined = priority === "interactive"
    ? aiProviderFacades.media
    : aiProviderFacades.mediaBackground;
  if (cached !== undefined) return cached;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("media");
  const facade: AiMediaProvider = createMediaFacade(
    AI_CHAT_PROVIDERS[config.provider],
    config,
    priority
  );
  if (priority === "interactive") aiProviderFacades.media = facade;
  else aiProviderFacades.mediaBackground = facade;
  return facade;
}

/** optionalCapabilityFacade 的入参。 */
interface OptionalCapabilityFacadeParams<TCapability extends "image" | "tts" | "webSearch", TFacade> {
  /** AgentDeploymentConfig 上的能力字段名。 */
  readonly capability: TCapability;
  /** 当前缓存值；`undefined` 表示尚未初始化，`null` 表示已确认不可用。 */
  readonly cached: TFacade | null | undefined;
  /** 配置存在时构造门面；所选实现不支持该能力时返回 null。 */
  readonly create: (config: NonNullable<AgentDeploymentConfig[TCapability]>) => TFacade | null;
  /** 写回门面缓存槽位。 */
  readonly store: (facade: TFacade | null) => void;
}

/**
 * 获取并缓存可选能力（image、tts、webSearch）的门面。
 * @param params 可选能力门面的缓存读取、构造与回写参数。
 * @returns 能力门面实例；未配置或所选供应商不支持时返回 `null`。
 */
function optionalCapabilityFacade<TCapability extends "image" | "tts" | "webSearch", TFacade>({
  capability,
  cached,
  create,
  store,
}: OptionalCapabilityFacadeParams<TCapability, TFacade>): TFacade | null {
  if (cached !== undefined) return cached;
  const config: AgentDeploymentConfig[TCapability] = getAgentDeploymentConfig()[capability];
  if (config === undefined) {
    store(null);
    return null;
  }
  const facade: TFacade | null = create(config);
  store(facade);
  return facade;
}

/**
 * 获取生图能力门面；未配置或所选供应商未实现生图时返回 null。
 * @returns 生图能力门面；不可用时返回 `null`。
 */
export function imageAiProvider(): AiImageProvider | null {
  return optionalCapabilityFacade<"image", AiImageProvider>({
    capability: "image",
    cached: aiProviderFacades.image,
    create: (config: AgentImageCapabilityConfig): AiImageProvider | null =>
      createImageFacade(AI_CHAT_PROVIDERS[config.provider], config),
    store: (facade: AiImageProvider | null): void => { aiProviderFacades.image = facade; },
  });
}

/**
 * 获取语音合成能力门面；未配置时返回 null。
 * @returns 语音合成门面；未配置 `tts` 时返回 `null`。
 */
export function ttsAiProvider(): AiSpeechFacade | null {
  return optionalCapabilityFacade<"tts", AiSpeechFacade>({
    capability: "tts",
    cached: aiProviderFacades.tts,
    create: (config: AgentTtsCapabilityConfig): AiSpeechFacade =>
      createSpeechFacade(AI_CHAT_PROVIDERS[config.provider], config),
    store: (facade: AiSpeechFacade | null): void => { aiProviderFacades.tts = facade; },
  });
}

/**
 * 获取独立 `web_search` 能力的联网检索门面（交互优先级）；未配置时返回 null。
 * @returns 独立联网检索门面；未配置 `web_search` 时返回 `null`。
 */
export function webSearchAiProvider(): AiWebSearchFacade | null {
  return optionalCapabilityFacade<"webSearch", AiWebSearchFacade>({
    capability: "webSearch",
    cached: aiProviderFacades.webSearch,
    create: (config: AgentCapabilityConfig): AiWebSearchFacade => createWebSearchFacade({
      provider: AI_CHAT_PROVIDERS[config.provider],
      capability: "web_search",
      config,
      priority: "interactive",
    }),
    store: (facade: AiWebSearchFacade | null): void => { aiProviderFacades.webSearch = facade; },
  });
}

/**
 * 获取复用 `text` 模型配置的联网检索门面（后台优先级）。
 * @returns 复用 `text` 配置的后台联网检索门面。
 */
export function textWebSearchAiProvider(): AiWebSearchFacade {
  if (aiProviderFacades.textWebSearch !== undefined) return aiProviderFacades.textWebSearch;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("text");
  const facade: AiWebSearchFacade = createWebSearchFacade({
    provider: AI_CHAT_PROVIDERS[config.provider],
    capability: "text",
    config,
    priority: "background",
  });
  aiProviderFacades.textWebSearch = facade;
  return facade;
}

/**
 * 获取复用 `text` 模型配置的结构化 JSON 生成门面（后台优先级）。
 * @returns 复用 `text` 配置的后台结构化 JSON 生成门面。
 */
export function structuredTextAiProvider(): AiStructuredTextProvider {
  if (aiProviderFacades.structuredText !== undefined) return aiProviderFacades.structuredText;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("text");
  const facade: AiStructuredTextProvider = createStructuredTextFacade(AI_CHAT_PROVIDERS[config.provider], config);
  aiProviderFacades.structuredText = facade;
  return facade;
}

/**
 * 检查当前配置的供应商是否缺失语音合成或语音转写实现，若缺失则记录告警日志。
 */
export function reportUnimplementedAgentCapabilities(): void {
  const config: AgentDeploymentConfig = getAgentDeploymentConfig();
  const tts: AgentTtsCapabilityConfig | undefined = config.tts;
  if (tts !== undefined && AI_CHAT_PROVIDERS[tts.provider].synthesizeSpeech === undefined) {
    logger.warn(
      `Speech synthesis stays unavailable: $.agent.tts selects the "${tts.provider}" provider, ` +
      "which does not implement it. The send_voice tool will not be registered."
    );
  }
  if (AI_CHAT_PROVIDERS[config.media.provider].transcribeVoice === undefined) {
    logger.warn(
      `Voice transcription stays unavailable: $.agent.media selects the "${config.media.provider}" provider, ` +
      "which does not implement it. Voice messages will fall back to a placeholder in the transcript."
    );
  }
}

/**
 * 接管热重载的 agent 配置快照：重置门面与客户端缓存、修剪不再引用的配额 lane，
 * 并在 text 或 media 配置变化时重置对应的上下文缓存或模态支持探测状态；新 text 选用 Google 时随即在后台探测显式缓存支持度。
 * @param config 热重载后的完整 agent 部署配置快照。
 */
export function reloadAgentDeploymentConfig(config: AgentDeploymentConfig): void {
  const previous: AgentDeploymentConfig = getAgentDeploymentConfig();
  const previousMedia: AgentCapabilityConfig = previous.media;
  const previousText: AgentCapabilityConfig = previous.text;
  const textChanged: boolean = !Bun.deepEquals(previousText, config.text);
  adoptAgentDeploymentConfig(config);
  resetAiProviderFacades();
  geminiClientCache.current = null;
  openAiClientCache.current = null;
  anthropicClientCache.current = null;
  if (textChanged) {
    textGeminiContextCache.current = null;
    if (config.text.provider === "google") probeGeminiContextCache(TEXT_GEMINI_CONTEXT_CACHE_SCOPE);
  }
  pruneQuotaLanes(config);
  if (!Bun.deepEquals(previousMedia, config.media)) resetMediaInputSupport();
  reportUnimplementedAgentCapabilities();
}
