import { STORAGE_DATABASE_DOMAINS, STORAGE_WRITE_MAX_FAILURES } from "../../../consts/diskIO/business";
import {
  resetStoragePendingBudgets,
  storagePendingBudgets,
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
import { errorMessage } from "../../../libs/errorMessage";
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
  RecoveryReplayFailedReply,
  StorageDatabaseDomain,
  TemporaryAdBypassPersistedRevision,
} from "../../../types/diskIO/replies";
import type { StorageDatabase, StorageDatabaseWriter } from "../../../types/storageDatabase";
import { queueTimedDiskIOOperation } from "../timedFlush";
import { hasUrgentAiContextWrites, settleAiContextPersisted } from "./aiContext";
import { assertPendingChatQaCapacity } from "./chatQa";
import { assertPendingChatStateInvariants } from "./chatState";
import { requireStorageDatabase } from "./context";

/** 当前连接的预编译写语句；每条连接首次提交时建一次。 */
function storageDatabaseWriter(): StorageDatabaseWriter {
  const database: StorageDatabase = requireStorageDatabase();
  const existing: StorageDatabaseWriter | undefined = storageDatabaseWriters.get(database);
  if (existing !== undefined) return existing;
  const writer: StorageDatabaseWriter = prepareStorageDatabaseWriter(database);
  storageDatabaseWriters.set(database, writer);
  return writer;
}

/** 任一共享 SQLite 业务表或 AI 上下文存在待提交最终值时返回 true。 */
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

/** 任一领域达到批次阈值时立即提交共享事务，否则注册定时提交（重放暂挂或退避期仅挂 timer）。 */
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

/** 取出领域的拒收标记并合并其 dirty 状态。 */
function takeStorageDomainFailure(domain: StorageDatabaseDomain, dirty: boolean): boolean {
  return rejectedStorageDomains.delete(domain) || dirty;
}

/** 收集指定领域或全部共享 SQLite 领域的落盘失败与拒收状态。 */
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

/** 判断指定领域的写缓冲是否仍有未提交项。 */
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

/** 丢弃群状态领域本轮全部待提交写入并归还其预算。 */
function discardPendingChatStateWrites(): void {
  pendingChatStateWrites.clear();
  storagePendingBudgets.chatState.reset();
}

/** 丢弃群问答领域本轮全部待提交写入并归还其条数与预算。 */
function discardPendingChatQaWrites(): void {
  pendingChatQaWrites.clear();
  pendingChatQaEntryCount.current = 0;
  storagePendingBudgets.chatQa.reset();
}

/**
 * 解除暂挂时复核一个领域的跨行聚合约束。不满足时丢弃该领域本轮待提交写入（非法聚合状态不落盘）、
 * 记领域拒收并返回 recoveryReplayFailed 回报；满足时返回 null。
 */
function rejectHeldDomainIfInvalid(
  domain: "chatState" | "chatQa",
  assertInvariants: () => void,
  discardPending: () => void
): RecoveryReplayFailedReply | null {
  try {
    assertInvariants();
    return null;
  } catch (error: unknown) {
    discardPending();
    rejectedStorageDomains.add(domain);
    console.error(`[diskIOWorker] rejected replayed ${domain} writes on storage flush hold release:`, error);
    return { type: "recoveryReplayFailed", domain, error: errorMessage(error) };
  }
}

/**
 * 设置或解除镜像重放暂挂状态。解除时先统一复核群状态与群问答聚合约束，复核失败的领域丢弃本轮
 * 待提交写入，其余领域再按紧急写或批次阈值触发提交。
 * @returns 首个复核失败的 recoveryReplayFailed 回报，由 Worker 入口投递给主线程按 fatal 停机；
 *   开启暂挂或复核全部通过时为 null。
 */
export function setStorageFlushHold(
  active: boolean,
  reply: IdentityPersistenceReply
): RecoveryReplayFailedReply | null {
  storageFlushHold.current = active;
  if (active) return null;
  const chatStateFailure: RecoveryReplayFailedReply | null = rejectHeldDomainIfInvalid(
    "chatState",
    assertPendingChatStateInvariants,
    discardPendingChatStateWrites
  );
  const chatQaFailure: RecoveryReplayFailedReply | null = rejectHeldDomainIfInvalid(
    "chatQa",
    assertPendingChatQaCapacity,
    discardPendingChatQaWrites
  );
  if (storageWriteRetry.failures === 0 && hasUrgentAiContextWrites()) {
    flushStorageDatabase(reply);
  } else {
    flushIfStorageFull(reply);
  }
  return chatStateFailure ?? chatQaFailure;
}
