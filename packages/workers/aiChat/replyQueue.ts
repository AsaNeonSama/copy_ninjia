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
import { lookupBufferedMessage } from "./bufferedMessageIndex";

/**
 * 触发分类：随机触发优先于媒体触发。
 *
 * @param isRandomTrigger 是否为概率触发的随机插话
 * @param mediaComment 媒体评价或媒体直接触发上下文
 * @returns 准入分类标识（`random` 或 `direct`）
 */
export function triggerKindFor(isRandomTrigger: boolean, mediaComment: MediaCommentContext | undefined): TriggerKind {
  if (isRandomTrigger) return "random";
  if (mediaComment) return mediaComment.directTriggerReason ? "direct" : "random";
  return "direct";
}

/** pushReplyTrigger 的入参。 */
export interface PushReplyTriggerParams {
  /** 群聊 ID。 */
  chatId: number;
  /** 触发用户的 Telegram ID。 */
  triggerSenderId: number;
  /** 触发消息的 message_id。 */
  replyToMessageId: number;
  /** 主线程投递时刻的 Telegram 发送面高压快照。 */
  telegramBackpressured: boolean;
  /** 本次触发是否请求开放生图与语音等媒体工具。 */
  imageGenerationRequested: boolean;
  /** 直接触发图片或贴纸时附带的短期生图参考源。 */
  imageGenerationReference?: QueuedReplyTrigger["imageGenerationReference"];
  /** 触发消息的回复引用快照。 */
  triggerReference: BufferedReplyReference | undefined;
  /** 触发时刻的本群问答 JSON 文本与条数；随触发一起入队，补跑时用当时那份清单。 */
  chatQaJson?: string;
  /** 触发时刻的本群问答条目总数。 */
  chatQaCount?: number;
  /** 触发消息所在的论坛话题；补跑那一轮仍然回到当初那个话题。 */
  messageThreadId: number | undefined;
  /** 媒体评价或媒体直接触发上下文。 */
  mediaTrigger?: MediaCommentContext;
  /** 媒体异步识图准备 Promise。 */
  mediaPreparation?: Promise<MediaCommentContext | null>;
}

/**
 * 保存直接触发的排队快照（按 replyToMessageId 从热区索引或媒体入站上下文提取）。
 *
 * @param params 排队触发的群聊、消息引用、媒体上下文与本群问答快照
 */
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
  let replyTo: QueuedReplyTrigger["replyTo"];
  let forwardedFrom: QueuedReplyTrigger["forwardedFrom"];
  let senderName: string;
  let text: string;
  if (mediaTrigger) {
    replyTo = mediaTrigger.replyTo;
    forwardedFrom = mediaTrigger.forwardedFrom ? mediaTrigger.forwardedFrom : undefined;
    senderName = mediaTrigger.senderName;
    text = truncateInline(
      mediaTrigger.triggerText ?? resolvedTagFor(mediaTrigger.kind, mediaTrigger.description),
      QUEUED_TRIGGER_SNIPPET_MAX_CHARS
    );
  } else {
    const triggerEntry: BufferedMessage | undefined = lookupBufferedMessage(chatId, replyToMessageId);
    replyTo = triggerEntry?.replyTo;
    forwardedFrom = triggerEntry?.forwardedFrom ? triggerEntry.forwardedFrom : undefined;
    senderName = triggerEntry ? displaySpeakerName(triggerEntry) : "";
    text = triggerEntry ? truncateInline(triggerEntry.text, QUEUED_TRIGGER_SNIPPET_MAX_CHARS) : "";
  }
  queue.push({
    triggerSenderId,
    replyToMessageId,
    telegramBackpressured,
    triggerReference,
    replyTo,
    forwardedFrom,
    imageGenerationRequested,
    imageGenerationReference,
    chatQaJson,
    chatQaCount,
    messageThreadId,
    senderName,
    text,
    mediaPreparation,
  });
}

/**
 * 补发并清除该群待发送的队列溢出提示。
 *
 * @param chatId 群聊 ID
 */
export function flushOverflowNotice(chatId: number): void {
  const messageThreadId: number | undefined = pendingOverflowNotices.get(chatId);
  if (!pendingOverflowNotices.delete(chatId)) return;
  notifyRateLimited({ chatId, now: Date.now(), messageThreadId });
}

/**
 * 按 FIFO 顺序在模型并发上限内启动排队触发；启动成功即出队，被容量或限频拒绝时保留队首并停止。
 * 生命周期约束见 docs/cn/04-invariants.md。
 *
 * @param chatId 群聊 ID
 * @param startQueuedRound 启动单条排队触发的回调，启动成功时返回 true
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

/**
 * 移除所有群排队队列中由指定用户发起的直接触发；队列排空时删除外层键。
 *
 * @param userId 被清理的触发用户 Telegram ID
 */
export function dropQueuedReplyTriggersForUser(userId: number): void {
  for (const [chatId, queue] of pendingReplyTriggers) {
    queue.removeWhere((trigger: QueuedReplyTrigger): boolean => trigger.triggerSenderId === userId);
    if (queue.size === 0) pendingReplyTriggers.delete(chatId);
  }
}
