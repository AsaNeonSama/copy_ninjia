import {
  MEDIA_CLOSED_RESULT,
  MEDIA_BACKOFF_RESULT,
  MEDIA_TASK_REJECTED_RESULT,
  MEDIA_CANCELLED_RESULT,
  IMAGE_DESCRIPTION_MAX_CHARS,
  MEDIA_DESCRIPTION_ERROR_LABEL,
  SHORT_MEDIA_DESCRIPTION_MAX_CHARS,
} from "../../consts/aiChat/media";
/**
 * 群聊媒体（图片、贴纸、GIF、语音）与贴纸目录的异步解析管线：
 * 统一管理模态探测准入、有界并发执行器与临时去重缓存。
 */

import { logger } from "../../infra/logger";
import { mediaAiProvider } from "../provider";
import { createSharedResult } from "../../libs/sharedResult";
import type { SharedResult } from "../../libs/sharedResult";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import {
  transientDescriptionTasks,
  transientDescriptionCache,
} from "../../cache/workers/aiChat/imageDescription";
import {
  clearMediaInputProbe,
  getMediaInputProbe,
  getMediaInputState,
  isMediaInputProbeCoolingDown,
  recordMediaInputResult,
  setMediaInputProbe,
} from "../../cache/workers/aiChat/mediaInputSupport";
import { isMediaInputClosed } from "../../states/mediaInputSupport";
import { ANIMATION_DESCRIPTION_PROMPT, IMAGE_DESCRIPTION_PROMPT, STICKER_DESCRIPTION_PROMPT } from "../../consts/aiChat/prompts/media";
import type { MediaKind, VisionImage } from "../../types/media";
import { downloadTelegramVisionImage } from "./telegramImage";
import { hasMediaTaskCapacity, mediaTaskRunner, reserveMediaProbeWait } from "../../cache/workers/aiChat/mediaTasks";
import { transcribeVoiceUncached } from "./voiceTranscription";
import type {
  AiTextResult,
  AiProviderTaskPriority,
  MediaInputCapability,
  MediaInputSupport,
} from "../../types/aiChat/provider";
import type { MediaInputModalityState } from "../../types/states/mediaInputSupport";

/** 模态不可用时复用的已完成 Promise。 */
const MEDIA_CLOSED_PROMISE: Promise<AiTextResult> = Promise.resolve(MEDIA_CLOSED_RESULT);

/** 退避期内复用的已完成 Promise。 */
const MEDIA_BACKOFF_PROMISE: Promise<AiTextResult> = Promise.resolve(MEDIA_BACKOFF_RESULT);

/** 跳过解析时复用的空描述 Promise。 */
const SKIPPED_DESCRIPTION_PROMISE: Promise<string | null> = Promise.resolve(null);

/** 按媒体类型选择视觉描述提示词。 */
function promptFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return STICKER_DESCRIPTION_PROMPT;
    case "animation":
      return ANIMATION_DESCRIPTION_PROMPT;
    default:
      return IMAGE_DESCRIPTION_PROMPT;
  }
}

/** 按媒体类型选择视觉描述字符数上限。 */
function maxCharsFor(kind: MediaKind): number {
  return kind === "photo" ? IMAGE_DESCRIPTION_MAX_CHARS : SHORT_MEDIA_DESCRIPTION_MAX_CHARS;
}

/** describeMedia 的入参。 */
export interface DescribeMediaParams {
  /** 媒体类型。 */
  kind: MediaKind;
  /** 待下载的 Telegram file_id（图片与语音为本体，贴纸与 GIF 为本体或缩略图）。 */
  fileId: string;
  /** 临时缓存去重键（file_unique_id）。 */
  fileUniqueId: string;
  /** 语音的 Telegram 声明 MIME；其余媒体为 undefined。 */
  voiceMime: string | undefined;
  /** 当前轮次的取消信号。 */
  signal?: AbortSignal;
}

/**
 * 下载并解析群聊媒体，复用 transientDescriptionCache 按 fileUniqueId 去重合并；失败时返回 null。
 */
export function describeMedia(params: DescribeMediaParams): Promise<string | null> {
  if (params.signal?.aborted === true) return SKIPPED_DESCRIPTION_PROMISE;
  const capability: MediaInputCapability = params.kind === "voice" ? "voice" : "vision";
  if (
    isMediaInputClosed(getMediaInputState(capability).support) ||
    isMediaInputProbeCoolingDown(capability, Date.now())
  ) {
    return SKIPPED_DESCRIPTION_PROMISE;
  }
  const fileUniqueId: string = params.fileUniqueId;
  const cached: Promise<string | null> | undefined = transientDescriptionCache.get(fileUniqueId);
  if (cached) {
    return transientDescriptionTasks.get(cached)?.wait(params.signal) ?? cached;
  }
  if (!hasMediaTaskCapacity(
    getMediaInputState(capability).support !== "supported" && getMediaInputProbe(capability) !== null
  )) return SKIPPED_DESCRIPTION_PROMISE;

  const controller: AbortController = new AbortController();
  const task: SharedResult<string | null> = createSharedResult(
    resolveMedia({ ...params, signal: controller.signal }).then((attempt: AiTextResult): string | null =>
      attempt.ok ? attempt.text : null
    ),
    {
      cancelled: null,
      rejected: null,
      onUnused: (): void => {
        controller.abort();
        if (transientDescriptionCache.peek(fileUniqueId) === pending) transientDescriptionCache.delete(fileUniqueId);
      },
    }
  );
  const pending: Promise<string | null> = task.promise;
  void pending.then((result: string | null): void => {
    transientDescriptionTasks.delete(pending);
    if (result === null && transientDescriptionCache.peek(fileUniqueId) === pending) {
      transientDescriptionCache.delete(fileUniqueId);
    }
  });
  transientDescriptionTasks.set(pending, task);
  transientDescriptionCache.set(fileUniqueId, pending);
  return task.wait(params.signal);
}

/**
 * 为白名单贴纸目录生成单枚贴纸的常驻视觉描述（走后台优先级，不经临时缓存）。
 */
export function describeMediaForStickerCatalog(
  fileId: string,
  signal?: AbortSignal
): Promise<AiTextResult> {
  return runMediaInputRequest(
    "vision",
    (): Promise<AiTextResult> => describeVisionUncached({
      kind: "sticker",
      fileId,
      priority: "background",
      signal,
    }),
    signal
  );
}

/** 按媒体类型分派到语音转写或视觉描述。 */
function resolveMedia({
  kind,
  fileId,
  voiceMime,
  signal,
}: DescribeMediaParams): Promise<AiTextResult> {
  const capability: MediaInputCapability = kind === "voice" ? "voice" : "vision";
  return runMediaInputRequest(
    capability,
    kind === "voice"
      ? (): Promise<AiTextResult> => transcribeVoiceUncached({
        fileId,
        declaredMime: voiceMime,
        signal,
      })
      : (): Promise<AiTextResult> => describeVisionUncached({
        kind,
        fileId,
        signal,
      }),
    signal
  );
}

/**
 * 通过 mediaTaskRunner 执行单次媒体请求并将结果交由模态状态机归因。
 */
function runTrackedMediaAttempt(
  capability: MediaInputCapability,
  task: () => Promise<AiTextResult>,
  signal?: AbortSignal
): Promise<AiTextResult> {
  const attemptState: MediaInputModalityState = getMediaInputState(capability);
  return mediaTaskRunner.run("interactive", task, signal).then((result: AiTextResult | undefined): AiTextResult => {
    if (result === undefined) {
      return signal?.aborted === true ? MEDIA_CANCELLED_RESULT : MEDIA_TASK_REJECTED_RESULT;
    }
    recordMediaInputResult({ capability, result, attemptState });
    return signal?.aborted === true ? MEDIA_CANCELLED_RESULT : result;
  });
}

/**
 * 媒体请求准入控制：拦截已关闭或退避中的模态；未知支持度时仅放行单个探测请求，
 * 并发调用在共享等待额度内等待探测结果后再决定放行、共享失败或重入探测。
 */
function runMediaInputRequest(
  capability: MediaInputCapability,
  task: () => Promise<AiTextResult>,
  signal?: AbortSignal
): Promise<AiTextResult> {
  if (signal?.aborted === true) return Promise.resolve(MEDIA_CANCELLED_RESULT);
  const support: MediaInputSupport = getMediaInputState(capability).support;
  if (isMediaInputClosed(support)) return MEDIA_CLOSED_PROMISE;
  if (isMediaInputProbeCoolingDown(capability, Date.now())) return MEDIA_BACKOFF_PROMISE;
  if (support === "supported") return runTrackedMediaAttempt(capability, task, signal);

  const activeProbe: SharedResult<AiTextResult> | null = getMediaInputProbe(capability);
  if (activeProbe !== null) {
    const release: (() => void) | undefined = reserveMediaProbeWait();
    if (release === undefined) return Promise.resolve(MEDIA_TASK_REJECTED_RESULT);
    return activeProbe.wait(signal).then(
      (result: AiTextResult): Promise<AiTextResult> | AiTextResult => {
        release();
        if (result.ok) return runTrackedMediaAttempt(capability, task, signal);
        return result.mediaFailure === undefined ? runMediaInputRequest(capability, task, signal) : result;
      }
    );
  }

  const probe: SharedResult<AiTextResult> = createSharedResult(
    runTrackedMediaAttempt(capability, task, signal)
      .finally((): void => clearMediaInputProbe(capability, probe)),
    { cancelled: MEDIA_CANCELLED_RESULT, rejected: MEDIA_TASK_REJECTED_RESULT }
  );
  setMediaInputProbe(capability, probe);
  return probe.promise;
}

interface DescribeVisionUncachedParams {
  readonly kind: MediaKind;
  readonly fileId: string;
  readonly priority?: AiProviderTaskPriority;
  readonly signal?: AbortSignal;
}

async function describeVisionUncached({
  kind,
  fileId,
  priority = "interactive",
  signal,
}: DescribeVisionUncachedParams): Promise<AiTextResult> {
  try {
    const image: VisionImage | null = await downloadTelegramVisionImage({
      fileId,
      logLabel: `chat media (kind=${kind})`,
      signal,
    });
    if (!image) return { ok: false, retryable: true };
    return await mediaAiProvider(priority).describeVision({
      prompt: promptFor(kind),
      image,
      signal,
      errorLabel: MEDIA_DESCRIPTION_ERROR_LABEL,
      normalize: (text: string): string => {
        const description: string = sanitizeInline(text);
        if (!description) return "";
        return truncateAtClauseBoundary(description, maxCharsFor(kind));
      },
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) return MEDIA_CANCELLED_RESULT;
    logger.error(`Error describing chat media (kind=${kind}):`, error);
    return { ok: false, retryable: false };
  }
}
