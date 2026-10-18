/**
 * AI 能力门面与供应商路由入口（归属 AI 闲聊 Worker）。
 * 各能力按部署配置的 `provider` 路由到对应实现并经配额 lane 排队。
 * @see ../../docs/cn/04-invariants.md
 */

import { claimOperatorTtsUsage, refundOperatorTtsUsage } from "./ai/ttsUsage";
import { ttsQuotaLimit } from "./ai/utils/ttsUsageWindow";
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
import { failedReplyTurn } from "./ai/utils/replyTurn";
import { adoptAgentDeploymentConfig, getAgentDeploymentConfig, requireAgentCapabilityConfig } from "../config/agent";
import { probeGeminiContextCache } from "../infra/geminiContextCache";
import { logger } from "../infra/logger";
import { pruneQuotaLanes, quotaRunnerFor } from "./providerLanes";
import type {
  AgentDeploymentConfig,
  AgentCapabilityConfig,
  AgentImageCapabilityConfig,
  AgentTtsCapabilityConfig,
} from "../types/config";
import type {
  AiChatProvider,
  AiImageProvider,
  AiImageRequest,
  AiMediaProvider,
  AiProviderTaskPriority,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiMeteredSpeechRequest,
  AiSpeechFacade,
  AiSpeechProvider,
  AiSummaryProvider,
  AiTextResult,
  AiTextRequest,
  AiTextProvider,
  AiVisionRequest,
  AiVoiceRequest,
  AiJsonRequest,
  AiStructuredTextProvider,
  AiWebSearchCapability,
  AiWebSearchFacade,
  AiWebSearchRequest,
  AiWebSearchResult,
} from "../types/aiChat/provider";
import type { GeneratedChatImage } from "../types/aiChat/imageGeneration";
import type { SpeechSynthesisAttempt, SynthesizedSpeech, TtsOperatorClaim } from "../types/aiChat/voiceMessage";
import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";

/** provider 到实现包的映射。 */
const AI_CHAT_PROVIDERS: Readonly<Record<AgentCapabilityConfig["provider"], AiChatProvider>> = {
  google: geminiProvider,
  openai: openAiProvider,
  anthropic: anthropicProvider,
};

/** 配额 lane 队列已满或排队期间被取消时各能力的回退结算值。 */
function queueRejectedReplyTurn(): AiReplyTurn {
  return failedReplyTurn(0, "LOCAL_PROVIDER_QUEUE_FULL", undefined);
}

function queueRejectedTextResult(): AiTextResult {
  return { ok: false, retryable: false };
}

function queueRejectedSpeechAttempt(): SpeechSynthesisAttempt {
  return { ok: false, reason: "synthesis failed" };
}

function queueRejectedWebSearchResult(): AiWebSearchResult {
  return { ok: false, searchCalls: 0 };
}

/** runScheduled 的入参。 */
interface ScheduledRunParams<T> {
  readonly runner: PrioritizedBoundedTaskRunner;
  readonly priority: AiProviderTaskPriority;
  readonly signal: AbortSignal | undefined;
  /** 队列已满或排队期间被取消时构造结算值。 */
  readonly fallback: () => T;
  readonly task: () => Promise<T>;
}

/** 将供应商调用交由配额 lane 排队执行；未执行时返回 fallback 结果。 */
async function runScheduled<T>({ runner, priority, signal, fallback, task }: ScheduledRunParams<T>): Promise<T> {
  const result: T | undefined = await runner.run(priority, task, signal);
  return result ?? fallback();
}

function createTextFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiTextProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    createReplySession(params: AiReplySessionParams): AiReplySession {
      const session: AiReplySession = provider.createReplySession(params);
      return {
        request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
          return runScheduled({
            runner,
            priority: "interactive",
            signal: params.signal,
            fallback: queueRejectedReplyTurn,
            task: (): Promise<AiReplyTurn> => session.request(request),
          });
        },
        appendToolOutputs: session.appendToolOutputs.bind(session),
      };
    },
  };
}

function createSummaryFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiSummaryProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    generateText(request: AiTextRequest): Promise<AiTextResult> {
      return runScheduled({
        runner,
        priority: "background",
        signal: request.signal,
        fallback: queueRejectedTextResult,
        task: (): Promise<AiTextResult> => provider.generateText(request),
      });
    },
  };
}

function createMediaFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig,
  priority: AiProviderTaskPriority
): AiMediaProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  const transcribeVoice: AiMediaProvider["transcribeVoice"] = provider.transcribeVoice;
  const describeVision: AiMediaProvider["describeVision"] = (
    request: AiVisionRequest
  ): Promise<AiTextResult> => runScheduled({
    runner,
    priority,
    signal: request.signal,
    fallback: queueRejectedTextResult,
    task: (): Promise<AiTextResult> => provider.describeVision(request),
  });
  if (transcribeVoice === undefined) return { name: provider.name, describeVision };
  return {
    name: provider.name,
    describeVision,
    transcribeVoice(request: AiVoiceRequest): Promise<AiTextResult> {
      return runScheduled({
        runner,
        priority,
        signal: request.signal,
        fallback: queueRejectedTextResult,
        task: (): Promise<AiTextResult> => transcribeVoice(request),
      });
    },
  };
}

/** 构造生图门面；所选供应商未实现 `generateImage` 时返回 null。 */
function createImageFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiImageProvider | null {
  const generateImage: AiChatProvider["generateImage"] = provider.generateImage;
  if (generateImage === undefined) return null;
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    generateImage(request: AiImageRequest): Promise<GeneratedChatImage | null> {
      return runScheduled<GeneratedChatImage | null>({
        runner,
        priority: "interactive",
        signal: request.signal,
        fallback: (): null => null,
        task: (): Promise<GeneratedChatImage | null> => generateImage(request),
      });
    },
  };
}

/**
 * 构造语音合成门面：`operator` 口径在轮到执行时扣减每日额度并在合成失败时退还，`ai` 口径由调用方自行管理额度。
 */
function createSpeechFacade(
  provider: AiChatProvider,
  config: AgentTtsCapabilityConfig
): AiSpeechFacade {
  const synthesizeSpeech: AiSpeechProvider["synthesizeSpeech"] = provider.synthesizeSpeech;
  if (synthesizeSpeech === undefined) return { name: provider.name };
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  const synthesize = async (request: AiMeteredSpeechRequest): Promise<SpeechSynthesisAttempt> => {
    let claim: TtsOperatorClaim | null = null;
    if (request.quota === "operator") {
      claim = claimOperatorTtsUsage(ttsQuotaLimit(config, "operator"));
      if (claim === null) return { ok: false, reason: "daily limit reached" };
    }
    let speech: SynthesizedSpeech | null = null;
    try {
      speech = await synthesizeSpeech(request);
    } finally {
      if (speech === null && claim !== null) refundOperatorTtsUsage(claim);
    }
    return speech === null ? { ok: false, reason: "synthesis failed" } : { ok: true, speech };
  };
  return {
    name: provider.name,
    synthesizeSpeech(request: AiMeteredSpeechRequest): Promise<SpeechSynthesisAttempt> {
      return runScheduled({
        runner,
        priority: "interactive",
        signal: request.signal,
        fallback: queueRejectedSpeechAttempt,
        task: (): Promise<SpeechSynthesisAttempt> => synthesize(request),
      });
    },
  };
}

/** createWebSearchFacade 的入参。 */
interface WebSearchFacadeParams {
  readonly provider: AiChatProvider;
  /** 绑定的能力名称。 */
  readonly capability: AiWebSearchCapability;
  readonly config: AgentCapabilityConfig;
  readonly priority: AiProviderTaskPriority;
}

/** 构造绑定指定能力与优先级的联网检索门面。 */
function createWebSearchFacade({ provider, capability, config, priority }: WebSearchFacadeParams): AiWebSearchFacade {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    searchWeb(request: AiWebSearchRequest): Promise<AiWebSearchResult> {
      return runScheduled({
        runner,
        priority,
        signal: request.signal,
        fallback: queueRejectedWebSearchResult,
        task: (): Promise<AiWebSearchResult> => provider.searchWeb(capability, request),
      });
    },
  };
}

/** 构造 text 能力的后台结构化 JSON 生成门面。 */
function createStructuredTextFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiStructuredTextProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    generateJson(request: AiJsonRequest): Promise<AiTextResult> {
      return runScheduled({
        runner,
        priority: "background",
        signal: request.signal,
        fallback: queueRejectedTextResult,
        task: (): Promise<AiTextResult> => provider.generateJson(request),
      });
    },
  };
}

/** 获取带工具往返的群聊正文门面（交互优先级）。 */
export function textAiProvider(): AiTextProvider {
  if (aiProviderFacades.text !== undefined) return aiProviderFacades.text;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("text");
  const facade: AiTextProvider = createTextFacade(AI_CHAT_PROVIDERS[config.provider], config);
  aiProviderFacades.text = facade;
  return facade;
}

/** 获取记忆压缩与贴纸包简介的无状态摘要门面（后台优先级）。 */
export function summaryAiProvider(): AiSummaryProvider {
  if (aiProviderFacades.summary !== undefined) return aiProviderFacades.summary;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("summary");
  const facade: AiSummaryProvider = createSummaryFacade(AI_CHAT_PROVIDERS[config.provider], config);
  aiProviderFacades.summary = facade;
  return facade;
}

/** 获取视觉描述与语音转写门面；默认交互优先级，可显式指定后台优先级。 */
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

/** 获取并缓存可选能力（image、tts、webSearch）的门面。 */
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

/** 获取生图能力门面；未配置或所选供应商未实现生图时返回 null。 */
export function imageAiProvider(): AiImageProvider | null {
  return optionalCapabilityFacade<"image", AiImageProvider>({
    capability: "image",
    cached: aiProviderFacades.image,
    create: (config: AgentImageCapabilityConfig): AiImageProvider | null =>
      createImageFacade(AI_CHAT_PROVIDERS[config.provider], config),
    store: (facade: AiImageProvider | null): void => { aiProviderFacades.image = facade; },
  });
}

/** 获取语音合成能力门面；未配置时返回 null。 */
export function ttsAiProvider(): AiSpeechFacade | null {
  return optionalCapabilityFacade<"tts", AiSpeechFacade>({
    capability: "tts",
    cached: aiProviderFacades.tts,
    create: (config: AgentTtsCapabilityConfig): AiSpeechFacade =>
      createSpeechFacade(AI_CHAT_PROVIDERS[config.provider], config),
    store: (facade: AiSpeechFacade | null): void => { aiProviderFacades.tts = facade; },
  });
}

/** 获取独立 `web_search` 能力的联网检索门面（交互优先级）；未配置时返回 null。 */
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

/** 获取复用 `text` 模型配置的联网检索门面（后台优先级）。 */
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

/** 获取复用 `text` 模型配置的结构化 JSON 生成门面（后台优先级）。 */
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
