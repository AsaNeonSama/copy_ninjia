/**
 * 黑名单群级处置 durable outbox 的主线程管理：启动恢复、write-ahead、任务编号与裁剪，
 * 以及 Disk I/O Worker 重建后的未确认行重放，参见 docs/cn/04-invariants.md。
 */

import {
  blockedMemberRemoverHolder,
  blocklistRemovalCounter,
  blocklistSweepPages,
  blocklistSweepState,
  pendingBlockedRemovals,
  unwrittenRemovalDiagnostics,
} from "../../cache/main/blocklist";
import {
  removalWriteRevision,
  unacknowledgedRemovalBytes,
  unacknowledgedRemovalWrites,
} from "../../cache/main/identityStorage";
import { BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES } from "../../consts/antiRaid/blocklist";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { encodePendingBlockedRemovalData } from "../../database/codec/identity";
import {
  flushDiskIODomain,
  onDiskIORespawn,
  onDiskIOReply,
  postDiskIO,
} from "../diskIO";
import { assertStorageAdmission } from "../diskIO/storageAdmission";
import { logger } from "../logger";
import { getChatStateCache } from "../storage/stateStore";
import { hasAnyBlockedIdentity } from "../identityStorage";
import { storageWriteCost } from "../../libs/storageWriteBudget";
import { isManagedAdminChat } from "./sweepEligibility";
import type {
  BlockedMemberRemover,
  PendingBlockedRemoval,
  PendingBlockedRemovalParams,
  RemoveBlockedMembersParams,
  TrackBlockedRemovalInput,
  BlocklistSweepRecord,
} from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";
import type {
  BlocklistRemovalWriteDiskMessage,
  DiskIORecoveryTransport,
} from "../../types/diskIO/messages";
import type {
  IdentityStoragePersistedReply,
} from "../../types/diskIO/replies";
import type { UnacknowledgedRemovalWrite } from "../../types/identityStorage";
import type { FlushResult } from "../../types/lifecycle";

/** 构造单行待踢任务的写入或删除消息。 */
function removalWriteMessage(removalId: number, revision: number): BlocklistRemovalWriteDiskMessage {
  const pending: PendingBlockedRemoval | undefined = pendingBlockedRemovals.get(removalId);
  return {
    type: "blocklistRemovalWrite",
    removalId,
    data: pending === undefined
      ? null
      : encodePendingBlockedRemovalData(pending, `pending blocked removal ${removalId}`).text,
    revision,
  };
}

/** 分配新 revision 并向 Disk I/O Worker 投递单行待踢任务当前最终值，登记未确认状态。 */
export function queueBlocklistRemovalWrite(removalId: number): boolean {
  const nextRevision: number = removalWriteRevision.current + 1;
  if (!Number.isSafeInteger(nextRevision)) {
    throw new Error("Pending removal revision space is exhausted.");
  }
  const message: BlocklistRemovalWriteDiskMessage = removalWriteMessage(removalId, nextRevision);
  const previous: UnacknowledgedRemovalWrite | undefined = unacknowledgedRemovalWrites.get(removalId);
  const cost: number = storageWriteCost(message.data);
  const bytes: number = unacknowledgedRemovalBytes.current + cost - (previous?.bytes ?? 0);
  assertStorageAdmission(unacknowledgedRemovalWrites.size + (previous === undefined ? 1 : 0), bytes);
  removalWriteRevision.current = nextRevision;
  unwrittenRemovalDiagnostics.delete(removalId);
  const posted: boolean = postDiskIO(message);
  unacknowledgedRemovalWrites.set(removalId, { revision: nextRevision, posted, bytes: cost });
  unacknowledgedRemovalBytes.current = bytes;
  return posted;
}

/** 删除指定群除 exceptRemovalId 外的旧补扫任务并投递删除消息。 */
export function forgetSupersededChatSweepBatches(
  chatId: number,
  exceptRemovalId?: number
): void {
  let posted: boolean = true;
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (
      pending.params.chatId === chatId &&
      pending.params.probeMembership &&
      removalId !== exceptRemovalId
    ) {
      pendingBlockedRemovals.delete(removalId);
      blocklistSweepPages.delete(removalId);
      if (!queueBlocklistRemovalWrite(removalId)) posted = false;
    }
  }
  if (!posted) {
    logger.error(
      `Failed to queue superseded blocklist sweep cleanup for chat ${chatId}.`
    );
  }
}

/** 恢复因缺少权限暂停的群补扫闩锁状态。 */
function restorePermissionBlockedSweep(
  chatId: number,
  pending: PendingBlockedRemoval
): void {
  const current: BlocklistSweepRecord | undefined =
    blocklistSweepState.get(chatId);
  blocklistSweepState.set(chatId, {
    removalId: null,
    sweptAt: null,
    nextRetryAt: Math.min(
      current?.nextRetryAt ?? pending.createdAt,
      pending.createdAt
    ),
    resweepRequested: false,
    failedSweeps: Math.max(
      current?.failedSweeps ?? 0,
      pending.attempts
    ),
    permissionBlocked: true,
  });
}

/** 启动恢复：将 SQLite 待踢任务恢复到主线程镜像并清理已失效任务。 */
export function hydrateBlocklist(
  recoveredRemovals: Map<number, PendingBlockedRemoval>
): void {
  pendingBlockedRemovals.clear();
  unwrittenRemovalDiagnostics.clear();
  blocklistSweepState.clear();
  blocklistSweepPages.clear();
  blocklistRemovalCounter.current = 0;
  const filtered: number[] = [];
  for (const [removalId, pending] of recoveredRemovals) {
    blocklistRemovalCounter.current = Math.max(blocklistRemovalCounter.current, removalId);
    const state: ChatState | undefined = getChatStateCache().get(pending.params.chatId);
    if (!isManagedAdminChat(state)) {
      filtered.push(removalId);
      continue;
    }
    if (pending.params.probeMembership) {
      if (!hasAnyBlockedIdentity()) {
        filtered.push(removalId);
        continue;
      }
      pendingBlockedRemovals.set(removalId, { ...pending });
      if (pending.lastFailure === "missing-permission") {
        restorePermissionBlockedSweep(pending.params.chatId, pending);
      } else if (
        blocklistSweepState.get(pending.params.chatId)?.permissionBlocked !== true
      ) {
        blocklistSweepState.set(pending.params.chatId, {
          removalId,
          sweptAt: null,
          nextRetryAt: pending.createdAt,
          resweepRequested: false,
          failedSweeps: pending.attempts,
          permissionBlocked: false,
        });
      }
      continue;
    }
    const userIds: number[] = [...pending.params.userIds];
    pendingBlockedRemovals.set(removalId, {
      params: { ...pending.params, userIds },
      createdAt: pending.createdAt,
      attempts: pending.attempts,
      lastFailure: pending.lastFailure,
    });
    if (pending.lastFailure === "missing-permission") {
      restorePermissionBlockedSweep(pending.params.chatId, pending);
    }
  }
  let posted: boolean = true;
  for (const removalId of filtered) {
    if (!queueBlocklistRemovalWrite(removalId)) posted = false;
  }
  if (!posted) {
    logger.error("Failed to queue the filtered blocklist removal outbox after startup recovery.");
  }
}

/** 补发未写出的任务诊断与未投递行，并等待 blocklistRemovalOutbox 领域落盘完成。 */
export async function persistPendingBlockedRemovals(): Promise<void> {
  for (const removalId of unwrittenRemovalDiagnostics) queueBlocklistRemovalWrite(removalId);
  for (const [removalId, write] of unacknowledgedRemovalWrites) {
    if (write.posted) continue;
    if (!postDiskIO(removalWriteMessage(removalId, write.revision))) {
      throw new Error("Persistence Worker rejected a blocklist removal outbox write.");
    }
    unacknowledgedRemovalWrites.set(removalId, { revision: write.revision, posted: true, bytes: write.bytes });
  }
  const result: FlushResult = (await flushDiskIODomain("blocklistRemovalOutbox")).result;
  if (result !== "flushed") {
    throw new Error(`Blocklist removal outbox flush ${result}.`);
  }
}

/** 将持久化待踢参数具体化为发往 Anti-Raid Worker 的批次参数；补扫任务为空名单时返回 undefined。 */
export function materializeRemovalParams(
  params: PendingBlockedRemovalParams,
  blockedIds: readonly number[] = []
): RemoveBlockedMembersParams | undefined {
  if (!params.probeMembership) {
    return { ...params, userIds: [...params.userIds] };
  }
  if (blockedIds.length === 0) return undefined;
  return {
    chatId: params.chatId,
    probeMembership: true,
    removalId: params.removalId,
    userIds: [...blockedIds],
  };
}

/** 读取指定 removalId 仍在主线程镜像中的处置参数副本。 */
export function getPendingBlockedRemovalParams(
  removalId: number,
  blockedIds: readonly number[]
): RemoveBlockedMembersParams | undefined {
  const pending: PendingBlockedRemoval | undefined = pendingBlockedRemovals.get(removalId);
  if (pending === undefined) return undefined;
  return materializeRemovalParams(pending.params, blockedIds);
}

/** 释放指定群补扫进度中属于 removalId 的在途占位。 */
function releaseSweepClaim(chatId: number, removalId: number): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.removalId !== removalId) return;
  blocklistSweepState.set(chatId, { ...progress, removalId: null });
}

/** 从待踢 outbox 批次中移除已解封身份；黑名单清空时一并清理补扫任务。 */
export function forgetUserBlocklistRemovals(userId: number): void {
  let posted: boolean = true;
  const blocklistEmptied: boolean = !hasAnyBlockedIdentity();
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (pending.params.probeMembership) {
      if (!blocklistEmptied) continue;
      pendingBlockedRemovals.delete(removalId);
      blocklistSweepPages.delete(removalId);
      releaseSweepClaim(pending.params.chatId, removalId);
      if (!queueBlocklistRemovalWrite(removalId)) posted = false;
      continue;
    }
    if (!pending.params.userIds.includes(userId)) continue;
    const remaining: number[] = pending.params.userIds.filter((id: number): boolean => id !== userId);
    if (remaining.length === 0) {
      pendingBlockedRemovals.delete(removalId);
      blocklistSweepPages.delete(removalId);
      releaseSweepClaim(pending.params.chatId, removalId);
    } else {
      pendingBlockedRemovals.set(removalId, {
        ...pending,
        params: { ...pending.params, userIds: remaining },
      });
    }
    if (!queueBlocklistRemovalWrite(removalId)) posted = false;
  }
  if (!posted) {
    logger.error(`Failed to queue blocklist removal outbox cleanup for unblocked user ${userId}.`);
  }
}

/** 注册黑名单处置执行回调。 */
export function registerBlockedMemberRemover(remover: BlockedMemberRemover): void {
  blockedMemberRemoverHolder.current = remover;
}

/** 为一批待踢处置分配 removalId、登记镜像并投递落盘写入。 */
export function trackBlockedRemoval(
  input: TrackBlockedRemovalInput,
  blockedIds: readonly number[] = []
): RemoveBlockedMembersParams {
  if (pendingBlockedRemovals.size >= BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
    throw new Error(
      `Blocklist removal outbox reached its ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES}-entry capacity.`
    );
  }
  const removalId: number = blocklistRemovalCounter.current + 1;
  if (!Number.isSafeInteger(removalId)) {
    throw new Error("Blocklist removal id space is exhausted.");
  }
  const stored: PendingBlockedRemovalParams = input.probeMembership
    ? { chatId: input.chatId, probeMembership: true, removalId }
    : { ...input, userIds: [...new Set(input.userIds)], removalId };
  const tracked: RemoveBlockedMembersParams | undefined = materializeRemovalParams(stored, blockedIds);
  if (tracked === undefined) {
    throw new Error("Blocklist removal has no target to enforce.");
  }
  pendingBlockedRemovals.set(removalId, {
    params: stored,
    createdAt: Date.now(),
    attempts: 0,
    lastFailure: null,
  });
  try {
    queueBlocklistRemovalWrite(removalId);
  } catch (error: unknown) {
    pendingBlockedRemovals.delete(removalId);
    throw error;
  }
  blocklistRemovalCounter.current = removalId;
  return tracked;
}

/** 清理已停止管理群的全部待踢任务与补扫状态。 */
export function forgetChatBlocklistWork(chatId: number): void {
  blocklistSweepState.delete(chatId);
  let posted: boolean = true;
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (pending.params.chatId !== chatId) continue;
    pendingBlockedRemovals.delete(removalId);
    blocklistSweepPages.delete(removalId);
    if (!queueBlocklistRemovalWrite(removalId)) posted = false;
  }
  if (!posted) {
    logger.error(`Failed to queue blocklist removal outbox cleanup for unmanaged chat ${chatId}.`);
  }
}

/** 根据 SQLite 持久化回执按 revision 清理未确认待踢写入记录。 */
function settleRemovalWrites(reply: IdentityStoragePersistedReply): void {
  for (const persisted of reply.removalWrites) {
    const current: UnacknowledgedRemovalWrite | undefined = unacknowledgedRemovalWrites.get(persisted.removalId);
    if (current?.revision === persisted.revision) {
      unacknowledgedRemovalWrites.delete(persisted.removalId);
      unacknowledgedRemovalBytes.current -= current.bytes;
    }
  }
}

onDiskIOReply("identityStoragePersisted", settleRemovalWrites);

onDiskIORespawn("blocklist outbox", DISK_IO_RESPAWN_PRIORITIES.BLOCKLIST + 1, (
  transport: DiskIORecoveryTransport
): boolean => {
  const writes: (readonly [number, UnacknowledgedRemovalWrite])[] = [...unacknowledgedRemovalWrites];
  writes.sort((
    left: readonly [number, UnacknowledgedRemovalWrite],
    right: readonly [number, UnacknowledgedRemovalWrite]
  ): number => left[1].revision - right[1].revision);
  for (const [removalId, write] of writes) {
    const message: BlocklistRemovalWriteDiskMessage = removalWriteMessage(removalId, write.revision);
    if (!transport.post(message)) return false;
    const cost: number = storageWriteCost(message.data);
    unacknowledgedRemovalBytes.current += cost - write.bytes;
    unwrittenRemovalDiagnostics.delete(removalId);
    unacknowledgedRemovalWrites.set(removalId, { revision: write.revision, posted: true, bytes: cost });
  }
  return true;
});
