import { displaySpeakerName } from "../../aiChat/ai/utils/chatTranscript";
import { QUEUED_TRIGGER_SNIPPET_MAX_CHARS } from "../../consts/aiChat/rateLimit";
import {
  activeReplyCounts,
  pendingOverflowNotices,
  pendingReplyTriggers,
} from "../../cache/workers/aiChat/replies";
import { LinkedQueue } from "../../libs/linkedQueue";
import { truncateInline } from "../../libs/text";
import { replyRoundConcurrencyLimit } from "../../states/replyAdmission";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";
import type { QueuedReplyTrigger, MediaCommentContext } from "../../types/aiChat/replies";
import type { TriggerKind } from "../../types/states/replyAdmission";
import { resolvedTagFor } from "./mediaText";
import { isDirectReplyModelActive } from "./replyDelivery";
import { notifyRateLimited } from "./replyState";
import { lookupBufferedMessage, replyReferenceForBufferedEntry } from "./bufferedMessageIndex";

/** 触发分类：随机触发优先于媒体触发。 */
export function triggerKindFor(isRandomTrigger: boolean, mediaComment: MediaCommentContext | undefined): TriggerKind {
  if (isRandomTrigger) return "random";
  if (mediaComment) return mediaComment.directTriggerReason ? "direct" : "random";
  return "direct";
}

/** pushReplyTrigger 的入参。 */
export interface PushReplyTriggerParams {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  telegramBackpressured: boolean;
  imageGenerationRequested: boolean;
  imageGenerationReference?: QueuedReplyTrigger["imageGenerationReference"];
  triggerReference?: BufferedReplyReference;
  /** 触发时刻的本群问答 JSON 文本与条数；随触发一起入队，补跑时用当时那份清单。 */
  chatQaJson?: string;
  chatQaCount?: number;
  /** 触发消息所在的论坛话题；补跑那一轮仍然回到当初那个话题。 */
  messageThreadId: number | undefined;
  mediaTrigger?: MediaCommentContext;
  mediaPreparation?: Promise<MediaCommentContext | null>;
}

/** 保存直接触发的排队快照（按 replyToMessageId 从热区索引或媒体入站上下文提取）。 */
export function pushReplyTrigger({
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
  mediaTrigger,
  mediaPreparation,
}: PushReplyTriggerParams): void {
  let queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) {
    queue = new LinkedQueue<QueuedReplyTrigger>();
    pendingReplyTriggers.set(chatId, queue);
  }
  if (mediaTrigger) {
    const capturedTriggerReference: BufferedReplyReference | undefined =
      triggerReference ?? mediaTrigger.triggerReference;
    queue.push({
      triggerSenderId,
      replyToMessageId,
      telegramBackpressured,
      triggerReference: capturedTriggerReference,
      replyTo: mediaTrigger.replyTo,
      forwardedFrom: mediaTrigger.forwardedFrom ? mediaTrigger.forwardedFrom : undefined,
      imageGenerationRequested,
      imageGenerationReference,
      chatQaJson,
      chatQaCount,
      messageThreadId,
      senderName: mediaTrigger.senderName,
      text: truncateInline(
        mediaTrigger.triggerText ?? resolvedTagFor(mediaTrigger.kind, mediaTrigger.description),
        QUEUED_TRIGGER_SNIPPET_MAX_CHARS
      ),
      mediaPreparation,
    });
    return;
  }

  const triggerEntry: BufferedMessage | undefined = lookupBufferedMessage(chatId, replyToMessageId);
  const capturedTriggerReference: BufferedReplyReference | undefined = triggerReference ??
    (triggerEntry ? replyReferenceForBufferedEntry(replyToMessageId, triggerEntry) : undefined);
  queue.push({
    triggerSenderId,
    replyToMessageId,
    telegramBackpressured,
    triggerReference: capturedTriggerReference,
    replyTo: triggerEntry?.replyTo,
    forwardedFrom: triggerEntry?.forwardedFrom ? triggerEntry.forwardedFrom : undefined,
    imageGenerationRequested,
    imageGenerationReference,
    chatQaJson,
    chatQaCount,
    messageThreadId,
    senderName: triggerEntry ? displaySpeakerName(triggerEntry) : "",
    text: triggerEntry ? truncateInline(triggerEntry.text, QUEUED_TRIGGER_SNIPPET_MAX_CHARS) : "",
    mediaPreparation,
  });
}

/** 补发并清除该群待发送的队列溢出提示。 */
export function flushOverflowNotice(chatId: number): void {
  const messageThreadId: number | undefined = pendingOverflowNotices.get(chatId);
  if (!pendingOverflowNotices.delete(chatId)) return;
  notifyRateLimited({ chatId, now: Date.now(), messageThreadId });
}

/**
 * 按 FIFO 顺序在模型并发上限内启动排队触发；启动成功即出队，被容量或限频拒绝时保留队首并停止。
 * 生命周期约束见 docs/cn/04-invariants.md。
 */
export function drainReplyQueue(chatId: number, startQueuedRound: (trigger: QueuedReplyTrigger) => boolean): void {
  const queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) return;
  while (queue.size > 0) {
    const trigger: QueuedReplyTrigger | undefined = queue.peek();
    if (trigger === undefined) break;
    const maxConcurrent: number = replyRoundConcurrencyLimit(trigger.telegramBackpressured, isDirectReplyModelActive(chatId));
    if ((activeReplyCounts.get(chatId) ?? 0) >= maxConcurrent) break;
    if (!startQueuedRound(trigger)) break;
    queue.shift();
  }
  if (queue.size === 0) pendingReplyTriggers.delete(chatId);
}
