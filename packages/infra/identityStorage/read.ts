import * as diskIO from "../diskIO";
import {
  identityEntryCounts,
  identityPolicyCache,
} from "../../cache/main/identityStorage";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from
  "../../consts/identityStorage";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
} from "../../database/codec/identity";
import { logger } from "../logger";
import {
  currentTemporaryAdBypassActivity,
  storedTemporaryAdBypassActivities,
} from "../identityPolicy/temporaryAdBypass";
import {
  currentIdentityPolicyText,
  rawIdentityPolicyRows,
} from "./shared";
import type { CachedUser } from "../../types/chatState";
import type {
  BlocklistEntryData,
  IdentityPolicyTable,
  TelegramIdentityMetadata,
  WhitelistEntryData,
} from "../../types/identityPolicy";
import type {
  IdentityPolicyCacheEntry,
  IdentityPolicyRawReadResult,
  IdentityPolicyVerdicts,
} from "../../types/identityStorage";
import type { TemporaryAdBypassActivity } from "../../types/states/temporaryAdBypass";

/**
 * CachedUser 的 Telegram 字段稳定映射到 SQLite meta。
 *
 * @param user 群状态缓存中的用户或频道身份对象。
 * @returns 可写入 SQLite 的标准化 Telegram 身份展示元数据。
 */
export function identityMetadataFromCachedUser(
  user: CachedUser
): Readonly<TelegramIdentityMetadata> {
  return {
    firstName: user.isChannel === true
      ? user.title ?? user.first_name ?? ""
      : user.first_name ?? "",
    lastName: user.last_name ?? "",
    username: user.username ?? "",
  };
}

/**
 * 启动恢复只灌入数据库计数。
 *
 * 两个计数都通过校验后才清空合并身份缓存并写入计数；三类未 ACK 最终值与
 * revision 发号器不在这里改动。
 *
 * @param whitelistCount 启动时从 SQLite 统计出的白名单条目总数。
 * @param blocklistCount 启动时从 SQLite 统计出的黑名单条目总数。
 */
export function hydrateIdentityStorageCounts(
  whitelistCount: number,
  blocklistCount: number
): void {
  if (!Number.isSafeInteger(whitelistCount) || whitelistCount < 0) {
    throw new Error("Whitelist entry count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(blocklistCount) || blocklistCount < 0) {
    throw new Error("Blocklist entry count must be a non-negative safe integer.");
  }
  identityPolicyCache.clear();
  identityEntryCounts.whitelist = whitelistCount;
  identityEntryCounts.blocklist = blocklistCount;
}

/**
 * 读取指定身份策略表在主线程维护的当前总条目数。
 *
 * @param table 目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。
 * @returns 当前表内的条目总数。
 */
export function getIdentityEntryCount(table: IdentityPolicyTable): number {
  return identityEntryCounts[table];
}

/**
 * 合并身份缓存是否已有该主键三项的正/负结论；不刷新热度。
 *
 * @param id 待检查的用户或频道身份 ID。
 * @returns 白名单、黑名单与临时免检三项均已在缓存中加载完毕时返回 `true`，否则返回 `false`。
 */
export function isIdentityPolicyCached(id: number): boolean {
  const entry: IdentityPolicyCacheEntry | undefined = identityPolicyCache.peek(id);
  return entry?.whitelist !== undefined &&
    entry.blocklist !== undefined &&
    entry.temporaryAdBypass !== undefined;
}

/**
 * 同步读取已预热的白名单并刷新条目热度；冷缺失按 fail-closed 解释为不存在。
 *
 * @param id 待读取的用户或频道身份 ID。
 * @returns 命中白名单缓存时返回只读白名单条目数据；未在白名单或冷缺失时返回 `undefined`。
 */
export function cachedWhitelistEntry(
  id: number
): Readonly<WhitelistEntryData> | undefined {
  return identityPolicyCache.get(id)?.whitelist ?? undefined;
}

/**
 * 同步读取已预热的黑名单并刷新条目热度；冷缺失按 fail-closed 解释为不存在。
 *
 * @param id 待读取的用户或频道身份 ID。
 * @returns 命中黑名单缓存时返回只读黑名单条目数据；未在黑名单或冷缺失时返回 `undefined`。
 */
export function cachedBlocklistEntry(
  id: number
): Readonly<BlocklistEntryData> | undefined {
  return identityPolicyCache.get(id)?.blocklist ?? undefined;
}

/** 结论收集器；readIdentityPolicyVerdicts 逐块累加，预热路径不传。 */
interface IdentityPolicyVerdictSets {
  readonly whitelisted: Set<number>;
  readonly blocked: Set<number>;
}

/**
 * 读取一块主键，每个 id 对合并身份缓存做一次整条写入（三项一起）；传入 verdicts 时同时把本块
 * 结论记进调用方的局部集合。本地未 ACK 最终值覆盖数据库迟到结果。
 *
 * @param ids 本次分块读取的身份 ID 只读列表。
 * @param verdicts 可选的永久白名单/黑名单命中集合累加器。
 */
async function readIdentityPolicyChunk(
  ids: readonly number[],
  verdicts?: IdentityPolicyVerdictSets
): Promise<void> {
  const reply: IdentityPolicyRawReadResult = await diskIO.readIdentityPolicies(ids);
  const requested: Set<number> = new Set(ids);
  const whitelistRows: Map<number, string> = rawIdentityPolicyRows(
    reply.whitelist,
    requested,
    "whitelist"
  );
  const blocklistRows: Map<number, string> = rawIdentityPolicyRows(
    reply.blocklist,
    requested,
    "blocklist"
  );
  const temporaryAdBypassRows: ReadonlyMap<number, Readonly<TemporaryAdBypassActivity>> =
    storedTemporaryAdBypassActivities(reply.temporaryAdBypass, requested);
  for (const id of ids) {
    const whitelistText: string | null = currentIdentityPolicyText(
      "whitelist",
      id,
      whitelistRows.get(id)
    );
    const blocklistText: string | null = currentIdentityPolicyText(
      "blocklist",
      id,
      blocklistRows.get(id)
    );
    if (whitelistText !== null && blocklistText !== null) {
      throw new Error(`Identity ${id} exists in both whitelist and blocklist views.`);
    }
    if (verdicts !== undefined) {
      if (whitelistText !== null) verdicts.whitelisted.add(id);
      if (blocklistText !== null) verdicts.blocked.add(id);
    }
    const whitelist: Readonly<WhitelistEntryData> | null = whitelistText === null
      ? null
      : decodeWhitelistEntryData(whitelistText, `permission_list[${id}].policy`);
    const blocklist: Readonly<BlocklistEntryData> | null = blocklistText === null
      ? null
      : decodeBlocklistEntryData(blocklistText, `blocklist_entries[${id}].data`);
    const temporaryAdBypass: Readonly<TemporaryAdBypassActivity> | null =
      currentTemporaryAdBypassActivity(id, temporaryAdBypassRows);
    const entry: IdentityPolicyCacheEntry | undefined = identityPolicyCache.get(id);
    if (entry === undefined) {
      identityPolicyCache.set(id, { whitelist, blocklist, temporaryAdBypass });
    } else {
      entry.whitelist = whitelist;
      entry.blocklist = blocklist;
      entry.temporaryAdBypass = temporaryAdBypass;
    }
  }
}

/**
 * 批量预热合并身份缓存的冷缺失（条目不存在或任一项未加载）；本地未 ACK 最终值覆盖数据库迟到结果。
 * 已缓存的主键按一次使用刷新热度，不会被同一次预热写入的冷键挤出
 * （单块小于 LRU 容量，见 IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES）。
 * Disk I/O 未初始化时直接返回 true，同步读取保持 fail-closed。
 * 冷读失败只记日志并返回 false，对应主键保持冷缺失。
 *
 * @param candidateIds 待预热身份策略缓存的候选身份 ID 列表。
 * @returns true 表示没有冷读失败；破坏性批量路径必须在 false 时放弃执行。
 */
export async function prefetchIdentityPolicies(
  candidateIds: readonly number[]
): Promise<boolean> {
  const missing: number[] = [];
  const seen: Set<number> = new Set();
  for (const id of candidateIds) {
    assertTelegramIdentityId(id, "identity policy prefetch");
    if (seen.has(id)) continue;
    seen.add(id);
    const entry: IdentityPolicyCacheEntry | undefined = identityPolicyCache.get(id);
    if (
      entry?.whitelist === undefined ||
      entry.blocklist === undefined ||
      entry.temporaryAdBypass === undefined
    ) {
      missing.push(id);
    }
  }
  if (
    missing.length === 0 ||
    diskIO.isDiskIOInitialized() !== true
  ) return true;
  for (
    let index: number = 0;
    index < missing.length;
    index += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    try {
      await readIdentityPolicyChunk(
        missing.slice(index, index + IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES)
      );
    } catch (error: unknown) {
      logger.error(
        `Failed to prefetch ${missing.length} identity policy row(s); leaving them cold:`,
        error
      );
      return false;
    }
  }
  return true;
}

/**
 * 为破坏性批量处置直接冷读一批主键的永久策略结论，不论它们此刻是否已缓存。
 *
 * 结论由调用方局部持有，不受处置期间 LRU 淘汰影响；读取同时整条写入合并身份缓存，
 * 供处置中的实时复核继续命中。
 * 本地未 ACK 最终值覆盖数据库迟到结果；Disk I/O 不可用时按读取失败处理。
 *
 * @param candidateIds 待查询永久白名单与黑名单结论的候选身份 ID 列表。
 * @returns 读取失败时为 null，调用方必须放弃本批处置。
 */
export async function readIdentityPolicyVerdicts(
  candidateIds: readonly number[]
): Promise<IdentityPolicyVerdicts | null> {
  const ids: number[] = [];
  const seen: Set<number> = new Set();
  for (const id of candidateIds) {
    assertTelegramIdentityId(id, "identity policy verdict read");
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const verdicts: IdentityPolicyVerdictSets = { whitelisted: new Set(), blocked: new Set() };
  for (
    let index: number = 0;
    index < ids.length;
    index += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    try {
      await readIdentityPolicyChunk(
        ids.slice(index, index + IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES),
        verdicts
      );
    } catch (error: unknown) {
      logger.error(
        `Failed to read identity policy verdicts for ${ids.length} identity(ies):`,
        error
      );
      return null;
    }
  }
  return verdicts;
}
