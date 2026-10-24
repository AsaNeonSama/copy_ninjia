/**
 * 镜像重放暂挂的开合，以及解除暂挂时对群状态、群问答聚合约束的复核。
 * 所属线程：Disk I/O Worker；本模块不持有缓存。
 */

import {
  pendingChatQaEntryCount,
  pendingChatQaWrites,
  pendingChatStateWrites,
  rejectedStorageDomains,
  storageFlushHold,
  storagePendingBudgets,
  storageWriteRetry,
} from "../../../cache/workers/diskIO/storageDatabase";
import { errorMessage } from "../../../libs/errorMessage";
import type {
  IdentityPersistenceReply,
  RecoveryReplayFailedReply,
} from "../../../types/diskIO/replies";
import { hasUrgentAiContextWrites } from "./aiContext";
import { assertPendingChatQaCapacity } from "./chatQa";
import { assertPendingChatStateInvariants } from "./chatState";
import { flushIfStorageFull, flushStorageDatabase } from "./flush";

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
 * @param domain 待复核的共享 SQLite 子领域（`chatState` 或 `chatQa`）。
 * @param assertInvariants 校验该领域跨行聚合约束的函数。
 * @param discardPending 复核失败时清空该领域待提交写入与预算的回调。
 * @returns 复核失败时返回 `recoveryReplayFailed` 回执，复核通过时返回 null。
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
 * @param active 为 true 时开启暂挂，为 false 时解除暂挂并复核提交。
 * @param reply 向主线程发送持久化回执的出口。
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
