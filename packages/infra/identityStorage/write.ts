import * as diskIO from "../diskIO";
import { assertStorageAdmission } from "../diskIO/storageAdmission";
import { canQueueDiskIOBusiness } from "../diskIO/transport";
import { describeFlushFailure } from "../diskIO/businessWrite";
import { storageWriteCost } from "../../libs/storageWriteBudget";
import {
  identityEntryCounts,
  identityPolicyCache,
  identityWriteRevision,
  unacknowledgedBlocklistWrites,
  unacknowledgedIdentityWrites,
  unacknowledgedIdentityBytes,
  unacknowledgedWhitelistWrites,
} from "../../cache/main/identityStorage";
import { DISK_IO_RESPAWN_PRIORITIES } from
  "../../consts/diskIO/common";
import {
  assertTelegramIdentityId,
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../database/codec/identity";
import { logger } from "../logger";
import type {
  DiskIORecoveryTransport,
  IdentityPolicyWriteDiskMessage,
} from "../../types/diskIO/messages";
import type {
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../../types/diskIO/replies";
import type {
  BlocklistEntryData,
  IdentityPolicyTable,
  WhitelistEntryData,
} from "../../types/identityPolicy";
import type {
  IdentityPolicyCacheEntry,
  UnacknowledgedIdentityWrite,
} from "../../types/identityStorage";

interface QueuedIdentityWrite {
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly change: UnacknowledgedIdentityWrite;
}

/**
 * 校验并发布一次身份策略最终值：容量准入后写合并身份缓存的该表字段（并刷新条目热度）与表计数，
 * 登记未 ACK revision，返回待投递消息。白名单与黑名单两项都必须已加载；所有拒绝都发生在任何
 * 状态变化之前。
 *
 * @param table 目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。
 * @param id 目标用户或频道身份 ID。
 * @param value 待发布的白名单或黑名单条目数据；`null` 表示删除该条目。
 * @returns 已登记 revision 的待投递 Disk I/O 身份策略写入消息。
 */
function publishIdentityPolicyWrite(
  table: IdentityPolicyTable,
  id: number,
  value: Readonly<WhitelistEntryData> | Readonly<BlocklistEntryData> | null
): IdentityPolicyWriteDiskMessage {
  assertTelegramIdentityId(id, `identity ${table} write`);
  const entry: IdentityPolicyCacheEntry | undefined = identityPolicyCache.peek(id);
  if (entry?.whitelist === undefined || entry.blocklist === undefined) {
    throw new Error(`Identity ${id} must be prefetched before a ${table} mutation.`);
  }
  const other: Readonly<WhitelistEntryData> | Readonly<BlocklistEntryData> | null =
    table === "whitelist" ? entry.blocklist : entry.whitelist;
  if (value !== null && other !== null) {
    throw new Error(`Identity ${id} cannot exist in both whitelist and blocklist.`);
  }
  if (!Number.isSafeInteger(identityWriteRevision.current + 1)) {
    throw new Error("Identity policy revision space is exhausted.");
  }
  const previous: Readonly<WhitelistEntryData> | Readonly<BlocklistEntryData> | null =
    table === "whitelist" ? entry.whitelist : entry.blocklist;
  const data: string | null = value === null
    ? null
    : table === "whitelist"
      ? encodeWhitelistEntryData(value as Readonly<WhitelistEntryData>)
      : encodeBlocklistEntryData(value as Readonly<BlocklistEntryData>);
  const revision: number = identityWriteRevision.current + 1;
  const message: IdentityPolicyWriteDiskMessage = {
    type: "identityPolicyWrite",
    table,
    id,
    data,
    revision,
  };
  const pendingWrites: Map<number, UnacknowledgedIdentityWrite> = unacknowledgedIdentityWrites(table);
  const pendingPrevious: UnacknowledgedIdentityWrite | undefined = pendingWrites.get(id);
  const bytes: number = unacknowledgedIdentityBytes.current[table] + storageWriteCost(data) -
    (pendingPrevious === undefined ? 0 : storageWriteCost(pendingPrevious.data));
  assertStorageAdmission(pendingWrites.size + (pendingPrevious === undefined ? 1 : 0), bytes);
  if (!canQueueDiskIOBusiness(message)) throw new Error("Disk I/O refused identity state publication.");
  if (table === "whitelist") {
    entry.whitelist = value as Readonly<WhitelistEntryData> | null;
  } else {
    entry.blocklist = value as Readonly<BlocklistEntryData> | null;
  }
  // 写入视为一次使用：已有键 set 只把条目挪到最新端。
  identityPolicyCache.set(id, entry);
  if (previous === null && value !== null) identityEntryCounts[table]++;
  if (previous !== null && value === null) identityEntryCounts[table]--;
  identityWriteRevision.current++;
  pendingWrites.set(id, { data, revision });
  unacknowledgedIdentityBytes.current[table] = bytes;
  return message;
}

/**
 * 投递已发布的最终值；失败时保留未 ACK revision 供 Worker 重建重放。
 *
 * @param message 已登记 revision 的身份策略写入消息。
 * @returns 已立即投递给 Disk I/O Worker 时返回 `true`，暂存待重放时返回 `false`。
 */
function postIdentityPolicyWrite(message: IdentityPolicyWriteDiskMessage): boolean {
  if (diskIO.postDiskIO(message) === true) return true;
  logger.error(
    `Failed to queue ${message.table} identity ${message.id}; retaining revision ${message.revision} for replay.`
  );
  return false;
}

/**
 * 容量准入后发布 LRU 最终值，登记未 ACK revision 并投给 Disk I/O；迟到读不能覆盖它。
 * 调用前必须预热该 ID 的正/负结论；表计数与白/黑名单互斥校验依赖它。
 *
 * @param table 目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。
 * @param id 目标用户或频道身份 ID。
 * @param value 待发布的白名单或黑名单条目数据；`null` 表示删除该条目。
 * @returns 写入消息已被 Disk I/O Worker 立即接受时返回 `true`，暂存待重放时返回 `false`。
 */
export function queueIdentityPolicyWrite(
  table: IdentityPolicyTable,
  id: number,
  value: Readonly<WhitelistEntryData> | Readonly<BlocklistEntryData> | null
): boolean {
  return postIdentityPolicyWrite(publishIdentityPolicyWrite(table, id, value));
}

/**
 * 删除一条黑名单：校验与发布同 queueIdentityPolicyWrite，发布负缓存与计数后先执行
 * beforePost，再投递 tombstone，因此 beforePost 投出的 Disk I/O 消息先于 tombstone
 * 到达 Worker。beforePost 抛错时 tombstone 仍投递，异常照常上抛。
 *
 * @param id 待从黑名单删除的用户或频道身份 ID。
 * @param beforePost 发布负缓存与计数后、投递黑名单删除墓碑前同步执行的钩子（用于先裁剪待踢 outbox）。
 * @returns 黑名单删除墓碑已被 Disk I/O Worker 立即接受时返回 `true`，暂存待重放时返回 `false`。
 */
export function queueBlocklistDeletion(id: number, beforePost: () => void): boolean {
  const message: IdentityPolicyWriteDiskMessage = publishIdentityPolicyWrite("blocklist", id, null);
  try {
    beforePost();
  } catch (error: unknown) {
    postIdentityPolicyWrite(message);
    throw error;
  }
  return postIdentityPolicyWrite(message);
}

/**
 * 等指定身份当前未确认最终值通过 SQLite 事务并收到精确 revision ACK。
 * 幂等重试会补投先前未 ACK 的同一 revision，不创建新版本。
 *
 * @param table 目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。
 * @param id 待确认落盘的用户或频道身份 ID。
 * @param retryUnacknowledged 为 `true` 时先向 Disk I/O Worker 补投尚未确认的同一 revision。
 */
export async function confirmIdentityPolicyPersisted(
  table: IdentityPolicyTable,
  id: number,
  retryUnacknowledged: boolean
): Promise<void> {
  assertTelegramIdentityId(id, `identity ${table} persistence confirmation`);
  const pending: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  if (pending === undefined) return;
  if (retryUnacknowledged) requeueUnacknowledgedIdentityWrite(table, id);
  const outcome: DomainFlushOutcome = await diskIO.flushDiskIODomain(table);
  if (outcome.result !== "flushed") {
    throw new Error(
      `Persistence flush ${outcome.result} for ${table} identity ${id} revision ${pending.revision}; ${describeFlushFailure(outcome)}.`
    );
  }
  if (
    unacknowledgedIdentityWrites(table).get(id)?.revision === pending.revision
  ) {
    throw new Error(
      `Persistence Worker did not acknowledge ${table} identity ${id} revision ${pending.revision}.`
    );
  }
}

/**
 * 重投某主键仍未 ACK 的最终值；不创建新 revision。投递被拒只记日志：最终值仍留在未 ACK
 * 表里等 Worker 重建重放。
 *
 * @param table 目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。
 * @param id 待补投未确认写入的用户或频道身份 ID。
 * @returns 该主键存在未 ACK 最终值（已尝试补投）为 true，调用方应再等一次落盘确认；
 *   已全部 ACK 为 false。
 */
export function requeueUnacknowledgedIdentityWrite(
  table: IdentityPolicyTable,
  id: number
): boolean {
  const change: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  if (change === undefined) return false;
  const posted: boolean = diskIO.postDiskIO({
    type: "identityPolicyWrite",
    table,
    id,
    data: change.data,
    revision: change.revision,
  } satisfies IdentityPolicyWriteDiskMessage) === true;
  if (!posted) {
    logger.error(
      `Failed to re-queue ${table} identity ${id} revision ${change.revision}.`
    );
  }
  return true;
}

/**
 * 根据 Disk I/O 落盘回执按 revision 销账已确认持久化的白名单与黑名单写入并释放字节预算。
 *
 * @param reply Disk I/O Worker 返回的身份存储落盘确认回执。
 */
function settleIdentityStorageWrite(
  reply: IdentityStoragePersistedReply
): void {
  for (const persisted of reply.writes) {
    const pending: Map<number, UnacknowledgedIdentityWrite> =
      unacknowledgedIdentityWrites(persisted.table);
    const change: UnacknowledgedIdentityWrite | undefined = pending.get(persisted.id);
    if (change?.revision === persisted.revision) {
      pending.delete(persisted.id);
      unacknowledgedIdentityBytes.current[persisted.table] -= storageWriteCost(change.data);
    }
  }
}

/**
 * 在 Disk I/O Worker 重建恢复期间按全局 revision 升序重放未确认的白名单与黑名单写入。
 *
 * @param transport 当前恢复代际的受限传输通道。
 * @returns 全部未确认写入均被接受时返回 `true`，任一投递失败时返回 `false`。
 */
function replayIdentityPolicyWrites(
  transport: DiskIORecoveryTransport
): boolean {
  const tables: readonly (readonly [
    IdentityPolicyTable,
    Map<number, UnacknowledgedIdentityWrite>
  ])[] = [
    ["whitelist", unacknowledgedWhitelistWrites],
    ["blocklist", unacknowledgedBlocklistWrites],
  ];
  const queued: QueuedIdentityWrite[] = [];
  for (const [table, writes] of tables) {
    for (const [id, change] of writes) queued.push({ table, id, change });
  }
  queued.sort(
    (left: QueuedIdentityWrite, right: QueuedIdentityWrite): number =>
      left.change.revision - right.change.revision
  );
  for (const write of queued) {
    if (!transport.post({
      type: "identityPolicyWrite",
      table: write.table,
      id: write.id,
      data: write.change.data,
      revision: write.change.revision,
    } satisfies IdentityPolicyWriteDiskMessage)) return false;
  }
  return true;
}

diskIO.onDiskIOReply("identityStoragePersisted", settleIdentityStorageWrite);
diskIO.onDiskIORespawn(
  "identity policies",
  DISK_IO_RESPAWN_PRIORITIES.BLOCKLIST,
  replayIdentityPolicyWrites
);
