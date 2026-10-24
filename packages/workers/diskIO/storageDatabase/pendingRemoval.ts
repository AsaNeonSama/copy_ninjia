import type { PendingRemovalWrite, RemovalRowTargets } from "../../../types/identityStorage";
import { BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES } from "../../../consts/antiRaid/blocklist";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import {
  pendingRemovalWrites,
  removalRowTargets,
  storagePendingBudgets,
} from "../../../cache/workers/diskIO/storageDatabase";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
import { decodePendingBlockedRemovalData } from "../../../database/codec/identity";
import type { PendingBlockedRemoval } from "../../../types/blocklist";
import type { BlocklistRemovalWriteDiskMessage } from "../../../types/diskIO/messages";
import type { IdentityPersistenceReply } from "../../../types/diskIO/replies";
import { assertPositiveRevision, storageSource } from "./context";
import { flushIfStorageFull } from "./flush";
import {
  hasAnyEffectiveBlocklistIdentity,
  hasEffectiveBlocklistIdentity,
} from "./identityPolicy";

/**
 * 解码待踢任务行并校验 removalId 一致性与黑名单引用有效性。
 * @param removalId 待踢任务行主键
 * @param data 序列化的待踢任务载荷
 * @param source 错误定位上下文标识
 * @returns 校验通过的目标集合摘要
 */
function acceptedRemovalTargets(removalId: number, data: string, source: string): RemovalRowTargets {
  const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(data, source);
  if (pending.params.removalId !== removalId) {
    throw new Error(`Pending removal row ${removalId} does not match params.removalId.`);
  }
  if (pending.params.probeMembership) {
    if (!hasAnyEffectiveBlocklistIdentity()) {
      throw new Error(
        `Pending removal row ${removalId} requires at least one effective blocklist entry.`
      );
    }
    return { probeMembership: true, userIds: [] };
  }
  if (pending.params.userIds.some(
    (id: number): boolean => !hasEffectiveBlocklistIdentity(id)
  )) {
    throw new Error(
      `Pending removal row ${removalId} contains an identity absent from the effective blocklist.`
    );
  }
  return { probeMembership: false, userIds: pending.params.userIds };
}

/**
 * 校验并接收待踢 outbox 写入或删除，同步更新 removalRowTargets 并排入事务缓冲。
 * @param message 待踢任务写入或删除消息
 * @param reply 持久化回执发送回调
 */
export function handleBlocklistRemovalWrite(
  message: BlocklistRemovalWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  const source: string = storageSource("pending_blocked_removals", message.removalId);
  if (!Number.isSafeInteger(message.removalId) || message.removalId < 1) {
    throw new Error(`${source}: removal_id must be a positive safe integer.`);
  }
  assertPositiveRevision(message.revision, source);
  const current: PendingRemovalWrite | undefined = pendingRemovalWrites.get(message.removalId);
  if (current !== undefined && current.revision >= message.revision) return;
  const targets: RemovalRowTargets | null = message.data === null
    ? null
    : acceptedRemovalTargets(message.removalId, message.data, source);
  if (
    targets !== null &&
    !removalRowTargets.has(message.removalId) &&
    removalRowTargets.size >= BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES
  ) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}:pending_blocked_removals: ` +
      `expected at most ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} rows.`
    );
  }
  storagePendingBudgets.blocklistRemovalOutbox.reserve(
    current === undefined ? 1 : 0,
    storageWriteCost(message.data) - (current === undefined ? 0 : storageWriteCost(current.data))
  );
  pendingRemovalWrites.set(message.removalId, { data: message.data, revision: message.revision });
  if (targets === null) removalRowTargets.delete(message.removalId);
  else removalRowTargets.set(message.removalId, targets);
  flushIfStorageFull(reply);
}
