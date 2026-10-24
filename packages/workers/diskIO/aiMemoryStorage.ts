/**
 * Disk I/O Worker 的 AI 记忆落盘调度：按 revision 接管快照与删除，将变更排入共享 SQLite
 * 事务缓冲，参见 docs/cn/04-invariants.md。
 */

import {
  aiMemoryDeletePersistedNotifier,
  aiMemoryImmediateChats,
  hydrateAiMemoryCache,
  markAiMemoryDeleted,
  markAiMemoryDirty,
} from "../../cache/workers/diskIO/snapshots";
import { rejectedStorageDomains } from "../../cache/workers/diskIO/storageDatabase";
import { assertAiContextSnapshot, queueAiContextWrite } from "./storageDatabase/aiContext";
import { commitStorageUrgently, scheduleStorageCommit } from "./storageDatabase/flush";

/**
 * 启动恢复阶段接管已校验快照并初始化 revision 水位线。
 * @param snapshots 从共享 SQLite 恢复的 `chatId -> snapshot` 映射。
 * @returns 供启动载荷回传的快照副本映射。
 */
export function adoptAiMemorySnapshots(
  snapshots: ReadonlyMap<number, string>
): Map<number, string> {
  hydrateAiMemoryCache(snapshots);
  return new Map(snapshots);
}

/** 标记 AI 记忆快照脏状态并排入事务缓冲的参数。 */
export interface MarkAiMemorySnapshotDirtyParams {
  /** 目标群或会话 ID。 */
  chatId: number;
  /** 快照单调递增版本号。 */
  revision: number;
  /** 序列化后的 AI 记忆快照 JSON 文本。 */
  snapshot: string;
  /** 为 true 时立即提交共享 SQLite 事务并在落盘后发送回执。 */
  persistImmediately?: boolean;
}

/**
 * 校验并接管快照变更；非法快照登记领域拒收，persistImmediately 为真时立即提交事务。
 * @param params 快照变更参数。
 */
export function markAiMemorySnapshotDirty({
  chatId,
  revision,
  snapshot,
  persistImmediately = false,
}: MarkAiMemorySnapshotDirtyParams): void {
  try {
    assertAiContextSnapshot(chatId, snapshot);
  } catch (error: unknown) {
    rejectedStorageDomains.add("aiMemory");
    console.error(`[diskIOWorker] rejected an invalid AI memory snapshot for chat ${chatId}:`, error);
    return;
  }
  if (!markAiMemoryDirty(chatId, revision)) return;
  queueAiContextWrite(chatId, snapshot, revision);
  if (!persistImmediately) {
    scheduleStorageCommit();
    return;
  }
  aiMemoryImmediateChats.add(chatId);
  commitStorageUrgently();
}

/**
 * 接管删除请求并立即提交；已被更新 revision 覆盖时直接发出回执。
 * @param chatId 待清空 AI 记忆的群或会话 ID。
 * @param revision 删除请求对应的版本号。
 */
export function deleteAiMemorySnapshot(chatId: number, revision: number): void {
  if (!markAiMemoryDeleted(chatId, revision)) {
    aiMemoryDeletePersistedNotifier.current({ type: "aiMemoryDeletedPersisted", chatId, revision });
    return;
  }
  queueAiContextWrite(chatId, null, revision);
  commitStorageUrgently();
}
