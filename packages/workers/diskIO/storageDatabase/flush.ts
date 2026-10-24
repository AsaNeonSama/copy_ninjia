import { STORAGE_DATABASE_DOMAINS, STORAGE_WRITE_MAX_FAILURES } from "../../../consts/diskIO/business";
import {
  resetStoragePendingBudgets,
  storageWriteRetry,
  storageWriteFatalReply,
  pendingAiContextWrites,
  pendingBlocklistWrites,
  pendingChatQaEntryCount,
  pendingChatQaWrites,
  pendingChatStateWrites,
  pendingRemovalWrites,
  pendingTemporaryAdBypassWrites,
  pendingWhitelistWrites,
  rejectedStorageDomains,
  storageDatabaseClosed,
  storageDatabaseWriters,
  storagePersistenceReplyHolder,
  storageFlushHold,
  storageWriteFlushTimer,
} from "../../../cache/workers/diskIO/storageDatabase";
import {
  CHAT_QA_WRITE_BATCH_MAX_ENTRIES,
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
  IDENTITY_WRITE_FLUSH_INTERVAL_MS,
} from "../../../consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../consts/storage";
import {
  commitStorageDatabaseChanges,
  prepareStorageDatabaseWriter,
} from "../../../database/interact/transaction";
import type {
  BlocklistRemovalPersistedRevision,
  ChatQaPersistedRevision,
  ChatStatePersistedRevision,
  DiskIODomain,
  IdentityPersistenceReply,
  IdentityPolicyPersistedRevision,
  StorageDatabaseDomain,
  TemporaryAdBypassPersistedRevision,
} from "../../../types/diskIO/replies";
import type { StorageDatabaseWriter } from "../../../types/storageDatabase";
import { queueTimedDiskIOOperation } from "../timedFlush";
import { settleAiContextPersisted } from "./aiContext";
import { perConnection } from "./context";

/**
 * 当前连接的预编译写语句；每条连接首次提交时建一次。
 * @returns 当前连接的预编译写入语句集合。
 */
function storageDatabaseWriter(): StorageDatabaseWriter {
  return perConnection(storageDatabaseWriters, prepareStorageDatabaseWriter);
}

/**
 * 任一共享 SQLite 业务表或 AI 上下文存在待提交最终值时返回 true。
 * @returns 任一写缓冲非空时返回 true，否则返回 false。
 */
function hasPendingStorageWrites(): boolean {
  return pendingWhitelistWrites.size > 0 ||
    pendingBlocklistWrites.size > 0 ||
    pendingTemporaryAdBypassWrites.size > 0 ||
    pendingRemovalWrites.size > 0 ||
    pendingChatStateWrites.size > 0 ||
    pendingChatQaWrites.size > 0 ||
    pendingAiContextWrites.size > 0;
}

/** 执行定时到点的共享 SQLite 事务提交。 */
function runScheduledStorageCommit(): void {
  if (!hasPendingStorageWrites() || storageDatabaseClosed.current) return;
  if (storageFlushHold.current) {
    scheduleStorageCommit();
    return;
  }
  const reply: IdentityPersistenceReply | null = storagePersistenceReplyHolder.current;
  if (reply === null) {
    console.error("[diskIOWorker] storage database flush reply channel is unavailable.");
    scheduleStorageCommit();
    return;
  }
  flushStorageDatabase(reply);
}

/** 按需注册共享 SQLite 事务的定时提交 timer，到点后经统一操作队列合并执行。 */
export function scheduleStorageCommit(): void {
  if (
    !hasPendingStorageWrites() ||
    storageWriteFlushTimer.current !== null ||
    storageWriteRetry.signaled ||
    storageDatabaseClosed.current
  ) return;
  storageWriteFlushTimer.current = setTimeout((): void => {
    storageWriteFlushTimer.current = null;
    queueTimedDiskIOOperation(runScheduledStorageCommit);
  }, Math.max(IDENTITY_WRITE_FLUSH_INTERVAL_MS, storageWriteRetry.retryAt - performance.now()));
  storageWriteFlushTimer.current.unref();
}

/** 立即提交共享 SQLite 事务；处于重放暂挂、失败退避或无回执通道时改为注册定时提交。 */
export function commitStorageUrgently(): void {
  const reply: IdentityPersistenceReply | null = storagePersistenceReplyHolder.current;
  if (storageFlushHold.current || storageWriteRetry.failures > 0 || reply === null) {
    scheduleStorageCommit();
    return;
  }
  flushStorageDatabase(reply);
}

/**
 * 任一领域达到批次阈值时立即提交共享事务，否则注册定时提交（重放暂挂或退避期仅挂 timer）。
 * @param reply 向主线程发送持久化回执的出口。
 */
export function flushIfStorageFull(reply: IdentityPersistenceReply): void {
  if (storageWriteRetry.failures > 0 || storageFlushHold.current) { scheduleStorageCommit(); return; }
  if (
    pendingWhitelistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingBlocklistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingTemporaryAdBypassWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingRemovalWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingChatQaEntryCount.current >= CHAT_QA_WRITE_BATCH_MAX_ENTRIES ||
    pendingChatStateWrites.size >= STATE_MANAGED_CHAT_LIMIT
  ) {
    flushStorageDatabase(reply);
    return;
  }
  scheduleStorageCommit();
}

/**
 * 在单个显式事务中提交全部共享 SQLite 业务表与 AI 上下文待写项，成功后清空缓冲并发出回执。
 * 失败时累加退避计数并重排 timer；关库后存在待写项时直接返回 false。参见 docs/cn/04-invariants.md。
 * @param reply 向主线程发送持久化回执的出口。
 * @returns 无待写项或事务提交成功时返回 true，关库拒写或事务抛错时返回 false。
 */
export function flushStorageDatabase(reply: IdentityPersistenceReply): boolean {
  if (!hasPendingStorageWrites()) return true;
  if (storageDatabaseClosed.current) return false;
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
  try {
    commitStorageDatabaseChanges(storageDatabaseWriter(), {
      whitelist: pendingWhitelistWrites,
      blocklist: pendingBlocklistWrites,
      temporaryAdBypass: pendingTemporaryAdBypassWrites,
      removals: pendingRemovalWrites,
      chatStates: pendingChatStateWrites,
      chatQa: pendingChatQaWrites,
      aiContexts: pendingAiContextWrites,
    });
  } catch (error: unknown) {
    console.error("[diskIOWorker] storage database transaction failed:", error);
    storageWriteRetry.failures++;
    storageWriteRetry.retryAt = performance.now() + IDENTITY_WRITE_FLUSH_INTERVAL_MS * storageWriteRetry.failures;
    if (storageWriteRetry.failures >= STORAGE_WRITE_MAX_FAILURES && !storageWriteRetry.signaled) {
      storageWriteRetry.signaled = true;
      storageWriteFatalReply.current?.();
    }
    scheduleStorageCommit();
    return false;
  }
  resetStoragePendingBudgets();
  storageWriteRetry.failures = 0;
  storageWriteRetry.retryAt = 0;
  storageWriteRetry.signaled = false;
  const acknowledgements: IdentityPolicyPersistedRevision[] = [];
  const temporaryAdBypassAcknowledgements: TemporaryAdBypassPersistedRevision[] = [];
  const chatStateAcknowledgements: ChatStatePersistedRevision[] = [];
  const chatQaAcknowledgements: ChatQaPersistedRevision[] = [];
  const removalAcknowledgements: BlocklistRemovalPersistedRevision[] = [];
  for (const [id, change] of pendingWhitelistWrites) {
    acknowledgements.push({ table: "whitelist", id, revision: change.revision });
  }
  pendingWhitelistWrites.clear();
  for (const [id, change] of pendingBlocklistWrites) {
    acknowledgements.push({ table: "blocklist", id, revision: change.revision });
  }
  pendingBlocklistWrites.clear();
  for (const [id, change] of pendingTemporaryAdBypassWrites) {
    temporaryAdBypassAcknowledgements.push({ id, revision: change.revision });
  }
  pendingTemporaryAdBypassWrites.clear();
  for (const [removalId, change] of pendingRemovalWrites) {
    removalAcknowledgements.push({ removalId, revision: change.revision });
  }
  pendingRemovalWrites.clear();
  for (const [chatId, change] of pendingChatStateWrites) {
    chatStateAcknowledgements.push({ chatId, revision: change.revision });
  }
  pendingChatStateWrites.clear();
  for (const [chatId, questions] of pendingChatQaWrites) {
    for (const [q, change] of questions) {
      chatQaAcknowledgements.push({ chatId, q, revision: change.revision });
    }
    pendingChatQaEntryCount.current -= questions.size;
  }
  pendingChatQaWrites.clear();
  for (const [chatId, change] of pendingAiContextWrites) {
    settleAiContextPersisted(chatId, change);
  }
  pendingAiContextWrites.clear();
  reply({
    type: "identityStoragePersisted",
    writes: acknowledgements,
    temporaryAdBypassWrites: temporaryAdBypassAcknowledgements,
    chatStateWrites: chatStateAcknowledgements,
    chatQaWrites: chatQaAcknowledgements,
    removalWrites: removalAcknowledgements,
  });
  scheduleStorageCommit();
  return true;
}

/**
 * 取出领域的拒收标记并合并其 dirty 状态。
 * @param domain 待检查的共享 SQLite 子领域。
 * @param dirty 该领域当前是否仍有未提交写缓冲。
 * @returns 发生过写入拒收或仍有未提交写缓冲时返回 true，否则返回 false。
 */
function takeStorageDomainFailure(domain: StorageDatabaseDomain, dirty: boolean): boolean {
  return rejectedStorageDomains.delete(domain) || dirty;
}

/**
 * 收集指定领域或全部共享 SQLite 领域的落盘失败与拒收状态。
 * @param scope 指定检查的单个子领域；为 null 时检查全部共享 SQLite 子领域。
 * @param failedDomains 收集失败领域的输出数组。
 */
export function collectStorageDatabaseFailures(
  scope: StorageDatabaseDomain | null,
  failedDomains: DiskIODomain[]
): void {
  if (scope !== null) {
    if (takeStorageDomainFailure(scope, isStorageDomainDirty(scope))) failedDomains.push(scope);
    return;
  }
  for (const domain of STORAGE_DATABASE_DOMAINS) {
    if (takeStorageDomainFailure(domain, isStorageDomainDirty(domain))) failedDomains.push(domain);
  }
}

/**
 * 判断指定领域的写缓冲是否仍有未提交项。
 * @param domain 待检查的共享 SQLite 子领域。
 * @returns 对应子领域的待写映射非空时返回 true，否则返回 false。
 */
function isStorageDomainDirty(domain: StorageDatabaseDomain): boolean {
  switch (domain) {
    case "whitelist": return pendingWhitelistWrites.size > 0;
    case "blocklist": return pendingBlocklistWrites.size > 0;
    case "temporaryAdBypass": return pendingTemporaryAdBypassWrites.size > 0;
    case "blocklistRemovalOutbox": return pendingRemovalWrites.size > 0;
    case "chatState": return pendingChatStateWrites.size > 0;
    case "chatQa": return pendingChatQaWrites.size > 0;
    case "aiMemory": return pendingAiContextWrites.size > 0;
  }
}
