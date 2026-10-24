import { logger } from "../../infra/logger";
import { BoundedDeque } from "../../libs/boundedDeque";
import { invalidInput } from "../../libs/inputValidation";
import { parseAiMemorySnapshot } from "../../libs/persistedSnapshotCodec";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import { AI_MEMORY_HYDRATE_BUFFER_MAX, AI_MEMORY_MAX_CHATS, COMPACT_BATCH_SIZE, MAX_SUMMARY_ROUNDS, VERBATIM_CONTEXT_MAX } from "../../consts/aiChat/memory";
import {
  chatBuffers,
  chatLastActivityTimes,
  chatSummaries,
  chatMemoryIds,
  clearChatMemoryCache,
  dirtyMemoryChats,
  hasChatMemory,
  pendingSummaries,
} from "../../cache/workers/aiChat/memory";
import { evictChatReplyGeneration, hasActiveAiChatTasks } from "./replyGeneration";
import type { AiMemorySnapshot, AiMemoryUsage, BufferedMessage } from "../../types/aiChat/memory";

/** 启动恢复时解析成功、等待按 savedAt 排序的一条群快照。 */
interface ParsedChatMemory {
  chatId: number;
  snapshot: AiMemorySnapshot;
}
import type {
  AiMemoryDeletedEvent,
  AiMemoryEvent,
  AiMemoryUsagesEvent,
  AiRecordMessage,
} from "../../types/aiChat/protocol";
import { buildBufferedMessage, normalizeHydratedBufferedMessage } from "./bufferedMessage";
import { scheduleRotation } from "./compaction";
import { indexBufferedMessage, unindexBufferedMessage } from "./bufferedMessageIndex";

declare const self: Worker;

/** 群滚动消息缓存的写入、块边界轮换触发、LRU 淘汰及快照序列化与恢复。 */

/**
 * 将缓存条目推入目标群滚动缓存、登记 message_id 索引，并在块边界触发轮换。
 *
 * @param chatId 群聊 ID
 * @param entry 待推入热区的缓冲消息条目
 * @param now 当前毫秒时间戳
 */
export function pushBufferedMessage(chatId: number, entry: BufferedMessage, now: number): void {
  if (!hasChatMemory(chatId)) ensureMemoryCapacity(chatId);
  chatLastActivityTimes.set(chatId, now);
  let buf: BoundedDeque<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf) {
    buf = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
    chatBuffers.set(chatId, buf);
  }
  buf.push(entry);
  indexBufferedMessage(chatId, entry);
  dirtyMemoryChats.add(chatId);
  if (buf.size === VERBATIM_CONTEXT_MAX) {
    for (let i: number = 0; i < COMPACT_BATCH_SIZE; i++) {
      const removed: BufferedMessage | undefined = buf.shift();
      if (removed) unindexBufferedMessage(chatId, removed);
    }
    scheduleRotation(chatId, buf.last(COMPACT_BATCH_SIZE), true);
  } else if (buf.size === COMPACT_BATCH_SIZE) {
    scheduleRotation(chatId, buf.last(COMPACT_BATCH_SIZE), false);
  }
}

/**
 * 清洗并记录一条群文字消息到滚动缓存；清洗后无正文时返回 null。
 *
 * @param message 主线程或自录路径构造的群文字消息载荷
 * @returns 已推入滚动缓存的消息条目；清洗后正文为空时返回 null
 */
export function recordChatMessage(message: AiRecordMessage): BufferedMessage | null {
  const now: number = Date.now();
  const entry: BufferedMessage | null = buildBufferedMessage(message, message.text, now);
  if (entry) pushBufferedMessage(message.chatId, entry, now);
  return entry;
}

/**
 * 在群数量达到 AI_MEMORY_MAX_CHATS 时按 LRU 淘汰最久未活跃的群（优先跳过仍有在途任务的群）。
 *
 * @param excludeChatId 本次正在写入、不得被淘汰的目标群聊 ID
 */
function ensureMemoryCapacity(excludeChatId: number): void {
  for (;;) {
    // 三表 size 之和是去重群数的上界；未达上限时不必构造去重集合。
    if (chatBuffers.size + chatSummaries.size + pendingSummaries.size < AI_MEMORY_MAX_CHATS) return;
    const memoryIds: Set<number> = chatMemoryIds();
    if (memoryIds.size < AI_MEMORY_MAX_CHATS) return;
    const findOldest = (excludeActiveReplies: boolean): number | undefined => {
      let oldestChatId: number | undefined;
      let oldestActivity: number = Number.POSITIVE_INFINITY;
      for (const candidate of memoryIds) {
        if (candidate === excludeChatId) continue;
        if (excludeActiveReplies && hasActiveAiChatTasks(candidate)) continue;
        const activity: number = chatLastActivityTimes.get(candidate) ?? 0;
        if (activity < oldestActivity) {
          oldestActivity = activity;
          oldestChatId = candidate;
        }
      }
      return oldestChatId;
    };
    const oldestChatId: number | undefined = findOldest(true) ?? findOldest(false);
    if (oldestChatId === undefined) return;

    evictChatReplyGeneration(oldestChatId);
    clearChatMemoryCache(oldestChatId);
    self.postMessage({ type: "memoryDeleted", chatId: oldestChatId } satisfies AiMemoryDeletedEvent);
  }
}

/**
 * 将目标群的滚动缓存、中期摘要与待晋升摘要序列化为快照 JSON。
 *
 * @param chatId 群聊 ID
 * @returns 序列化后的 `AiMemorySnapshot` JSON 字符串
 */
function buildMemorySnapshot(chatId: number): string {
  const buf: BoundedDeque<BufferedMessage> | undefined = chatBuffers.get(chatId);
  const summaryQueue: BoundedDeque<string> | undefined = chatSummaries.get(chatId);
  const snapshot: AiMemorySnapshot = {
    version: 1,
    buffer: buf ? buf.last(buf.size) : [],
    summaries: summaryQueue ? summaryQueue.last(summaryQueue.size) : [],
    pendingSummary: pendingSummaries.get(chatId) ?? null,
    savedAt: Date.now(),
  };
  return JSON.stringify(snapshot);
}

/**
 * 读取目标群当前的逐字缓存与中期摘要条数。
 *
 * @param chatId 群聊 ID
 * @returns 包含 `bufferedCount` 与 `summaryCount` 的群记忆占用快照
 */
function buildMemoryUsage(chatId: number): AiMemoryUsage {
  return {
    bufferedCount: chatBuffers.get(chatId)?.size ?? 0,
    summaryCount: chatSummaries.get(chatId)?.size ?? 0,
  };
}

/**
 * 目标群存在未上报变更时向主线程发送记忆快照并清除 dirty 标记。
 *
 * @param chatId 群聊 ID
 * @param persistImmediately 是否要求主线程立即转发落盘而不等待聚合周期
 */
export function flushMemorySnapshot(chatId: number, persistImmediately: boolean = false): void {
  if (!dirtyMemoryChats.has(chatId)) return;
  self.postMessage({
    type: "memory",
    chatId,
    snapshot: buildMemorySnapshot(chatId),
    persistImmediately,
    usage: buildMemoryUsage(chatId),
  } satisfies AiMemoryEvent);
  dirtyMemoryChats.delete(chatId);
}

/** 上报全部 dirty 群的记忆快照并清空 dirty 标记。 */
export function flushDirtyMemories(): void {
  if (dirtyMemoryChats.size === 0) return;
  for (const chatId of dirtyMemoryChats) flushMemorySnapshot(chatId);
}

/**
 * 启动恢复持久化的群记忆快照：按 savedAt 降序恢复内存中尚无数据的群（buffer 最多恢复
 * AI_MEMORY_HYDRATE_BUFFER_MAX 条），并向主线程上报各群占用量或空快照删除事件。
 *
 * @param memories 群聊 ID 到持久化快照 JSON 字符串的映射
 */
export function hydrateMemories(memories: Map<number, string>): void {
  const parsedMemories: ParsedChatMemory[] = [];
  for (const [chatId, snapshotJson] of memories) {
    if (!isTelegramGroupChatId(chatId)) {
      return invalidInput(
        "AI memory hydrate payload",
        "$.memories.<key>",
        "a negative safe integer Telegram group or channel ID"
      );
    }
    const snapshot: AiMemorySnapshot = parseAiMemorySnapshot(
      snapshotJson,
      `AI memory hydrate payload for chat ${chatId}`
    );
    if (chatBuffers.has(chatId)) continue;
    parsedMemories.push({ chatId, snapshot });
  }

  parsedMemories.sort((left: ParsedChatMemory, right: ParsedChatMemory): number => right.snapshot.savedAt - left.snapshot.savedAt);
  let skippedOverCapacity: number = 0;
  let memoryChatCount: number = chatMemoryIds().size;
  const usages: Map<number, AiMemoryUsage> = new Map();
  for (const { chatId, snapshot } of parsedMemories) {
    if (hasChatMemory(chatId)) continue;
    if (memoryChatCount >= AI_MEMORY_MAX_CHATS) {
      skippedOverCapacity++;
      continue;
    }

    const buf: BoundedDeque<BufferedMessage> =
      new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
    for (const message of snapshot.buffer.slice(-AI_MEMORY_HYDRATE_BUFFER_MAX)) {
      const normalized: BufferedMessage = normalizeHydratedBufferedMessage(message);
      buf.push(normalized);
      indexBufferedMessage(chatId, normalized);
    }
    if (buf.size > 0) chatBuffers.set(chatId, buf);

    if (snapshot.summaries.length > 0) {
      const queue: BoundedDeque<string> = new BoundedDeque<string>(MAX_SUMMARY_ROUNDS);
      for (const summary of snapshot.summaries.slice(-MAX_SUMMARY_ROUNDS)) {
        queue.push(summary);
      }
      chatSummaries.set(chatId, queue);
    }

    if (snapshot.pendingSummary) {
      pendingSummaries.set(chatId, snapshot.pendingSummary);
    }
    if (hasChatMemory(chatId)) {
      memoryChatCount++;
      chatLastActivityTimes.set(chatId, snapshot.savedAt);
      usages.set(chatId, buildMemoryUsage(chatId));
    } else {
      self.postMessage({ type: "memoryDeleted", chatId } satisfies AiMemoryDeletedEvent);
    }
  }
  if (usages.size > 0) {
    self.postMessage({ type: "memoryUsages", usages } satisfies AiMemoryUsagesEvent);
  }
  if (skippedOverCapacity > 0) {
    logger.error(
      `Left the persisted AI memory of ${skippedOverCapacity} chat(s) on disk without hydrating it: ` +
      `the in-memory ceiling of ${AI_MEMORY_MAX_CHATS} chat(s) was already reached.`
    );
  }
}
