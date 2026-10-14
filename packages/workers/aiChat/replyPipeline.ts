import { botInfoState } from "../../cache/workers/aiChat/identity";
import { aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
import {
  activeReplyCounts,
  cachedReplyGeneration,
  longTriggerTimes,
  pendingOverflowNotices,
  pendingReplyTriggers,
} from "../../cache/workers/aiChat/replies";
import { RATE_LIMIT_LONG_WINDOW_MS } from "../../consts/aiChat/rateLimit";
import { logger } from "../../infra/logger";
import type { TimestampDeque } from "../../libs/timestampDeque";
import { admitTrigger, isReplyRoundRateLimited } from "../../states/replyAdmission";
import type { QueuedReplyTrigger, MediaCommentContext } from "../../types/aiChat/replies";
import type { BufferedReplyReference } from "../../types/aiChat/memory";
import type { AdmitDecision } from "../../types/states/replyAdmission";
import {
  drainReplyQueue as drainQueuedReplies,
  flushOverflowNotice,
  pushReplyTrigger,
  triggerKindFor,
} from "./replyQueue";
import { startReplyRound } from "./replyRound";
import { hasLiveReplyRounds, hasReplyDeliveryCapacity, isDirectReplyModelActive } from "./replyDelivery";
import { replyReferenceForBufferedMessage } from "./bufferedMessageIndex";

/**
 * AI 回复准入编排：按并发与排队策略决定立即启动、入队等待、登记溢出提示或静默丢弃，
 * 并在模型阶段完成、轮次收尾及维护节拍时推动待处理队列。
 */

/** 启动一条排队触发，成功启动返回 true，被容量或限频拒绝时返回 false。 */
function startQueuedRound(chatId: number, trigger: QueuedReplyTrigger): boolean {
  if (aiChatWorkerQuiescing.current) return false;
  return startReplyRound(
    {
      chatId,
      triggerSenderId: trigger.triggerSenderId,
      replyToMessageId: trigger.replyToMessageId,
      imageGenerationRequested: trigger.imageGenerationRequested,
      imageGenerationReference: trigger.imageGenerationReference,
      triggerReference: trigger.triggerReference,
      isRandomTrigger: false,
      chatQaJson: trigger.chatQaJson,
      chatQaCount: trigger.chatQaCount,
      messageThreadId: trigger.messageThreadId,
      mediaComment: undefined,
      mediaPreparation: trigger.mediaPreparation,
      queuedTrigger: trigger,
      generation: undefined,
    },
    onReplyRoundFinished,
    onReplyModelFinished
  );
}

/** 仅在滑动限频窗口（RATE_LIMIT_LONG_WINDOW_MS）有余量时尝试排空该群队列。约束见 docs/cn/04-invariants.md。 */
function drainReplyQueueIfWindowAllows(chatId: number, now: number): void {
  const times: TimestampDeque | undefined = longTriggerTimes.get(chatId);
  if (times !== undefined) {
    times.trim(RATE_LIMIT_LONG_WINDOW_MS, now);
    if (isReplyRoundRateLimited(times.size)) return;
  }
  drainQueuedReplies(chatId, (trigger: QueuedReplyTrigger): boolean => startQueuedRound(chatId, trigger));
}

/** 模型阶段完成时尝试补跑同群下一条排队触发。 */
function onReplyModelFinished(chatId: number): void {
  if (aiChatWorkerQuiescing.current) return;
  drainReplyQueueIfWindowAllows(chatId, Date.now());
}

/** 单轮发送收尾时补发溢出提示并推动所有待处理队列。 */
function onReplyRoundFinished(chatId: number): void {
  if (aiChatWorkerQuiescing.current) return;
  flushOverflowNotice(chatId);
  drainPendingReplyQueues();
}

/** 遍历所有有排队触发的群并在限频窗口允许时补跑；已消费触发且仍有余项的群移至队尾轮转。 */
export function drainPendingReplyQueues(now: number = Date.now()): void {
  if (aiChatWorkerQuiescing.current) return;
  for (const chatId of [...pendingReplyTriggers.keys()]) {
    const queue: ReturnType<typeof pendingReplyTriggers.get> = pendingReplyTriggers.get(chatId);
    const previousSize: number = queue?.size ?? 0;
    drainReplyQueueIfWindowAllows(chatId, now);
    if (queue && queue.size > 0 && queue.size < previousSize) {
      pendingReplyTriggers.delete(chatId);
      pendingReplyTriggers.set(chatId, queue);
    }
  }
}

/** generateAndSendReply 的入参。 */
export interface GenerateAndSendReplyParams {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  imageGenerationRequested: boolean;
  imageGenerationReference?: QueuedReplyTrigger["imageGenerationReference"];
  isRandomTrigger: boolean;
  /** 主线程投递时刻的 Telegram 发送面高压快照；缺省按未高压处理。 */
  telegramBackpressured?: boolean;
  /** 主线程随 trigger 附带的本群问答 JSON 文本。 */
  chatQaJson?: string;
  /** 本群已登记问答条数。 */
  chatQaCount?: number;
  /** 触发消息所在的论坛话题。 */
  messageThreadId: number | undefined;
  mediaComment?: MediaCommentContext;
  /** 媒体异步解析句柄。 */
  mediaPreparation?: Promise<MediaCommentContext | null>;
}

/** 同步完成回复触发的并发准入与排队决策，异步启动回复轮次。 */
export function generateAndSendReply({
  chatId,
  triggerSenderId,
  replyToMessageId,
  imageGenerationRequested,
  imageGenerationReference,
  isRandomTrigger,
  telegramBackpressured = false,
  chatQaJson,
  chatQaCount = 0,
  messageThreadId,
  mediaComment,
  mediaPreparation,
}: GenerateAndSendReplyParams): void {
  if (aiChatWorkerQuiescing.current) return;
  const generation: number = cachedReplyGeneration(chatId);
  if (!botInfoState.current) {
    logger.error("aiChatWorker received trigger before init message; dropping.");
    return;
  }
  const triggerReference: BufferedReplyReference | undefined = mediaComment?.triggerReference ??
    replyReferenceForBufferedMessage(chatId, replyToMessageId);

  const decision: AdmitDecision = admitTrigger({
    activeRounds: activeReplyCounts.get(chatId) ?? 0,
    queueSize: pendingReplyTriggers.get(chatId)?.size ?? 0,
    kind: triggerKindFor(isRandomTrigger, mediaComment),
    telegramBackpressured,
    directRoundActive: isDirectReplyModelActive(chatId),
    deliveryAvailable: hasReplyDeliveryCapacity(chatId),
  });
  switch (decision) {
    case "startRound":
      startReplyRound(
        {
          chatId,
          triggerSenderId,
          replyToMessageId,
          imageGenerationRequested,
          imageGenerationReference,
          triggerReference,
          isRandomTrigger,
          chatQaJson,
          chatQaCount,
          messageThreadId,
          mediaComment,
          mediaPreparation,
          queuedTrigger: undefined,
          generation,
        },
        onReplyRoundFinished,
        onReplyModelFinished
      );
      break;
    case "enqueue":
      pushReplyTrigger({
        chatId,
        triggerSenderId,
        replyToMessageId,
        telegramBackpressured,
        imageGenerationRequested,
        imageGenerationReference,
        triggerReference,
        chatQaJson,
        chatQaCount,
        messageThreadId,
        mediaTrigger: mediaComment,
        mediaPreparation,
      });
      drainReplyQueueIfWindowAllows(chatId, Date.now());
      break;
    case "enqueueOverflow":
      pendingOverflowNotices.set(chatId, messageThreadId);
      if (!hasLiveReplyRounds(chatId)) flushOverflowNotice(chatId);
      break;
    case "dropSilently":
      break;
  }
}
