import { startChatActionHeartbeat } from "../../aiChat/ai/chatActionHeartbeat";
import { createReplyToolset } from "../../aiChat/ai/tools/replyToolset/orchestrator";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { parseToolResult } from "../../aiChat/ai/utils/toolResult";
import { botInfoState, superAdminUserIdState } from "../../cache/workers/aiChat/identity";
import {
  activeReplyCounts,
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
  longTriggerTimes,
} from "../../cache/workers/aiChat/replies";
import { AI_TEXT_TYPO_PROBABILITY } from "../../consts/aiChat/tools";
import {
  RATE_LIMIT_LONG_MAX_TRIGGERS,
  RATE_LIMIT_LONG_WINDOW_MS,
  QUEUED_TRIGGER_SNIPPET_MAX_CHARS,
} from "../../consts/aiChat/rateLimit";
import { SEND_MESSAGE_TOOL } from "../../consts/tools";
import { logger } from "../../infra/logger";
import { TimestampDeque } from "../../libs/timestampDeque";
import { raceAbort } from "../../libs/abortSignal";
import { truncateInline } from "../../libs/text";
import { isReplyRoundRateLimited } from "../../states/replyAdmission";
import type { AiAbuseMarkEvent, AiBotInfo, ImageGenerationReference } from "../../types/aiChat/protocol";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";
import type {
  QueuedReplyTrigger,
  ReplyPromptSections,
  ReplyToolContext,
  ReplyToolset,
  ReplyDeliveryTurn,
  SentGeneratedImage,
  MediaCommentContext,
} from "../../types/aiChat/replies";
import { generateReply } from "./replyModel";
import { reserveReplyDelivery } from "./replyDelivery";
import { buildReplyPromptSections } from "./promptContext";
import { replyReferenceForBufferedMessage } from "./bufferedMessageIndex";
import { dropQueuedReplyTriggersForUser } from "./replyQueue";
import { notifyRateLimited } from "./replyState";
import { replyGenerationSignal, trackReplyGenerationTask } from "./replyGeneration";
import { recordChatMessage } from "./rollingMemory";
import { repliedBotImageBackfill, trackGeneratedImage } from "./botImages";
import { imageGenerationReferencesFor } from "./imageReferenceAlbums";
import type { ChatActionHeartbeatControl } from "../../types/aiChat/chatAction";

declare const self: Worker;

/** 单轮 AI 群聊回复的启动请求载荷。 */
export interface ReplyRoundRequest {
  /** 群聊 ID。 */
  chatId: number;
  /** 触发用户的 Telegram ID。 */
  triggerSenderId: number;
  /** 触发消息的 message_id。 */
  replyToMessageId: number;
  /** 本次触发是否请求开放生图与语音等媒体工具。 */
  imageGenerationRequested: boolean;
  /** 直接触发图片或贴纸时附带的短期生图参考源。 */
  imageGenerationReference?: ImageGenerationReference;
  /** 轮次开始前捕获的触发消息快照；生成或排队期间滑出热区时用于自录兜底。 */
  triggerReference?: BufferedReplyReference;
  /** 是否为概率触发的随机插话轮。 */
  isRandomTrigger: boolean;
  /** 触发时刻的本群问答 JSON 文本与条数；缺省时问答执行器返回空清单，本轮工具状态写明没有登记。 */
  chatQaJson?: string;
  /** 触发时刻的本群问答条目总数。 */
  chatQaCount?: number;
  /** 本轮全部发送要落进的论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
  /** 媒体评价或媒体直接触发的上下文。 */
  mediaComment?: MediaCommentContext;
  /** 后台媒体识图准备 Promise；解析失败或取消时兑现为 null。 */
  mediaPreparation?: Promise<MediaCommentContext | null>;
  /** 排队后补跑的触发快照；直接进入执行时为 undefined。 */
  queuedTrigger?: QueuedReplyTrigger;
  /** 直接触发在准入时捕获的回复代际；排队补跑省略并使用出队时的当前回复代际。 */
  generation?: number;
}

/** buildReplyToolContext 的输入：本轮请求与已解析的媒体、身份和生命周期句柄。 */
interface ReplyToolContextParams {
  /** 本轮回复请求载荷。 */
  readonly request: ReplyRoundRequest;
  /** 机器人自身身份信息。 */
  readonly selfInfo: AiBotInfo;
  /** 本轮已解析的媒体上下文；非媒体轮为 undefined。 */
  readonly resolvedMedia: MediaCommentContext | undefined;
  /** 本轮是否允许暴露生图与语音等媒体工具。 */
  readonly mediaToolsAllowed: boolean;
  /** 群聊 typing/动作心跳控制器。 */
  readonly heartbeat: ChatActionHeartbeatControl;
  /** 本轮是否为直接轮（见 replyDelivery.ts）。 */
  readonly direct: boolean;
  /** 本轮是否命中错别字彩蛋概率。 */
  readonly roundHasTypo: boolean;
  /** 判断本轮回复代际是否仍然存活的回调。 */
  readonly isActive: () => boolean;
  /** 绑定本轮回复代际的取消信号。 */
  readonly signal: AbortSignal;
}

/**
 * 构造单轮回复的工具上下文与自录回调：消息、贴纸、语音和生图发送成功后在本轮仍有效时
 * 将自录条目写入滚动记忆。
 *
 * @param params 本轮回复请求、已解析媒体、机器人身份与生命周期控制句柄
 * @returns 供 `createReplyToolset` 使用的单轮回复工具上下文
 */
function buildReplyToolContext({
  request,
  selfInfo,
  resolvedMedia,
  mediaToolsAllowed,
  heartbeat,
  direct,
  roundHasTypo,
  isActive,
  signal,
}: ReplyToolContextParams): ReplyToolContext {
  const {
    chatId,
    triggerSenderId,
    replyToMessageId,
    messageThreadId,
    chatQaJson,
    chatQaCount,
    imageGenerationReference,
    triggerReference,
  }: ReplyRoundRequest = request;
  const selfReplyReferenceFor = (
    repliedToMessageId: number | undefined
  ): BufferedReplyReference | undefined => repliedToMessageId === undefined
    ? undefined
    : replyReferenceForBufferedMessage(chatId, repliedToMessageId) ??
      (resolvedMedia?.triggerReference?.messageId === repliedToMessageId ? resolvedMedia.triggerReference : undefined) ??
      (triggerReference?.messageId === repliedToMessageId ? triggerReference : undefined);
  const recordSelfSent = (
    text: string,
    messageId: number,
    repliedToMessageId?: number
  ): BufferedMessage | null => {
    if (!isActive()) return null;
    const selfReplyTo: BufferedReplyReference | undefined = selfReplyReferenceFor(repliedToMessageId);
    return recordChatMessage(buildSelfRecordMessage({
      chatId,
      self: selfInfo,
      messageId,
      text,
      replyTo: selfReplyTo,
    }));
  };
  return {
    chatId,
    triggerSenderId,
    replyToMessageId,
    messageThreadId,
    chatQaJson,
    chatQaCount,
    mediaToolsRequested: mediaToolsAllowed,
    imageGenerationReferences: mediaToolsAllowed && imageGenerationReference !== undefined
      ? imageGenerationReferencesFor(chatId, imageGenerationReference)
      : undefined,
    bypassMediaToolCooldown: triggerSenderId === superAdminUserIdState.current,
    chatAction: heartbeat,
    direct,
    roundHasTypo,
    isActive,
    signal,
    onMessageSent: recordSelfSent,
    onStickerSent: (stickerDescription: string, messageId: number): void => {
      recordSelfSent(stickerDescription, messageId);
    },
    onImageSent: (image: SentGeneratedImage): void => {
      const entry: BufferedMessage | null = recordSelfSent(image.text, image.messageId, image.repliedToMessageId);
      if (entry === null) return;
      trackGeneratedImage({
        chatId,
        entry,
        origin: image.origin,
        caption: image.caption,
        photo: image.photo,
      });
    },
    onVoiceSent: recordSelfSent,
    onAbuseMark: handleAbuseMark,
  };
}

/**
 * 处理模型触发的 abuse_mark：清理该用户在 Worker 内的排队触发并通知主线程启动冷却。
 *
 * @param userId 被标记滥用的用户 Telegram ID
 */
function handleAbuseMark(userId: number): void {
  dropQueuedReplyTriggersForUser(userId);
  self.postMessage({ type: "abuseMark", userId } satisfies AiAbuseMarkEvent);
}

/**
 * 将模型最终正文经 send_message 兜底发送（随机触发不挂回复）。
 *
 * @param toolset 本轮回复的工具集执行器
 * @param request 本轮回复请求载荷
 * @param finalText 模型最终轮输出的正文文本
 */
function sendFallbackText(toolset: ReplyToolset, request: ReplyRoundRequest, finalText: string): void {
  const result: string = toolset.execute(
    SEND_MESSAGE_TOOL,
    JSON.stringify({ text: finalText, reply_to_trigger: !request.isRandomTrigger })
  );
  const error: string | null = parseToolResult(result).error;
  if (error !== null) logger.error(`AI reply fallback send failed (chat ${request.chatId}): ${error}`);
}

/**
 * 零动作诊断日志里的触发类型。
 *
 * @param request 本轮回复请求载荷
 * @returns 触发类型标识字符串（`queued`、`media-direct`、`media-comment`、`random` 或 `direct`）
 */
function triggerKindOf({ queuedTrigger, mediaComment, isRandomTrigger }: ReplyRoundRequest): string {
  if (queuedTrigger) return "queued";
  if (mediaComment?.directTriggerReason) return "media-direct";
  if (mediaComment) return "media-comment";
  return isRandomTrigger ? "random" : "direct";
}

/**
 * 校验代际有效性、机器人身份、长窗口限频（直接触发被限频时发送冷却提示）与发送占位容量并启动一轮异步回复；
 * 成功启动返回 true，被代际失效、未初始化、限频或容量拒绝返回 false。
 *
 * @param request 本轮回复请求载荷
 * @param onFinished 本轮发送占位彻底释放后的回调
 * @param onModelFinished 本轮模型阶段结束、提交发送顺位后的可选回调
 * @returns 成功预留占位并启动回复任务时返回 true，否则返回 false
 */
export function startReplyRound(
  request: ReplyRoundRequest,
  onFinished: (chatId: number) => void,
  onModelFinished?: (chatId: number) => void
): boolean {
  const {
    chatId,
    triggerSenderId,
    replyToMessageId,
    imageGenerationRequested,
    isRandomTrigger,
    messageThreadId,
    mediaComment,
    mediaPreparation,
    queuedTrigger,
  }: ReplyRoundRequest = request;
  const generation: number = request.generation ?? cachedReplyGeneration(chatId);
  if (!isCachedReplyGenerationCurrent(chatId, generation)) return false;

  const mediaToolsAllowed: boolean = imageGenerationRequested &&
    !isRandomTrigger &&
    (mediaComment === undefined || mediaComment.directTriggerReason !== undefined);
  const directInvokerId: number | undefined =
    !isRandomTrigger && (mediaComment === undefined || mediaComment.directTriggerReason !== undefined)
      ? triggerSenderId
      : undefined;

  const selfInfo: AiBotInfo | null = botInfoState.current;
  if (!selfInfo) return false;

  const now: number = Date.now();
  let longTimes: TimestampDeque | undefined = longTriggerTimes.get(chatId);
  if (!longTimes) {
    longTimes = new TimestampDeque(RATE_LIMIT_LONG_MAX_TRIGGERS);
    longTriggerTimes.set(chatId, longTimes);
  }
  longTimes.trim(RATE_LIMIT_LONG_WINDOW_MS, now);
  if (isReplyRoundRateLimited(longTimes.size)) {
    if (directInvokerId !== undefined) notifyRateLimited({ chatId, now, generation, messageThreadId });
    return false;
  }

  const delivery: ReplyDeliveryTurn | undefined = reserveReplyDelivery(chatId);
  if (!delivery) return false;
  longTimes.push(now);
  activeReplyCounts.set(chatId, (activeReplyCounts.get(chatId) ?? 0) + 1);

  const signal: AbortSignal = replyGenerationSignal(generation);
  const task: Promise<void> = Promise.resolve().then(async (): Promise<void> => {
    let modelFinished: boolean = false;
    const finishModel = (): void => {
      if (modelFinished) return;
      modelFinished = true;
      const remaining: number = (activeReplyCounts.get(chatId) ?? 1) - 1;
      if (remaining > 0) activeReplyCounts.set(chatId, remaining);
      else activeReplyCounts.delete(chatId);
      delivery.commit();
      onModelFinished?.(chatId);
    };
    const isActive = (): boolean =>
      !signal.aborted && isCachedReplyGenerationCurrent(chatId, generation);
    const roundHasTypo: boolean = Math.random() < AI_TEXT_TYPO_PROBABILITY;
    try {
      const resolvedMedia: MediaCommentContext | null | undefined = mediaPreparation
        ? await raceAbort(mediaPreparation, { signal, cancelled: null, rejected: null })
        : mediaComment;
      if (!isActive() || resolvedMedia === null) return;
      const botImageBackfill: Promise<void> | undefined = repliedBotImageBackfill(chatId, replyToMessageId);
      if (botImageBackfill !== undefined) {
        await raceAbort(botImageBackfill, { signal, cancelled: undefined, rejected: undefined });
        if (!isActive()) return;
      }
      const resolvedQueuedTrigger: QueuedReplyTrigger | undefined = queuedTrigger && resolvedMedia
        ? {
          ...queuedTrigger,
          triggerReference: resolvedMedia.triggerReference ?? queuedTrigger.triggerReference,
          text: truncateInline(resolvedMedia.triggerText ?? resolvedMedia.description, QUEUED_TRIGGER_SNIPPET_MAX_CHARS),
        }
        : queuedTrigger;
      const promptSections: ReplyPromptSections | null = buildReplyPromptSections(chatId, selfInfo, {
        triggerMessageId: replyToMessageId,
        directInvokerId,
        isRandomTrigger,
        mediaComment: queuedTrigger ? undefined : resolvedMedia,
        queuedTrigger: resolvedQueuedTrigger,
        roundHasTypo,
      });
      if (!promptSections) return;

      const heartbeat: ChatActionHeartbeatControl =
        startChatActionHeartbeat({ chatId, messageThreadId, signal });
      try {
        const ctx: ReplyToolContext = buildReplyToolContext({
          request,
          selfInfo,
          resolvedMedia,
          mediaToolsAllowed,
          heartbeat,
          direct: delivery.direct,
          roundHasTypo,
          isActive,
          signal,
        });
        const toolset: ReplyToolset = await createReplyToolset(ctx, delivery.ready);
        let finalText: string | null = null;
        try {
          finalText = await generateReply(chatId, promptSections, toolset);

          if (finalText && toolset.actionsUsed() === 0) sendFallbackText(toolset, request, finalText);
        } finally {
          toolset.afterModel();
          try {
            finishModel();
          } finally {
            await toolset.settle();
          }
        }

        if (isActive() && toolset.actionsCompleted() === 0 && finalText !== null) {
          logger.error(`AI reply round ended with zero actions (chat ${chatId}, trigger=${triggerKindOf(request)}, finalText=unsent).`);
        }
      } finally {
        await heartbeat.stop();
      }
    } finally {
      try {
        finishModel();
      } finally {
        await delivery.finish();
        onFinished(chatId);
      }
    }
  }).catch((error: unknown): void => {
    if (signal.aborted) return;
    logger.error("Error in AI reply task:", error);
  });
  trackReplyGenerationTask(chatId, generation, task);
  return true;
}
