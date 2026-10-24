import {
  storagePendingBudgets,
  pendingBlocklistWrites,
  pendingWhitelistWrites,
  removalRowTargets,
  storageFlushHold,
  storedIdentityIdLookups,
  pendingTemporaryAdBypassWrites,
} from "../../../cache/workers/diskIO/storageDatabase";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
import {
  BLOCKLIST_SWEEP_PAGE_SIZE,
  BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES,
} from "../../../consts/identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
} from "../../../database/codec/identity";
import {
  prepareStoredIdentityIdLookups,
  readStoredBlocklistIdPage,
  readStoredIdentityPolicies,
} from "../../../database/interact/identityPolicy";
import { readStoredTemporaryAdBypassActivities } from
  "../../../database/interact/temporaryAdBypass";
import type {
  BlocklistIdPageReadReply,
  IdentityPersistenceReply,
  IdentityPoliciesReadReply,
} from "../../../types/diskIO/replies";
import type {
  IdentityPolicyWriteDiskMessage,
  ReadBlocklistIdPageRequest,
  ReadIdentityPoliciesRequest,
} from "../../../types/diskIO/messages";
import type { IdentityPolicyTable } from "../../../types/identityPolicy";
import type { PendingIdentityPolicyWrite, BlocklistIdPage } from "../../../types/identityStorage";
import type {
  PendingTemporaryAdBypassWrite,
  StoredTemporaryAdBypassActivity,
} from "../../../types/temporaryAdBypass";
import type {
  StoredIdentityIdLookup,
  StoredIdentityIdLookups,
  StoredIdentityPolicyRow,
} from "../../../types/storageDatabase";
import {
  assertPositiveRevision,
  perConnection,
  requireStorageDatabase,
  requireStorageDatabaseReader,
  storageSource,
} from "./context";
import { flushIfStorageFull } from "./flush";
import { errorMessage } from "../../../libs/errorMessage";

/**
 * 获取或初始化当前连接的预编译主键存在性查询语句。
 * @returns 当前数据库连接的预编译主键查询集合
 */
function identityIdLookups(): StoredIdentityIdLookups {
  return perConnection(storedIdentityIdLookups, prepareStoredIdentityIdLookups);
}

/**
 * 查询指定名单主键是否已在 SQLite 中持久化。
 * @param table 名单类型（白名单或黑名单）
 * @param id Telegram 身份 ID
 * @returns 该身份是否已存在于对应持久化表中
 */
function hasStoredIdentityPolicy(table: IdentityPolicyTable, id: number): boolean {
  const lookups: StoredIdentityIdLookups = identityIdLookups();
  const lookup: StoredIdentityIdLookup =
    table === "whitelist" ? lookups.whitelist : lookups.blocklist;
  return lookup.get({ id }) !== undefined;
}

/**
 * 按名单类型选择对应的未提交写缓冲映射。
 * @param table 名单类型（白名单或黑名单）
 * @returns 对应名单的未提交写缓冲 Map
 */
function pendingPolicyMap(
  table: IdentityPolicyTable
): Map<number, PendingIdentityPolicyWrite> {
  return table === "whitelist" ? pendingWhitelistWrites : pendingBlocklistWrites;
}

/**
 * 读取一页已提交黑名单主键并叠加事务缓冲中的未提交变更。
 * @param afterId 分页游标起点（不含），首屏传 null
 * @returns 叠加未提交变更后的黑名单主键分页结果
 */
function effectiveBlocklistIdPage(afterId: number | null): BlocklistIdPage {
  if (
    pendingBlocklistWrites.size >
    BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES
  ) {
    throw new Error(
      `Pending blocklist delta exceeds ${BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES} entries; ` +
      "refusing to expand a sweep page."
    );
  }
  const readLimit: number = BLOCKLIST_SWEEP_PAGE_SIZE +
    pendingBlocklistWrites.size + 1;
  const storedIds: readonly number[] = readStoredBlocklistIdPage(
    requireStorageDatabase(),
    afterId,
    readLimit
  );
  const candidates: Set<number> = new Set<number>();
  for (const id of storedIds) {
    if (pendingBlocklistWrites.get(id)?.data !== null) candidates.add(id);
  }
  for (const [id, pending] of pendingBlocklistWrites) {
    if (
      pending.data !== null &&
      (afterId === null || id > afterId)
    ) {
      candidates.add(id);
    }
  }
  const ordered: number[] = [...candidates];
  ordered.sort((left: number, right: number): number => left - right);
  const done: boolean = ordered.length <= BLOCKLIST_SWEEP_PAGE_SIZE;
  const ids: number[] = done
    ? ordered
    : ordered.slice(0, BLOCKLIST_SWEEP_PAGE_SIZE);
  return {
    ids,
    nextCursor: ids.length === 0 ? afterId : ids[ids.length - 1]!,
    done,
  };
}

/**
 * 判断指定身份是否属于叠加未提交变更后的有效黑名单。
 * @param id Telegram 身份 ID
 * @returns 该身份在有效黑名单中是否存在
 */
export function hasEffectiveBlocklistIdentity(id: number): boolean {
  const pending: PendingIdentityPolicyWrite | undefined =
    pendingBlocklistWrites.get(id);
  if (pending !== undefined) return pending.data !== null;
  return hasStoredIdentityPolicy("blocklist", id);
}

/**
 * 判断叠加未提交变更后的有效黑名单是否非空。
 * @returns 有效黑名单中是否至少包含一个身份
 */
export function hasAnyEffectiveBlocklistIdentity(): boolean {
  return effectiveBlocklistIdPage(null).ids.length > 0;
}

/**
 * 校验身份策略写入消息的主键、revision 与载荷格式。
 * @param message 身份策略写入消息
 */
function validatePolicyData(message: IdentityPolicyWriteDiskMessage): void {
  const source: string = storageSource(
    message.table === "whitelist" ? "permission_list" : "blocklist_entries",
    message.id
  );
  assertTelegramIdentityId(message.id, source);
  assertPositiveRevision(message.revision, source);
  if (message.data === null) return;
  if (message.table === "whitelist") {
    decodeWhitelistEntryData(message.data, source);
  } else {
    decodeBlocklistEntryData(message.data, source);
  }
}

/**
 * 断言目标身份未在互斥名单或临时广告免检表中同时存在。
 * @param message 身份策略写入消息
 */
function assertOppositePolicyAbsent(message: IdentityPolicyWriteDiskMessage): void {
  if (message.data === null) return;
  const opposite: IdentityPolicyTable = message.table === "whitelist"
    ? "blocklist"
    : "whitelist";
  const pending: PendingIdentityPolicyWrite | undefined =
    pendingPolicyMap(opposite).get(message.id);
  if (pending !== undefined) {
    if (pending.data !== null) {
      throw new Error(
        `Identity ${message.id} cannot exist in both permission_list and blocklist_entries.`
      );
    }
  } else if (hasStoredIdentityPolicy(opposite, message.id)) {
    throw new Error(
      `Identity ${message.id} cannot exist in both permission_list and blocklist_entries.`
    );
  }
  if (message.table === "blocklist") {
    const pendingTemporary: PendingTemporaryAdBypassWrite | undefined =
      pendingTemporaryAdBypassWrites.get(message.id);
    const temporaryPresent: boolean = pendingTemporary === undefined
      ? identityIdLookups().temporaryAdBypass.get({ id: message.id }) !== undefined
      : pendingTemporary.activity !== null;
    if (temporaryPresent) {
      throw new Error(
        `Identity ${message.id} cannot exist in blocklist_entries and temporary_ad_bypass_entries.`
      );
    }
  }
}

/**
 * 批量读取指定身份的已提交临时广告免检累计并叠加未提交变更。
 * @param ids 待查询的去重身份 ID 列表
 * @returns 叠加未提交变更后的临时广告免检累计行列表
 */
function temporaryAdBypassRowsWithPending(
  ids: readonly number[]
): readonly StoredTemporaryAdBypassActivity[] {
  const rows: readonly StoredTemporaryAdBypassActivity[] =
    readStoredTemporaryAdBypassActivities(requireStorageDatabaseReader(), ids);
  const values: Map<number, StoredTemporaryAdBypassActivity> = new Map();
  for (const row of rows) values.set(row.id, row);
  for (const id of ids) {
    const pending: PendingTemporaryAdBypassWrite | undefined =
      pendingTemporaryAdBypassWrites.get(id);
    if (pending === undefined) continue;
    if (pending.activity === null) values.delete(id);
    else values.set(id, { id, ...pending.activity });
  }
  return [...values.values()];
}

/**
 * 校验待删除黑名单身份未被待踢 outbox 活动行引用（镜像重放暂挂期间跳过，参见 docs/cn/04-invariants.md）。
 * @param id 待删除的黑名单身份 ID
 */
function assertBlocklistDeletionUnreferenced(id: number): void {
  if (storageFlushHold.current) return;
  let hasProbeRow: boolean = false;
  for (const [removalId, targets] of removalRowTargets) {
    if (targets.probeMembership) {
      hasProbeRow = true;
    } else if (targets.userIds.includes(id)) {
      throw new Error(
        `Blocklist identity ${id} is still frozen in pending removal row ${removalId}.`
      );
    }
  }
  if (!hasProbeRow) return;
  if (!effectiveBlocklistIdPage(null).ids.some((other: number): boolean => other !== id)) {
    throw new Error(
      `Deleting blocklist identity ${id} would leave pending sweep rows without any blocklist entry.`
    );
  }
}

/**
 * 收下一条黑/白名单最终值；迟到 revision 不得覆盖更新值。
 * @param message 身份策略写入消息
 * @param reply 持久化回执发送回调
 */
export function handleIdentityPolicyWrite(
  message: IdentityPolicyWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  validatePolicyData(message);
  const pending: Map<number, PendingIdentityPolicyWrite> = pendingPolicyMap(message.table);
  const current: PendingIdentityPolicyWrite | undefined = pending.get(message.id);
  if (current !== undefined && current.revision >= message.revision) return;
  assertOppositePolicyAbsent(message);
  if (message.table === "blocklist" && message.data === null) {
    assertBlocklistDeletionUnreferenced(message.id);
  }
  storagePendingBudgets[message.table].reserve(current === undefined ? 1 : 0, storageWriteCost(message.data) - (current === undefined ? 0 : storageWriteCost(current.data)));
  pending.set(message.id, { data: message.data, revision: message.revision });
  flushIfStorageFull(reply);
}

/**
 * 批量读取指定名单的已提交行并叠加未提交变更。
 * @param table 名单类型（白名单或黑名单）
 * @param ids 待查询的去重身份 ID 列表
 * @returns 叠加未提交变更后的 `[id, data]` 键值对列表
 */
function policyRowsWithPending(
  table: IdentityPolicyTable,
  ids: readonly number[]
): readonly (readonly [number, string])[] {
  if (ids.length === 0) return [];
  const rows: readonly StoredIdentityPolicyRow[] = readStoredIdentityPolicies(
    requireStorageDatabaseReader(),
    table,
    ids
  );
  const values: Map<number, string> = new Map();
  for (const row of rows) values.set(row.id, row.data);
  for (const id of ids) {
    const pending: PendingIdentityPolicyWrite | undefined = pendingPolicyMap(table).get(id);
    if (pending === undefined) continue;
    if (pending.data === null) values.delete(id);
    else values.set(id, pending.data);
  }
  return [...values];
}

/**
 * 批量读取永久策略与临时累计；结果包含 Worker 尚未提交的最终值。
 * @param message 批量读取身份策略请求消息
 * @returns 包含白名单、黑名单与临时广告免检累计结果的应答消息
 */
export function readIdentityPolicies(
  message: ReadIdentityPoliciesRequest
): IdentityPoliciesReadReply {
  try {
    const ids: number[] = [...new Set<number>(message.ids)];
    for (const id of ids) {
      assertTelegramIdentityId(id, `${IDENTITY_DATABASE_PATH}:readIdentityPolicies`);
    }
    return {
      type: "identityPoliciesRead",
      requestId: message.requestId,
      whitelist: policyRowsWithPending("whitelist", ids),
      blocklist: policyRowsWithPending("blocklist", ids),
      temporaryAdBypass: temporaryAdBypassRowsWithPending(ids),
    };
  } catch (error: unknown) {
    return {
      type: "identityPoliciesRead",
      requestId: message.requestId,
      error: errorMessage(error),
    };
  }
}

/**
 * 读取一页有界黑名单主键并叠加尚未提交的最终值；只在群级补扫边界调用。
 * @param message 黑名单主键分页读取请求消息
 * @returns 包含黑名单主键分页结果或错误信息的应答消息
 */
export function readBlocklistIdPage(
  message: ReadBlocklistIdPageRequest
): BlocklistIdPageReadReply {
  try {
    if (message.afterId !== null) {
      assertTelegramIdentityId(
        message.afterId,
        `${IDENTITY_DATABASE_PATH}:readBlocklistIdPage.afterId`
      );
    }
    return {
      type: "blocklistIdPageRead",
      requestId: message.requestId,
      page: effectiveBlocklistIdPage(message.afterId),
    };
  } catch (error: unknown) {
    return {
      type: "blocklistIdPageRead",
      requestId: message.requestId,
      error: errorMessage(error),
    };
  }
}
