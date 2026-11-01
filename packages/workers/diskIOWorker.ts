/**
 * Disk I/O Worker 入口与消息路由：串行执行日志、AI 记忆、贴纸目录、每日运势、回执密钥、
 * 入群验证按日增量、共享 SQLite、入群日志、wed 成员快照、广告样本与 AI 用量统计的磁盘读写。
 * 跨模块约束见 docs/cn/04-invariants.md。
 */

import { handleAdSampleMessage } from "./diskIO/adSampleFile";
import {
  closeStorageDatabaseForShutdown,
  handleChatQaWrite,
  handleChatStateWrite,
  handleIdentityPolicyWrite,
  handleTemporaryAdBypassWrite,
  handleBlocklistRemovalWrite,
  readBlocklistIdPage,
  readIdentityPolicies,
  readWhitelistIdPage,
  setStorageFlushHold,
} from "./diskIO/storageDatabase";
import { flushLogBuffer, handleLogMessage } from "./diskIO/logFiles";
import { handleAiCacheUsageMessage } from "./diskIO/aiCacheFile";
import {
  flushLuckAppends,
  handleLuckDrawMessage,
  replayDeferredLuckDraws,
  switchLuckDay,
} from "./diskIO/luckFiles";
import { recoverLuckReceiptSecret } from "./diskIO/luckSecretFile";
import {
  handleJoinLogDeleteMessage,
  handleJoinLogMessage,
  readJoinLog,
} from "./diskIO/joinLogFiles";
import {
  handleVerificationDelete,
  handleVerificationUpsert,
  withVerificationBatchFlush,
} from "./diskIO/verificationWrites";
import {
  deleteAiMemorySnapshot,
  markAiMemorySnapshotDirty,
} from "./diskIO/aiMemoryStorage";
import {
  markStickerCatalogSnapshotDirty,
} from "./diskIO/stickerCatalogFiles";
import { handleDiskIOStartupLoad } from "./diskIO/startup";
import {
  handleWedMembersDeleteMessage,
  handleWedMembersMessage,
} from "./diskIO/wedMemberFiles";
import { LOG_REOPEN_RETRY_MS } from "../consts/diskIO/appendOnly";
import { DISK_BUSINESS_BATCH_MAX_MESSAGES } from "../consts/diskIO/business";
import {
  aiMemoryDeletePersistedNotifier,
  aiMemoryPersistedNotifier,
  forgetAiMemoryChat,
} from "../cache/workers/diskIO/snapshots";
import { luckAppendStalledNotifier, luckWorkerCache } from "../cache/workers/diskIO/luck";
import {
  noteVerificationWriteRejected,
} from "../cache/workers/diskIO/verification";
import { joinLogPersistedNotifier } from "../cache/workers/diskIO/joinLog";
import {
  rejectedStorageDomains,
  storageDatabaseClosed,
  storagePersistenceReplyHolder,
  storageWriteFatalReply,
} from "../cache/workers/diskIO/storageDatabase";
import { StorageWriteCapacityError } from "../libs/storageWriteBudget";
import { diskIOReplayWindow } from "../cache/workers/diskIO/recovery";
import type {
  CloseStorageRequest,
  DiskDiagnosticBatchRequest,
  DiskIOMessage,
  EnsureLuckSecretRequest,
  LuckDrawDiskMessage,
  ReadJoinLogRequest,
} from "../types/diskIO/messages";
import type {
  DiskFlushFailedReply,
  DiskFlushReply,
  DiskDiagnosticBatchAcceptedReply,
  DiskDiagnosticBatchRetryReply,
  DiskIODomain,
  DiskIOReply,
  JoinLogReadReply,
  LuckSecretReply,
  RecoveryReplayFailedReply,
  StorageClosedReply,
  StorageDatabaseDomain,
} from "../types/diskIO/replies";
import type {
  JoinLogRecord,
} from "../types/diskIO/storage";
import { enqueueDiskIOOperation } from "./diskIO/operationQueue";
import { flushScope } from "./diskIO/domainFlush";
import { wedMemberDeletePersistedNotifier } from "../cache/workers/diskIO/wed";
import { stickerCatalogPersistedNotifier } from "../cache/workers/diskIO/stickers";
import { errorMessage } from "../libs/errorMessage";
import { adoptTimeZone } from "../config/time";

declare const self: Worker;

/**
 * 向主线程发送 Worker 回执。
 * @param reply 待投递给主线程的 Disk I/O 回执消息。
 */
function postReply(reply: DiskIOReply): void {
  self.postMessage(reply);
}

/**
 * 处理诊断批次：先缓冲并落盘日志（失败时发回执退避重试），再依次处理广告样本与 AI 缓存用量并回执。
 * @param msg 主线程发来的诊断消息批次请求。
 */
async function handleDiagnosticBatch(msg: DiskDiagnosticBatchRequest): Promise<void> {
  let containsLog: boolean = false;
  for (const diagnostic of msg.messages) {
    if (diagnostic.type !== "log") continue;
    handleLogMessage(diagnostic);
    containsLog = true;
  }
  if (containsLog && !await flushLogBuffer()) {
    const retry: DiskDiagnosticBatchRetryReply = {
      type: "diagnosticBatchRetry",
      batchId: msg.batchId,
      retryAfterMs: LOG_REOPEN_RETRY_MS,
    };
    postReply(retry);
    return;
  }
  for (const diagnostic of msg.messages) {
    if (diagnostic.type === "adSample") await handleAdSampleMessage(diagnostic);
  }
  for (const diagnostic of msg.messages) {
    if (diagnostic.type !== "aiCacheUsage") continue;
    try {
      await handleAiCacheUsageMessage(diagnostic);
    } catch (error: unknown) {
      console.error("[diskIOWorker] failed to buffer AI cache usage:", error);
    }
  }
  const reply: DiskDiagnosticBatchAcceptedReply = {
    type: "diagnosticBatchAccepted",
    batchId: msg.batchId,
  };
  postReply(reply);
}

/**
 * 按请求日期恢复或轮换运势回执密钥；跨日时先刷旧日缓冲并切换日期缓存，回执后重放滞留抽签。
 * @param msg 确保指定日期运势回执密钥就绪的请求。
 */
async function handleEnsureLuckSecret(msg: EnsureLuckSecretRequest): Promise<void> {
  let reply: LuckSecretReply;
  let deferredDraws: LuckDrawDiskMessage[] | null = null;
  try {
    const currentLuckDay: string | undefined = luckWorkerCache.current?.day;
    if (currentLuckDay !== undefined && msg.day < currentLuckDay) {
      throw new Error(
        `Refusing to move luck persistence backward from ${currentLuckDay} to ${msg.day}.`
      );
    }
    if (currentLuckDay !== msg.day) {
      if (!await flushLuckAppends()) {
        throw new Error(`Failed to flush luck results before switching from ${currentLuckDay ?? "none"} to ${msg.day}.`);
      }
      deferredDraws = await switchLuckDay(msg.day, true);
    }
    reply = {
      type: "luckSecret",
      requestId: msg.requestId,
      secret: await recoverLuckReceiptSecret({
        day: msg.day,
        confirmedResultCount: luckWorkerCache.current?.entries.size ?? 0,
      }),
    };
  } catch (error: unknown) {
    reply = {
      type: "luckSecret",
      requestId: msg.requestId,
      error: errorMessage(error),
    };
  }
  postReply(reply);
  await replayDeferredLuckDraws(deferredDraws);
}

/**
 * 读取入群日志窗口并回执结果或错误。
 * @param msg 入群日志时间窗口读取请求。
 */
async function handleReadJoinLog(msg: ReadJoinLogRequest): Promise<void> {
  let reply: JoinLogReadReply;
  try {
    const records: readonly JoinLogRecord[] = await readJoinLog(msg);
    reply = {
      type: "joinLogRead",
      requestId: msg.requestId,
      records,
    };
  } catch (error: unknown) {
    reply = {
      type: "joinLogRead",
      requestId: msg.requestId,
      error: errorMessage(error),
    };
  }
  postReply(reply);
}

/**
 * 执行停机前的共享数据库刷盘、WAL checkpoint 与关库并回执。
 * @param msg 停机关库请求。
 */
function handleCloseStorage(msg: CloseStorageRequest): void {
  let reply: StorageClosedReply;
  try {
    reply = {
      type: "storageClosed",
      requestId: msg.requestId,
      outcome: closeStorageDatabaseForShutdown(postReply),
    };
  } catch (error: unknown) {
    reply = {
      type: "storageClosed",
      requestId: msg.requestId,
      error: errorMessage(error),
    };
  }
  postReply(reply);
}

/**
 * 按消息类型分发并处理单条主线程请求。
 * @param msg 主线程发往 Disk I/O Worker 的请求消息。
 */
export async function handleDiskIOWorkerMessage(
  msg: DiskIOMessage
): Promise<void> {
  switch (msg.type) {
    case "operationBatch":
      if (!Number.isSafeInteger(msg.batchId) || msg.batchId < 1 ||
        msg.messages.length < 1 || msg.messages.length > DISK_BUSINESS_BATCH_MAX_MESSAGES) {
        throw new Error("Invalid Disk I/O operation batch.");
      }
      await withVerificationBatchFlush(postReply, async (): Promise<void> => {
        for (const message of msg.messages) await handleDiskIOWorkerMessage(message);
      });
      postReply({ type: "operationBatchAccepted", batchId: msg.batchId });
      break;
    case "diagnosticBatch":
      await handleDiagnosticBatch(msg);
      break;
    case "aiMemory":
      markAiMemorySnapshotDirty({
        chatId: msg.chatId,
        revision: msg.revision,
        snapshot: msg.snapshot,
        persistImmediately: msg.persistImmediately === true,
      });
      break;
    case "deleteAiMemory":
      deleteAiMemorySnapshot(msg.chatId, msg.revision);
      break;
    case "forgetAiMemory":
      forgetAiMemoryChat(msg.chatId);
      break;
    case "stickerCatalog":
      markStickerCatalogSnapshotDirty(msg.pack, msg.snapshot, msg.revision);
      break;
    case "wedMembers":
      handleWedMembersMessage(msg);
      break;
    case "deleteWedMembers":
      handleWedMembersDeleteMessage(msg);
      break;
    case "luckDraw":
      await handleLuckDrawMessage(msg);
      break;
    case "ensureLuckSecret":
      await handleEnsureLuckSecret(msg);
      break;
    case "verificationUpsert":
      await handleVerificationMessage(
        (): Promise<void> => handleVerificationUpsert({ msg, reply: postReply })
      );
      break;
    case "verificationDelete":
      await handleVerificationMessage(
        (): Promise<void> => handleVerificationDelete({ msg, reply: postReply })
      );
      break;
    case "blocklistRemovalWrite":
      handleIdentityMessage(
        "blocklistRemovalOutbox",
        (): void => handleBlocklistRemovalWrite(msg, postReply)
      );
      break;
    case "identityPolicyWrite":
      handleIdentityMessage(
        msg.table,
        (): void => handleIdentityPolicyWrite(msg, postReply)
      );
      break;
    case "temporaryAdBypassWrite":
      handleIdentityMessage(
        "temporaryAdBypass",
        (): void => handleTemporaryAdBypassWrite(msg, postReply)
      );
      break;
    case "chatStateWrite":
      handleIdentityMessage(
        "chatState",
        (): void => handleChatStateWrite(msg, postReply)
      );
      break;
    case "chatQaWrite":
      handleIdentityMessage(
        "chatQa",
        (): void => handleChatQaWrite(msg, postReply)
      );
      break;
    case "recoveryReplay":
      diskIOReplayWindow.current = msg.active;
      break;
    case "storageFlushHold": {
      const failure: RecoveryReplayFailedReply | null = setStorageFlushHold(msg.active, postReply);
      if (failure !== null) postReply(failure);
      break;
    }
    case "joinLog":
      await handleJoinLogMessage(msg);
      break;
    case "deleteJoinLog":
      handleJoinLogDeleteMessage(msg);
      break;
    case "readJoinLog":
      await handleReadJoinLog(msg);
      break;
    case "readIdentityPolicies":
      postReply(readIdentityPolicies(msg));
      break;
    case "readBlocklistIdPage":
      postReply(readBlocklistIdPage(msg));
      break;
    case "readWhitelistIdPage":
      postReply(readWhitelistIdPage(msg));
      break;
    case "closeStorage":
      handleCloseStorage(msg);
      break;
    case "load":
      adoptTimeZone(msg.timeZone);
      await handleDiskIOStartupLoad(msg.stickerPacks, postReply);
      break;
    case "flush": {
      const failedDomains: readonly DiskIODomain[] = await flushScope(msg.scope, postReply);
      const reply: DiskFlushReply | DiskFlushFailedReply = failedDomains.length === 0
        ? { type: "flushed", flushedId: msg.flushId }
        : { type: "flushFailed", flushedId: msg.flushId, failedDomains };
      postReply(reply);
      break;
    }
    default: {
      const unhandled: never = msg;
      void unhandled;
      break;
    }
  }
}

/**
 * 将一条主线程消息排入统一串行操作队列。
 * @param message 待串行处理的 Disk I/O 消息。
 * @returns 当前消息处理结算后的 Promise。
 */
export function queueDiskIOWorkerMessage(message: DiskIOMessage): Promise<void> {
  return enqueueDiskIOOperation((): Promise<void> => handleDiskIOWorkerMessage(message));
}

/**
 * 执行入群验证写操作；抛错时记录 verification 领域拒收并在重放窗口内回报失败。
 * @param apply 具体的入群验证写入或删除闭包。
 */
async function handleVerificationMessage(apply: () => Promise<void>): Promise<void> {
  try {
    await apply();
  } catch (error: unknown) {
    noteVerificationWriteRejected();
    console.error("[diskIOWorker] rejected a verification message:", error);
    replyReplayFailureIfActive("verification", error);
  }
}

/**
 * 重放窗口处于激活态时，将写入拒收回报为 recoveryReplayFailed。
 * @param domain 发生重放写入拒收的持久化领域。
 * @param error 捕获到的异常对象。
 */
function replyReplayFailureIfActive(domain: RecoveryReplayFailedReply["domain"], error: unknown): void {
  if (!diskIOReplayWindow.current) return;
  const reply: RecoveryReplayFailedReply = {
    type: "recoveryReplayFailed",
    domain,
    error: errorMessage(error),
  };
  postReply(reply);
}

/**
 * 执行共享 SQLite 领域写操作；关库后忽略，抛错时记录领域拒收、容量告警与重放失败。
 * @param domain 目标共享 SQLite 子领域名称。
 * @param apply 具体的领域写库闭包。
 */
function handleIdentityMessage(
  domain: Exclude<StorageDatabaseDomain, "aiMemory">,
  apply: () => void
): void {
  if (storageDatabaseClosed.current) return;
  try {
    apply();
  } catch (error: unknown) {
    rejectedStorageDomains.add(domain);
    if (error instanceof StorageWriteCapacityError) postReply({ type: "storageWriteStalled" });
    console.error(`[diskIOWorker] rejected an identity ${domain} message:`, error);
    replyReplayFailureIfActive(domain, error);
  }
}

/** 初始化各领域的回执出口并绑定 Worker 消息监听器。 */
function startDiskIOWorker(): void {
  wedMemberDeletePersistedNotifier.current = postReply;
  stickerCatalogPersistedNotifier.current = postReply;
  joinLogPersistedNotifier.current = postReply;
  storageWriteFatalReply.current = (): void => postReply({ type: "storageWriteStalled" });
  storagePersistenceReplyHolder.current = postReply;
  aiMemoryDeletePersistedNotifier.current = postReply;
  aiMemoryPersistedNotifier.current = postReply;
  luckAppendStalledNotifier.current = postReply;
  self.onmessage = (event: MessageEvent<DiskIOMessage>): void => {
    void queueDiskIOWorkerMessage(event.data);
  };
}

if (!Bun.isMainThread) startDiskIOWorker();
