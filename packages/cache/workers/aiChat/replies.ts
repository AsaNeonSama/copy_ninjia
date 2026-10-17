/** owner: workers/aiChat。回复流水线调度、限频与取消状态（packages/workers/aiChat/）。 */

import type { LinkedQueue } from "../../../libs/linkedQueue";
import type { TimestampDeque } from "../../../libs/timestampDeque";
import {
  RATE_LIMIT_LONG_WINDOW_MS,
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
} from "../../../consts/aiChat/rateLimit";
import type { QueuedReplyTrigger, ReplyDeliveryWindow } from "../../../types/aiChat/replies";

/**
 * chatId -> 当前回复代际编号（本 isolate 内单调递增）。
 * 填充：cachedReplyGeneration 首次读取该群时分配（回复轮、限频提示、mediaIngest.ts 的后台识图、botImages.ts、compaction.ts）；清理：invalidateChatReplies 递增覆盖，evictChatReplyGeneration 或 resetAiChatReplyCache 删除；重建：Worker 重启后从空表开始；容量：不超过 AI_MEMORY_MAX_CHATS。
 */
export const replyGenerations: Map<number, number> = new Map();

/** 回复代际单调计数器。 */
const replyGenerationCounter: { current: number } = { current: 0 };

/**
 * chatId -> 最近一次发送限频提示的时间戳。
 * 填充：限频提示发送时写入；清理：sweepAiChatReplyCache 淘汰满 RATE_LIMIT_NOTICE_COOLDOWN_MS 的条目，或随群失效删除；重建：Worker 重启后为空；容量：受 STATE_MANAGED_CHAT_LIMIT 约束，每群至多一项。
 */
export const rateLimitNoticeTimes: Map<number, number> = new Map();

/**
 * chatId -> 长窗口触发时间戳环形队列（workers/aiChat/replyRound.ts）。
 * 填充：通过长窗口配额检查时追加；清理：sweepAiChatReplyCache 裁剪超过 RATE_LIMIT_LONG_WINDOW_MS 的记录并在排空时删键，或随群失效删除；重建：Worker 重启后为空；容量：每群上限为 RATE_LIMIT_LONG_MAX_TRIGGERS。
 */
export const longTriggerTimes: Map<number, TimestampDeque> = new Map();

/**
 * chatId -> 当前处于模型阶段的回复轮数（上限见 states/replyAdmission.ts 的 replyRoundConcurrencyLimit）。
 * 填充：回复轮启动时递增；清理：模型阶段结束时递减并在归零时删键；重建：Worker 重启后为空。
 */
export const activeReplyCounts: Map<number, number> = new Map();

/**
 * chatId -> 回复按序投递窗口（workers/aiChat/replyDelivery.ts）。
 * 填充：直接轮或有序并行轮准入时创建并追加；清理：按入站顺位排空、群失效或 resetAiChatReplyCache 时删除；重建：Worker 重启后从空表开始；容量：受单群并发闸与 REPLY_DELIVERY_MAX_TOTAL 约束。
 */
export const replyDeliveryWindows: Map<number, ReplyDeliveryWindow> = new Map();

/**
 * chatId -> 尚未按序回收的发送槽位数。
 * 填充：预留发送槽位时递增；清理：advanceDelivery 释放槽位并在归零时删键；重建：Worker 重启后为空；容量：全线程总和不超过 REPLY_DELIVERY_MAX_TOTAL，不设淘汰。
 */
export const replyDeliveryCounts: Map<number, number> = new Map();

/**
 * 全线程当前存活的发送槽位总数，上限为 REPLY_DELIVERY_MAX_TOTAL。
 * 填充与清理随 replyDeliveryCounts 同步增减；Worker 重启后归零。
 */
export const replyDeliveryTotal: { current: number } = { current: 0 };

/**
 * chatId -> 待处理的直接回复触发 FIFO 队列。
 * 填充：触发准入排队时入队；清理：轮次启动出队、dropQueuedReplyTriggersForUser 移除被 abuse_mark 标记用户的排队项并在排空时删键，或随群失效清空；重建：Worker 重启后为空；容量：单群上限为 REPLY_TRIGGER_QUEUE_MAX，群数受 STATE_MANAGED_CHAT_LIMIT 约束。
 */
export const pendingReplyTriggers: Map<number, LinkedQueue<QueuedReplyTrigger>> = new Map();

/**
 * chatId -> 已排队的溢出提示所属论坛话题 ID（非话题或 General 为 undefined）。
 * 填充：登记溢出提示时写入；清理：提示任务结算或群失效时删除；重建：Worker 重启后为空；容量：每群至多一项，与 pendingReplyTriggers 同界。
 */
export const pendingOverflowNotices: Map<number, number | undefined> = new Map();

/**
 * generation -> 该代际的取消控制器。
 * 填充：replyGenerationSignal 首次获取该代际信号时创建（回复轮、限频提示、mediaIngest.ts 的后台识图、botImages.ts、compaction.ts）；清理：invalidateChatReplies 或 evictChatReplyGeneration 时 abort 旧代际，无在途任务时立即删除或在 trackReplyGenerationTask 结算后删除，resetAiChatReplyCache 时全部 abort 并清空；重建：Worker 重启后为空；容量：当前存活群代际数（不超过 AI_MEMORY_MAX_CHATS）加尚未排空的已失效旧代际。
 */
export const replyAbortControllers: Map<number, AbortController> = new Map();

/**
 * generation -> 该代际尚未结算的异步任务集合（回复、提示、媒体描述、记忆压缩）。
 * 填充：任务启动时登记；清理：Promise 结算时从集合移除并在集合排空时删外层键，或由 resetAiChatReplyCache 清空；重建：Worker 重启后为空；容量：与 replyAbortControllers 同界。
 */
export const replyGenerationTasks: Map<number, Set<Promise<void>>> = new Map();

/** 读取指定群当前回复代际编号；未登记时分配新代际。 */
export function cachedReplyGeneration(chatId: number): number {
  const cached: number | undefined = replyGenerations.get(chatId);
  if (cached !== undefined) return cached;
  if (replyGenerationCounter.current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("AI reply generation epoch exhausted.");
  }
  replyGenerationCounter.current += 1;
  const generation: number = replyGenerationCounter.current;
  replyGenerations.set(chatId, generation);
  return generation;
}

/** 核对指定代际是否仍为该群当前有效代际。 */
export function isCachedReplyGenerationCurrent(chatId: number, generation: number): boolean {
  return replyGenerations.get(chatId) === generation;
}

/** 使指定群当前代际失效，并清理排队触发、投递窗口与限频记录。 */
export function invalidateChatReplyCache(chatId: number): void {
  replyGenerations.delete(chatId);
  replyDeliveryWindows.delete(chatId);
  pendingReplyTriggers.delete(chatId);
  pendingOverflowNotices.delete(chatId);
  longTriggerTimes.delete(chatId);
  rateLimitNoticeTimes.delete(chatId);
}

/** 清理已过期的长窗口触发记录与限频提示冷却时间戳。 */
export function sweepAiChatReplyCache(now: number = Date.now()): void {
  for (const [chatId, times] of longTriggerTimes) {
    times.trim(RATE_LIMIT_LONG_WINDOW_MS, now);
    if (times.size === 0) longTriggerTimes.delete(chatId);
  }
  for (const [chatId, at] of rateLimitNoticeTimes) {
    if (at > now || now - at >= RATE_LIMIT_NOTICE_COOLDOWN_MS) rateLimitNoticeTimes.delete(chatId);
  }
}

/** 清空回复调度缓存并中止所有在途代际控制器。 */
export function resetAiChatReplyCache(): void {
  replyGenerations.clear();
  rateLimitNoticeTimes.clear();
  longTriggerTimes.clear();
  activeReplyCounts.clear();
  replyDeliveryWindows.clear();
  pendingReplyTriggers.clear();
  pendingOverflowNotices.clear();
  for (const controller of replyAbortControllers.values()) controller.abort();
  replyAbortControllers.clear();
  replyGenerationTasks.clear();
}
