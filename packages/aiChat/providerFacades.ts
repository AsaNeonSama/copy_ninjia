/**
 * AI 各能力门面构造器（归属 AI 闲聊 Worker）：将供应商实现绑定到配额 lane 与调度优先级。
 * @see ../../docs/cn/04-invariants.md
 */

import { claimOperatorTtsUsage, refundOperatorTtsUsage } from "./ai/ttsUsage";
import { failedReplyTurn } from "./ai/utils/replyTurn";
import { ttsQuotaLimit } from "./ai/utils/ttsUsageWindow";
import { quotaRunnerFor } from "./providerLanes";
import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type { GeneratedChatImage } from "../types/aiChat/imageGeneration";
import type {
  AiChatProvider,
  AiImageProvider,
  AiImageRequest,
  AiJsonRequest,
  AiMediaProvider,
  AiMeteredSpeechRequest,
  AiProviderTaskPriority,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiSpeechFacade,
  AiSpeechProvider,
  AiStructuredTextProvider,
  AiSummaryProvider,
  AiTextProvider,
  AiTextRequest,
  AiTextResult,
  AiVisionRequest,
  AiVoiceRequest,
  AiWebSearchCapability,
  AiWebSearchFacade,
  AiWebSearchRequest,
  AiWebSearchResult,
} from "../types/aiChat/provider";
import type { SpeechSynthesisAttempt, SynthesizedSpeech, TtsOperatorClaim } from "../types/aiChat/voiceMessage";
import type { AgentCapabilityConfig, AgentTtsCapabilityConfig } from "../types/config";

/**
 * 配额 lane 队列已满或排队期间被取消时回复轮次的回退结算值。
 * @returns 带 `LOCAL_PROVIDER_QUEUE_FULL` 终止原因的失败回复轮次结果。
 */
function queueRejectedReplyTurn(): AiReplyTurn {
  return failedReplyTurn({ webSearchCalls: 0, finishReason: "LOCAL_PROVIDER_QUEUE_FULL" });
}

/**
 * 配额 lane 队列已满或排队期间被取消时文本生成请求的回退结算值。
 * @returns 不可重试的失败文本生成结果。
 */
function queueRejectedTextResult(): AiTextResult {
  return { ok: false, retryable: false };
}

/**
 * 配额 lane 队列已满或排队期间被取消时语音合成请求的回退结算值。
 * @returns 标记为合成失败的语音合成尝试结果。
 */
function queueRejectedSpeechAttempt(): SpeechSynthesisAttempt {
  return { ok: false, reason: "synthesis failed" };
}

/**
 * 配额 lane 队列已满或排队期间被取消时联网检索请求的回退结算值。
 * @returns 检索次数为 0 的失败联网检索结果。
 */
function queueRejectedWebSearchResult(): AiWebSearchResult {
  return { ok: false, searchCalls: 0 };
}

/** runScheduled 的入参。 */
interface ScheduledRunParams<T> {
  /** 目标配额 lane 的有界任务执行器。 */
  readonly runner: PrioritizedBoundedTaskRunner;
  /** 本次调用的调度优先级。 */
  readonly priority: AiProviderTaskPriority;
  /** 外部取消信号。 */
  readonly signal: AbortSignal | undefined;
  /** 队列已满或排队期间被取消时构造结算值。 */
  readonly fallback: () => T;
  /** 排到执行位后实际发起供应商调用的任务回调。 */
  readonly task: () => Promise<T>;
}

/**
 * 将供应商调用交由配额 lane 排队执行；未执行时返回 fallback 结果。
 * @param params 配额 lane 执行器、调度优先级、取消信号、拒绝回退构造器与实际任务回调。
 * @returns 任务执行结果，或队列拒绝/排队取消时的 `fallback` 返回值。
 */
async function runScheduled<T>({ runner, priority, signal, fallback, task }: ScheduledRunParams<T>): Promise<T> {
  const result: T | undefined = await runner.run(priority, task, signal);
  return result ?? fallback();
}

/**
 * 构造绑定配额 lane 的群聊多轮回复门面。
 * @param provider 底层供应商实现。
 * @param config `text` 能力部署配置。
 * @returns 经配额 lane 交互优先级排队的文本回复门面。
 */
export function createTextFacade(
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

/**
 * 构造绑定配额 lane 的后台摘要生成门面。
 * @param provider 底层供应商实现。
 * @param config `summary` 能力部署配置。
 * @returns 经配额 lane 后台优先级排队的摘要生成门面。
 */
export function createSummaryFacade(
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

/**
 * 构造绑定配额 lane 与指定优先级的媒体理解（视觉描述与语音转写）门面。
 * @param provider 底层供应商实现。
 * @param config `media` 能力部署配置。
 * @param priority 媒体请求在配额 lane 中的调度优先级。
 * @returns 绑定指定优先级的媒体能力门面。
 */
export function createMediaFacade(
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

/**
 * 构造生图门面；所选供应商未实现 `generateImage` 时返回 null。
 * @param provider 底层供应商实现。
 * @param config `image` 能力部署配置。
 * @returns 经配额 lane 交互优先级排队的生图门面；供应商不支持生图时返回 `null`。
 */
export function createImageFacade(
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
 * 构造语音合成门面：`operator` 口径在轮到执行时扣减每日额度并在合成失败时退还，`ai` 口径由调用方自行管理额度；
 * 底层供应商未实现 `synthesizeSpeech` 时返回不含 `synthesizeSpeech` 方法的 `{ name }` 门面。
 * @param provider 底层供应商实现。
 * @param config `tts` 能力部署配置。
 * @returns 绑定配额 lane 的语音合成门面对象（不支持语音合成时仅含 `name`）。
 */
export function createSpeechFacade(
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
export interface WebSearchFacadeParams {
  /** 底层供应商实现。 */
  readonly provider: AiChatProvider;
  /** 绑定的能力名称。 */
  readonly capability: AiWebSearchCapability;
  /** 能力部署配置。 */
  readonly config: AgentCapabilityConfig;
  /** 配额 lane 调度优先级。 */
  readonly priority: AiProviderTaskPriority;
}

/**
 * 构造绑定指定能力与优先级的联网检索门面。
 * @param params 底层供应商实现、目标能力槽位、能力部署配置与配额 lane 调度优先级。
 * @returns 联网检索门面对象。
 */
export function createWebSearchFacade({
  provider,
  capability,
  config,
  priority,
}: WebSearchFacadeParams): AiWebSearchFacade {
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

/**
 * 构造 text 能力的后台结构化 JSON 生成门面。
 * @param provider 底层供应商实现。
 * @param config `text` 能力部署配置。
 * @returns 经配额 lane 后台优先级排队的结构化 JSON 生成门面。
 */
export function createStructuredTextFacade(
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
