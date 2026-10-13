/**
 * 黑名单群级处置 durable outbox 的主线程 owner。
 *
 * 本模块持有启动恢复、write-ahead、任务编号与裁剪，以及 Disk I/O Worker
 * 重建后的未 ACK 行重放；补扫的退避与回执状态机在 sweep.ts。
 *
 * 持久化按行进行（同黑白名单、临时免检、群状态与群问答的写协议）：每处改动只为被改动的那一行
 * 发一条 blocklistRemovalWrite（正文为该行当前值的 JSON，行已不在表里即 null 删除），带单调
 * revision；Disk I/O Worker 事务提交后按 (removalId, revision) 回精确 ACK。只改诊断字段的失败
 * 记账（sweepRetryState.ts 的 updatePendingRemovalFailure）先留在内存，由投递前的
 * persistPendingBlockedRemovals 补发。
 * 它不调用 Telegram API，执行 owner 通过单槽 holder 反向注册。
 * @see ../../../docs/cn/04-invariants.md
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

/** 一行当前最终值的写入消息：行在表里时编码当前值，不在即删除。 */
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

/**
 * 为一行发出当前最终值并登记未 ACK revision 与准入字节；正文带着当前诊断，这一行随即移出
 * unwrittenRemovalDiagnostics。投递被拒时登记为未投递，留给 write-ahead 补投与 Worker 重建重放。
 * @internal 供同目录 sweep owner 在改动任务诊断后调用。
 * @returns 本次投递是否被 Disk I/O 接收。
 */
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

/** 新一轮补扫完整取代同群旧批次，被取代的行逐行发出删除。 */
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

/** 恢复出的权限闩锁不重投；等确证权限恢复后以一条新补扫取代旧任务。 */
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

/**
 * 启动恢复：把 SQLite outbox 灌入主线程镜像。必须在 runner 开始投喂更新之前完成。
 */
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
    // 补扫不带名单，投递时按当前名单现算；名单为空时销账。
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
    // 冻结批次在这里不裁剪：启动期 inspectStorageDatabase（workers/diskIO/storageDatabase/
    // hydration.ts）经 validateStorageDatabase 的 assertPendingRemovalBlocklistReferences
    // （database/validation/storageRows.ts）对「冻结 userId 不在 blocklist_entries」抛错并拒绝启动；
    // 运行期的 handleBlocklistRemovalWrite（workers/diskIO/storageDatabase/pendingRemoval.ts）同样拒绝。
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
  // 被过滤的行逐行发出删除。
  let posted: boolean = true;
  for (const removalId of filtered) {
    if (!queueBlocklistRemovalWrite(removalId)) posted = false;
  }
  if (!posted) {
    logger.error("Failed to queue the filtered blocklist removal outbox after startup recovery.");
  }
}

/**
 * Anti-Raid 投递前的 write-ahead 边界：先为只改了内存诊断的行（unwrittenRemovalDiagnostics）逐行发出
 * 写入，再补投此前被 Disk I/O 拒收的行（同一 revision），最后等待 `blocklistRemovalOutbox` 领域
 * flush 完成；返回后 outbox 全部行的当前内容都已 durable。
 */
export async function persistPendingBlockedRemovals(): Promise<void> {
  // 投递被拒的行登记为未投递，由下面的补投循环处理。
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

/**
 * 把持久化任务补成可交给业务 Worker 的具体批次。补扫在这一刻读取当前黑名单，
 * 其它任务沿用登记时冻结的名单；空名单补扫返回 undefined。
 * @internal 供同目录 sweep owner 在 Worker 重建时重放。
 */
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

/**
 * 读取权威镜像仍持有的处置参数并返回副本，供 write-ahead flush 前后对账。
 */
export function getPendingBlockedRemovalParams(
  removalId: number,
  blockedIds: readonly number[]
): RemoveBlockedMembersParams | undefined {
  const pending: PendingBlockedRemoval | undefined = pendingBlockedRemovals.get(removalId);
  if (pending === undefined) return undefined;
  return materializeRemovalParams(pending.params, blockedIds);
}

/**
 * 放掉某个群补扫进度里属于该 removalId 的在途占位；只在任务已被权威销账时调用。
 * @internal outbox 裁剪路径专用。
 */
function releaseSweepClaim(chatId: number, removalId: number): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.removalId !== removalId) return;
  blocklistSweepState.set(chatId, { ...progress, removalId: null });
}

/**
 * 把某个 id 从冻结名单批次摘掉。补扫不冻结名单，只有权威名单被清空时才连同
 * 补扫任务一起销账；销账路径同步释放对应的 sweep claim。
 * @internal 由 membership.ts 的 unblockUser 调用（/block disable 与销号自动摘除）。
 */
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

/** 上层 owner 反向注册黑名单处置执行者；本 infra 模块不静态依赖 Anti-Raid。 */
export function registerBlockedMemberRemover(remover: BlockedMemberRemover): void {
  blockedMemberRemoverHolder.current = remover;
}

/**
 * 给一批处置编号并登记镜像，同时发出这一行的写入。补扫只存任务，其余批次冻结并去重具体名单。
 */
export function trackBlockedRemoval(
  input: TrackBlockedRemovalInput,
  blockedIds: readonly number[] = []
): RemoveBlockedMembersParams {
  if (pendingBlockedRemovals.size >= BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
    throw new Error(
      `Blocklist removal outbox reached its ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES}-entry capacity.`
    );
  }
  if (!Number.isSafeInteger(blocklistRemovalCounter.current + 1)) {
    throw new Error("Blocklist removal id space is exhausted.");
  }
  blocklistRemovalCounter.current++;
  const removalId: number = blocklistRemovalCounter.current;
  const stored: PendingBlockedRemovalParams = input.probeMembership
    ? { chatId: input.chatId, probeMembership: true, removalId }
    : { ...input, userIds: [...new Set(input.userIds)], removalId };
  pendingBlockedRemovals.set(removalId, {
    params: stored,
    createdAt: Date.now(),
    attempts: 0,
    lastFailure: null,
  });
  const tracked: RemoveBlockedMembersParams | undefined = materializeRemovalParams(stored, blockedIds);
  if (tracked === undefined) {
    pendingBlockedRemovals.delete(removalId);
    throw new Error("Blocklist removal has no target to enforce.");
  }
  // 新行立即发出；写入准入失败时同步撤销镜像条目，投递被拒时由 persistPendingBlockedRemovals 补投。
  try {
    queueBlocklistRemovalWrite(removalId);
  } catch (error: unknown) {
    pendingBlockedRemovals.delete(removalId);
    throw error;
  }
  return tracked;
}

/**
 * 群停止管理时删除其全部任务与 sweep 进度。主线程是这个取消边界的权威 owner，
 * durable 裁剪在这里完成。
 */
export function forgetChatBlocklistWork(chatId: number): void {
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
  blocklistSweepState.delete(chatId);
}

/** 精确 ACK 只清掉对应 revision；迟到的旧 ACK 不删更新的写。 */
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

// Disk I/O Worker 重建后按 revision 顺序只重放未 ACK 的行，正文从当前镜像现编码。
onDiskIORespawn("blocklist outbox", DISK_IO_RESPAWN_PRIORITIES.BLOCKLIST + 1, (
  transport: DiskIORecoveryTransport
): boolean => {
  const writes: (readonly [number, UnacknowledgedRemovalWrite])[] = [...unacknowledgedRemovalWrites];
  writes.sort((
    left: readonly [number, UnacknowledgedRemovalWrite],
    right: readonly [number, UnacknowledgedRemovalWrite]
  ): number => left[1].revision - right[1].revision);
  for (const [removalId, write] of writes) {
    if (!transport.post(removalWriteMessage(removalId, write.revision))) return false;
    unacknowledgedRemovalWrites.set(removalId, { revision: write.revision, posted: true, bytes: write.bytes });
  }
  return true;
});
