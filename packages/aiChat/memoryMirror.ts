/**
 * AI 记忆与贴纸目录的主线程镜像维护：按群单调递增的记忆 revision、待确认删除墓碑、删除回执等待表，
 * 以及 Disk I/O Worker 重建后的记忆与贴纸目录镜像重放。
 * @see ../../docs/cn/04-invariants.md
 */

import {
  onDiskIOReply,
  onDiskIOGiveUp,
  onDiskIORespawn,
  postDiskIO,
} from "../infra/diskIO";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import {
  aiMemoryDeleteWaiters,
  aiChatWorkerState,
  aiMemoryRevisionCounters,
  aiMemoryRevisionFloor,
  aiMemoryUsages,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  pendingAiMemoryDeletes,
  pendingAiMemoryTeardowns,
  postPurgeAiMemoryPersistRevisions,
} from "../cache/main/aiChat";
import { AI_MEMORY_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import { pendingStickerCatalogRevisions } from "../cache/main/stickers";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { signalDiskIOFatal } from "../infra/diskIO/fatal";
import type { AiMemoryDeleteWaiter, AiMemoryTeardown } from "../types/aiChat/waiters";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
} from "../types/diskIO/replies";
import type { DiskIORecoveryTransport } from "../types/diskIO/messages";

/**
 * 分配并返回该群的下一个记忆 revision。
 * @param chatId 群聊 ID。
 * @returns 新分配的单调递增记忆 revision。
 */
export function nextAiMemoryRevision(chatId: number): number {
  const revision: number = (aiMemoryRevisionCounters.get(chatId) ?? aiMemoryRevisionFloor.current) + 1;
  aiMemoryRevisionCounters.set(chatId, revision);
  return revision;
}

/**
 * 在快照、首份持久化标志、墓碑与删除等待者均已清空时，释放该群的 revision 计数并通知 Disk I/O 释放对应水位。
 * @param chatId 群聊 ID。
 */
export function forgetAiMemoryRevisionCounter(chatId: number): void {
  if (
    pendingAiMemoryDeletes.has(chatId) ||
    aiMemoryDeleteWaiters.has(chatId) ||
    postPurgeAiMemoryPersistRevisions.has(chatId) ||
    latestAiMemories.has(chatId)
  ) {
    return;
  }
  aiMemoryRevisionFloor.current = Math.max(aiMemoryRevisionFloor.current, aiMemoryRevisionCounters.get(chatId) ?? 0);
  aiMemoryRevisionCounters.delete(chatId);
  postDiskIO({ type: "forgetAiMemory", chatId });
}

/**
 * 登记该群的记忆 teardown 状态；超出受管群上限时触发 Disk I/O 致命错误并抛错。
 * @param chatId 群聊 ID。
 */
export function beginAiMemoryTeardown(chatId: number): void {
  if (!pendingAiMemoryTeardowns.has(chatId) && pendingAiMemoryTeardowns.size >= STATE_MANAGED_CHAT_LIMIT) {
    const error: Error = new Error("AI memory teardown capacity was exhausted.");
    signalDiskIOFatal(error);
    throw error;
  }
  pendingAiMemoryTeardowns.set(chatId, { requestId: null, workerSettled: !aiChatWorkerState.available });
}

/**
 * 检查并完成该群的记忆 teardown 收尾；若已有新记忆写入则仅移除旧 teardown 登记。
 * @param chatId 群聊 ID。
 */
export function finishAiMemoryTeardown(chatId: number): void {
  const teardown: AiMemoryTeardown | undefined = pendingAiMemoryTeardowns.get(chatId);
  if (teardown === undefined) return;
  if (latestAiMemories.has(chatId) || postPurgeAiMemoryPersistRevisions.has(chatId)) {
    pendingAiMemoryTeardowns.delete(chatId);
    return;
  }
  if (!teardown.workerSettled || pendingAiMemoryDeletes.has(chatId) || aiMemoryDeleteWaiters.has(chatId)) return;
  forgetAiMemoryRevisionCounter(chatId);
  pendingAiMemoryTeardowns.delete(chatId);
}

/** 将所有在途记忆 teardown 的 Worker 侧状态标为已结算，并尝试完成收尾。 */
export function settleAiMemoryTeardownWorker(): void {
  for (const [chatId, teardown] of pendingAiMemoryTeardowns) {
    teardown.workerSettled = true;
    finishAiMemoryTeardown(chatId);
  }
}

/**
 * 从指定群的删除回执等待列表中移除单个等待项；列表为空时删除该群条目。
 * @param chatId 群聊 ID。
 * @param waiter 待移除的删除回执等待项。
 */
function removeDeleteWaiter(chatId: number, waiter: AiMemoryDeleteWaiter): void {
  const waiters: AiMemoryDeleteWaiter[] | undefined = aiMemoryDeleteWaiters.get(chatId);
  if (!waiters) return;
  const index: number = waiters.indexOf(waiter);
  if (index >= 0) waiters.splice(index, 1);
  if (waiters.length === 0) aiMemoryDeleteWaiters.delete(chatId);
}

/**
 * 注册带超时的持久化删除回执等待者。
 * @param chatId 群聊 ID。
 * @param revision 期望落盘确认的删除墓碑 revision。
 * @returns 在收到不旧于 `revision` 的删除回执时 resolve、超时或 Disk I/O 放弃自愈时 reject 的 Promise。
 */
function waitForAiMemoryDelete(chatId: number, revision: number): Promise<void> {
  return new Promise((resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => {
    const waiter: AiMemoryDeleteWaiter = {
      revision,
      resolve,
      reject,
      timer: setTimeout((): void => {
        removeDeleteWaiter(chatId, waiter);
        reject(new Error(
          `AI memory deletion for chat ${chatId} revision ${revision} timed out after ${AI_MEMORY_FLUSH_TIMEOUT_MS}ms.`
        ));
      }, AI_MEMORY_FLUSH_TIMEOUT_MS),
    };
    const waiters: AiMemoryDeleteWaiter[] = aiMemoryDeleteWaiters.get(chatId) ?? [];
    waiters.push(waiter);
    aiMemoryDeleteWaiters.set(chatId, waiters);
  });
}

/**
 * 清空该群主线程记忆镜像并向 Disk I/O 投递删除墓碑；`wait` 为 true 时等待持久化回执。
 * @param chatId 群聊 ID。
 * @param wait 是否等待 Disk I/O 持久化删除确认回执。
 * @returns `wait` 为 `true` 时返回等待落盘完成的 Promise，`wait` 为 `false` 时返回 `undefined`。
 */
export function requestAiMemoryDelete(chatId: number, wait: true): Promise<void>;
export function requestAiMemoryDelete(chatId: number, wait: false): undefined;
export function requestAiMemoryDelete(chatId: number, wait: boolean): Promise<void> | undefined {
  postPurgeAiMemoryPersistRevisions.delete(chatId);
  const hadLatestSnapshot: boolean = latestAiMemories.delete(chatId);
  latestAiMemoryRevisions.delete(chatId);
  aiMemoryUsages.delete(chatId);
  let revision: number | undefined = pendingAiMemoryDeletes.get(chatId);
  if (revision === undefined || hadLatestSnapshot) {
    revision = nextAiMemoryRevision(chatId);
    pendingAiMemoryDeletes.set(chatId, revision);
  }
  const persisted: Promise<void> | undefined = wait ? waitForAiMemoryDelete(chatId, revision) : undefined;
  if (postDiskIO({ type: "deleteAiMemory", chatId, revision }) === false && persisted !== undefined) {
    const waiters: AiMemoryDeleteWaiter[] = aiMemoryDeleteWaiters.get(chatId) ?? [];
    for (const waiter of [...waiters]) {
      if (waiter.revision !== revision) continue;
      clearTimeout(waiter.timer);
      removeDeleteWaiter(chatId, waiter);
      waiter.reject(new Error(`Persistence Worker rejected AI memory deletion for chat ${chatId}.`));
    }
  }
  return persisted;
}

onDiskIOGiveUp((): void => {
  for (const waiters of aiMemoryDeleteWaiters.values()) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(
        "Persistence Worker gave up self-healing before the AI memory deletion was durable."
      ));
    }
  }
  aiMemoryDeleteWaiters.clear();
});

onDiskIOReply("aiMemoryDeletedPersisted", (reply: AiMemoryDeletedPersistedReply): void => {
  if (pendingAiMemoryDeletes.get(reply.chatId) === reply.revision) {
    pendingAiMemoryDeletes.delete(reply.chatId);
  }
  const waiters: AiMemoryDeleteWaiter[] = aiMemoryDeleteWaiters.get(reply.chatId) ?? [];
  for (const waiter of [...waiters]) {
    if (waiter.revision > reply.revision) continue;
    clearTimeout(waiter.timer);
    removeDeleteWaiter(reply.chatId, waiter);
    waiter.resolve();
  }
  finishAiMemoryTeardown(reply.chatId);
});

onDiskIOReply("aiMemoryPersisted", (reply: AiMemoryPersistedReply): void => {
  const expectedRevision: number | null | undefined =
    postPurgeAiMemoryPersistRevisions.get(reply.chatId);
  if (expectedRevision === undefined || expectedRevision === null) return;
  if (reply.revision >= expectedRevision) {
    postPurgeAiMemoryPersistRevisions.delete(reply.chatId);
  }
});

onDiskIORespawn("AI memory", DISK_IO_RESPAWN_PRIORITIES.AI_MEMORY, (transport: DiskIORecoveryTransport): boolean => {
  for (const [chatId, revision] of pendingAiMemoryDeletes) {
    if (!transport.post({ type: "deleteAiMemory", chatId, revision })) return false;
  }
  for (const [chatId, snapshot] of latestAiMemories) {
    const revision: number = latestAiMemoryRevisions.get(chatId) ?? 0;
    const immediateRevision: number | null | undefined =
      postPurgeAiMemoryPersistRevisions.get(chatId);
    if (!transport.post({
      type: "aiMemory",
      chatId,
      revision,
      snapshot,
      persistImmediately: immediateRevision !== undefined &&
        immediateRevision !== null &&
        revision >= immediateRevision,
    })) {
      return false;
    }
  }
  for (const [pack, snapshot] of latestStickerCatalogs) {
    if (!transport.post({ type: "stickerCatalog", pack, snapshot, revision: pendingStickerCatalogRevisions.get(pack) ?? 0 })) return false;
  }
  return true;
});
