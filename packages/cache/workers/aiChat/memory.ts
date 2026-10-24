/** owner: workers/aiChat。群聊滚动记忆与同源消息索引（packages/workers/aiChat/rollingMemory.ts）。 */

import type { BoundedDeque } from "../../../libs/boundedDeque";
import type { BufferedMessage } from "../../../types/aiChat/memory";

/**
 * chatId -> 逐字上下文滚动队列。
 * 填充：rollingMemory.ts 在消息入队或 hydrate 快照时写入。
 * 清理：clearChatMemoryCache、ensureMemoryCapacity 的 LRU 淘汰、resetAiChatMemoryCache 删除或清空。
 * 重建：Worker 崩溃重启后由主线程 latestAiMemories 快照重新 hydrate。
 * 容量：群数上限为 AI_MEMORY_MAX_CHATS（consts/aiChat/memory.ts），满载按 chatLastActivityTimes 淘汰最久未活动群；单群条数由 BoundedDeque 封顶。
 */
export const chatBuffers: Map<number, BoundedDeque<BufferedMessage>> = new Map();

/**
 * chatId -> 已完成的冷历史摘要队列。
 * 填充：轮换压缩完成或快照恢复时写入。
 * 清理：随 chatBuffers 同一次群淘汰或清理一并删除。
 * 重建：随 chatBuffers 由主线程快照恢复。
 * 容量：群数与 chatBuffers 同界，单群条数上限为 MAX_SUMMARY_ROUNDS，满载时挤出最旧摘要。
 */
export const chatSummaries: Map<number, BoundedDeque<string>> = new Map();

/**
 * chatId -> 尚未合并进 chatSummaries 的中期摘要文本。
 * 填充：compaction.ts 压缩完成或快照恢复时写入。
 * 清理：合并进 chatSummaries 或群记忆清理、淘汰时删除。
 * 重建：随 chatBuffers 由主线程快照恢复。
 * 容量：每群至多一条，随 chatBuffers 同界。
 */
export const pendingSummaries: Map<number, string> = new Map();

/**
 * 待在下一次周期上报快照的群 ID 集合。
 * 填充：记忆变更时登记；清理：成功上报或群记忆删除时移除；重建：新 isolate 从空集合开始；容量：chatBuffers 的子集，上限为 AI_MEMORY_MAX_CHATS。
 */
export const dirtyMemoryChats: Set<number> = new Set();

/**
 * chatId -> 最近一次记入滚动缓存的时间戳，供 ensureMemoryCapacity 做 LRU 淘汰排序。
 * 填充：消息记入或 hydrate 快照时写入；清理：随群记忆清理或淘汰删除；重建：hydrate 时以快照 savedAt 播种。容量与 chatBuffers 同界。
 */
export const chatLastActivityTimes: Map<number, number> = new Map();

/**
 * chatId -> (messageId -> BufferedMessage) 的热区消息派生索引（workers/aiChat/bufferedMessageIndex.ts）。
 * 填充：消息推入 chatBuffers 或 hydrate 重建时登记。
 * 清理：轮换移出热区时删键，群记忆清理或淘汰时整群删除。
 * 重建：hydrate 时从恢复的 chatBuffers 重建。
 * 容量：受 AI_MEMORY_MAX_CHATS 与 VERBATIM_CONTEXT_MAX 约束，不设独立淘汰。
 */
export const chatMessageIndexes: Map<number, Map<number, BufferedMessage>> = new Map();

/**
 * 判断指定群是否存在可持久化记忆。
 *
 * @param chatId 群聊 ID
 * @returns 是否存在逐字缓冲、历史摘要或待合并摘要
 */
export function hasChatMemory(chatId: number): boolean {
  return chatBuffers.has(chatId) || chatSummaries.has(chatId) || pendingSummaries.has(chatId);
}

/**
 * 返回当前持有可持久化记忆的群 ID 集合快照。
 *
 * @returns 持有可持久化记忆的群聊 ID 集合
 */
export function chatMemoryIds(): Set<number> {
  return new Set([...chatBuffers.keys(), ...chatSummaries.keys(), ...pendingSummaries.keys()]);
}

/**
 * 删除指定群的全部记忆与消息索引缓存。
 *
 * @param chatId 群聊 ID
 */
export function clearChatMemoryCache(chatId: number): void {
  chatBuffers.delete(chatId);
  chatSummaries.delete(chatId);
  pendingSummaries.delete(chatId);
  dirtyMemoryChats.delete(chatId);
  chatLastActivityTimes.delete(chatId);
  chatMessageIndexes.delete(chatId);
}

/** 清空所有群的记忆与索引缓存。 */
export function resetAiChatMemoryCache(): void {
  chatBuffers.clear();
  chatSummaries.clear();
  pendingSummaries.clear();
  dirtyMemoryChats.clear();
  chatLastActivityTimes.clear();
  chatMessageIndexes.clear();
}
