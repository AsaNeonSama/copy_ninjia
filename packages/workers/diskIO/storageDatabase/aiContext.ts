/**
 * AI 上下文在共享 SQLite 事务缓冲中的写入与回执结算边界。
 */

import {
  aiMemoryDeletePersistedNotifier,
  aiMemoryImmediateChats,
  aiMemoryPersistedNotifier,
} from "../../../cache/workers/diskIO/snapshots";
import { pendingAiContextWrites } from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { assertTelegramChatId } from "../../../database/codec/chatState";
import { aiContextSource } from "../../../database/interact/aiContext";
import { parseAiMemorySnapshot } from "../../../libs/persistedSnapshotCodec";
import type { PendingAiContextWrite } from "../../../types/identityStorage";

/**
 * 严格校验单群 AI 上下文快照。
 * @param chatId 目标群或会话 ID。
 * @param snapshot 待校验的 AI 记忆快照 JSON 文本。
 */
export function assertAiContextSnapshot(chatId: number, snapshot: string): void {
  const source: string = aiContextSource(IDENTITY_DATABASE_PATH, chatId);
  assertTelegramChatId(chatId, source);
  parseAiMemorySnapshot(snapshot, source);
}

/**
 * 将群 AI 上下文最终值排入共享事务缓冲（null 表示清空，同群后写覆盖先写并保留被覆盖的删除 revision）。
 * @param chatId 目标群或会话 ID。
 * @param snapshot 最新 AI 记忆快照 JSON 文本；删除时为 null。
 * @param revision 变更单调递增版本号。
 */
export function queueAiContextWrite(chatId: number, snapshot: string | null, revision: number): void {
  const previous: PendingAiContextWrite | undefined = pendingAiContextWrites.get(chatId);
  const coveredDeleteRevision: number | null = previous === undefined
    ? null
    : previous.snapshot === null ? previous.revision : previous.coveredDeleteRevision;
  pendingAiContextWrites.set(chatId, { snapshot, revision, coveredDeleteRevision });
}

/**
 * 判断缓冲中是否存在待回执删除或需立即持久化的快照。
 * @returns 存在删除请求、被覆盖删除或 `persistImmediately` 群时返回 true，否则返回 false。
 */
export function hasUrgentAiContextWrites(): boolean {
  for (const [chatId, change] of pendingAiContextWrites) {
    if (
      change.snapshot === null ||
      change.coveredDeleteRevision !== null ||
      aiMemoryImmediateChats.has(chatId)
    ) return true;
  }
  return false;
}

/**
 * 事务提交成功后发出该群 AI 上下文的删除或即时写入回执。
 * @param chatId 已提交变更的群或会话 ID。
 * @param change 本次事务已提交的 AI 上下文写入项。
 */
export function settleAiContextPersisted(chatId: number, change: PendingAiContextWrite): void {
  if (change.coveredDeleteRevision !== null) {
    aiMemoryDeletePersistedNotifier.current({
      type: "aiMemoryDeletedPersisted",
      chatId,
      revision: change.coveredDeleteRevision,
    });
  }
  if (change.snapshot === null) {
    aiMemoryDeletePersistedNotifier.current({
      type: "aiMemoryDeletedPersisted",
      chatId,
      revision: change.revision,
    });
    return;
  }
  if (!aiMemoryImmediateChats.has(chatId)) return;
  aiMemoryImmediateChats.delete(chatId);
  aiMemoryPersistedNotifier.current({
    type: "aiMemoryPersisted",
    chatId,
    revision: change.revision,
  });
}
