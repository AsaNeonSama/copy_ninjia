/**
 * AI 回复代际（generation）及其关联异步任务的生命周期管理。
 * 代际在当前 isolate 内单调递增；群失效或停机时同步中止取消控制器并等待在途任务结算。
 */

import {
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
  replyGenerations,
  replyAbortControllers,
  replyGenerationTasks,
  activeReplyCounts,
} from "../../cache/workers/aiChat/replies";
import { invalidateChatRuntimeCache } from "../../cache/workers/aiChat/index";
import { AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS } from "../../consts/lifecycle";
import { logger } from "../../infra/logger";
import { settleWithinBudget } from "../../libs/inflight";

/**
 * 判断目标群是否仍有在途模型调用或当前代际未结算任务。
 *
 * @param chatId 群聊 ID
 * @returns 仍有在途模型调用或当前代际任务未结算时返回 true，否则返回 false
 */
export function hasActiveAiChatTasks(chatId: number): boolean {
  if ((activeReplyCounts.get(chatId) ?? 0) > 0) return true;
  const generation: number | undefined = replyGenerations.get(chatId);
  return generation !== undefined && (replyGenerationTasks.get(generation)?.size ?? 0) > 0;
}

/**
 * 记忆淘汰时清理群运行时缓存，并在无在途任务时回收取消控制器。
 *
 * @param chatId 群聊 ID
 */
export function evictChatReplyGeneration(chatId: number): void {
  const generation: number | undefined = replyGenerations.get(chatId);
  invalidateChatRuntimeCache(chatId);
  if (generation === undefined) return;
  if (!replyGenerationTasks.has(generation)) replyAbortControllers.delete(generation);
}

/**
 * 获取或创建指定代际的取消信号。
 *
 * @param generation 回复代际编号
 * @returns 绑定该回复代际生命周期的 AbortSignal
 */
export function replyGenerationSignal(generation: number): AbortSignal {
  let controller: AbortController | undefined = replyAbortControllers.get(generation);
  if (controller === undefined) {
    controller = new AbortController();
    replyAbortControllers.set(generation, controller);
  }
  return controller.signal;
}

/**
 * 登记受代际生命周期约束的异步任务，任务结算后自动清理登记项与过期控制器。
 *
 * @param chatId 群聊 ID
 * @param generation 所属回复代际编号
 * @param task 待追踪的异步任务 Promise
 */
export function trackReplyGenerationTask(
  chatId: number,
  generation: number,
  task: Promise<void>
): void {
  let tasks: Set<Promise<void>> | undefined = replyGenerationTasks.get(generation);
  if (tasks === undefined) {
    tasks = new Set();
    replyGenerationTasks.set(generation, tasks);
  }
  tasks.add(task);
  void task.finally((): void => {
    const current: Set<Promise<void>> | undefined = replyGenerationTasks.get(generation);
    current?.delete(task);
    if (current?.size === 0) {
      replyGenerationTasks.delete(generation);
      if (!isCachedReplyGenerationCurrent(chatId, generation)) {
        replyAbortControllers.delete(generation);
      }
    }
  }).catch((): void => {
    // 任务拒绝由创建方自行处理，此处仅观测结算时机。
  });
}

/** 停机时中止全部回复代际控制器、清理运行时缓存并等待所有已登记任务结算。 */
export async function quiesceAiChatReplies(): Promise<void> {
  for (const controller of replyAbortControllers.values()) {
    controller.abort(new DOMException("AI chat Worker is quiescing.", "AbortError"));
  }
  for (const chatId of replyGenerations.keys()) {
    invalidateChatRuntimeCache(chatId);
  }
  while (replyGenerationTasks.size > 0) {
    const tasks: Promise<void>[] = [];
    for (const generationTasks of replyGenerationTasks.values()) {
      tasks.push(...generationTasks);
    }
    if (tasks.length === 0) break;
    await Promise.allSettled(tasks);
  }
  replyAbortControllers.clear();
}

/**
 * 同步中止目标群当前代际并清理运行时缓存，在 AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS
 * 预算内等待该代际在途任务结算。
 *
 * @param chatId 群聊 ID
 * @returns 在途任务排空或等待超时后 resolve 的 Promise
 */
export function invalidateChatReplies(chatId: number): Promise<void> {
  const generation: number = cachedReplyGeneration(chatId);
  replyAbortControllers.get(generation)?.abort(
    new DOMException("AI chat generation invalidated.", "AbortError")
  );
  invalidateChatRuntimeCache(chatId);
  const tasks: Set<Promise<void>> | undefined = replyGenerationTasks.get(generation);
  if (tasks === undefined || tasks.size === 0) {
    replyAbortControllers.delete(generation);
    return Promise.resolve();
  }
  const pending: number = tasks.size;
  return settleWithinBudget(tasks, AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS).then((settled: boolean): void => {
    if (!settled) {
      logger.error(
        `AI chat invalidation for chat ${chatId} gave up waiting on ${pending} generation task(s) ` +
        `after ${AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS}ms; they stay generation-guarded and cannot write anymore.`
      );
    }
    replyGenerationTasks.delete(generation);
    replyAbortControllers.delete(generation);
  });
}
