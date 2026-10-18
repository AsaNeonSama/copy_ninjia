/** owner: workers/diskIO。AI 记忆 revision 水位线与持久化回执出口（packages/workers/diskIO/aiMemoryStorage.ts）。 */

import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
} from "../../../types/diskIO/replies";

/**
 * 群 ID 到已受理最新 AI 记忆 revision 的水位线映射：
 * - 填充：hydrateAiMemoryCache 按磁盘现存快照初始化为零值，运行期由 markAiMemoryDirty 与 markAiMemoryDeleted 推进；
 * - 清理与容量：收到 forgetAiMemory 消息（forgetAiMemoryChat）、hydrateAiMemoryCache 或 resetAiMemoryCache 时移除；容量与活跃群数同阶，Worker 重建后由 hydrate 与主线程 onDiskIORespawn 重放恢复。
 */
export const aiMemoryRevisions: Map<number, number> = new Map();
/** 群 ID 到最新 revision 对应操作类型（upsert 或 delete）的映射：与 aiMemoryRevisions 成对写入、同步清理与重建。 */
export const aiMemoryOperations: Map<number, "upsert" | "delete"> = new Map();
/** 需要在下次 SQLite 事务提交后发送即时持久化回执的群 ID 集合：purge 后首份新快照入队时登记，事务提交结算（settleAiContextPersisted）、markAiMemoryDeleted 或 resetAiMemoryCache 时移除；容量上限为受管群数，Worker 重建后从空集开始。 */
export const aiMemoryImmediateChats: Set<number> = new Set();

/** AI 记忆删除 durable 回执发送回调单例：Disk I/O Worker 启动时注入，isolate 销毁时释放；单例函数。 */
export const aiMemoryDeletePersistedNotifier: {
  current: (reply: AiMemoryDeletedPersistedReply) => void;
} = {
  current: (): void => {
    // Worker 入口会在处理消息前配置；快照 owner 单测不需要回执出口。
  },
};

/** AI 记忆即时快照 durable 回执发送回调单例：Disk I/O Worker 启动时注入，isolate 销毁时释放；单例函数。 */
export const aiMemoryPersistedNotifier: {
  current: (reply: AiMemoryPersistedReply) => void;
} = {
  current: (): void => {
    // Worker 入口会在处理消息前配置；快照 owner 单测不需要回执出口。
  },
};

/** 按磁盘现存快照重建全部群的 revision 水位线，并清空旧水位与待回执集合。 */
export function hydrateAiMemoryCache(snapshots: ReadonlyMap<number, string>): void {
  resetAiMemoryCache();
  for (const chatId of snapshots.keys()) {
    aiMemoryRevisions.set(chatId, 0);
    aiMemoryOperations.set(chatId, "upsert");
  }
}

/** 校验并记录指定群的 AI 记忆 upsert revision（拒绝过期或同 revision 已被 delete 覆盖的写入）。 */
export function markAiMemoryDirty(chatId: number, revision: number): boolean {
  const currentRevision: number = aiMemoryRevisions.get(chatId) ?? -1;
  const currentOperation: "delete" | "upsert" | undefined = aiMemoryOperations.get(chatId);
  if (revision < currentRevision || (revision === currentRevision && currentOperation === "delete")) return false;
  aiMemoryRevisions.set(chatId, revision);
  aiMemoryOperations.set(chatId, "upsert");
  return true;
}

/** 校验并记录指定群的 AI 记忆删除 revision，同时清除该群尚未结算的即时持久化回执标记。 */
export function markAiMemoryDeleted(chatId: number, revision: number): boolean {
  const currentRevision: number = aiMemoryRevisions.get(chatId) ?? -1;
  const currentOperation: "delete" | "upsert" | undefined = aiMemoryOperations.get(chatId);
  if (revision < currentRevision || (revision === currentRevision && currentOperation === "upsert")) return false;
  aiMemoryRevisions.set(chatId, revision);
  aiMemoryOperations.set(chatId, "delete");
  aiMemoryImmediateChats.delete(chatId);
  return true;
}

/** 移除指定群的 AI 记忆 revision 水位线记录（由 forgetAiMemory 消息触发）。 */
export function forgetAiMemoryChat(chatId: number): void {
  aiMemoryRevisions.delete(chatId);
  aiMemoryOperations.delete(chatId);
}

/** 清空全部群的 AI 记忆 revision 水位线与待回执集合。 */
export function resetAiMemoryCache(): void {
  aiMemoryRevisions.clear();
  aiMemoryOperations.clear();
  aiMemoryImmediateChats.clear();
}
