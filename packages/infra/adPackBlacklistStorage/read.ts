/**
 * 主线程广告包黑名单 768 LRU 热读、SQLite 冷缺失批量查库、启动计数恢复、目标校验与下游观察者管理（`packages/infra/adPackBlacklistStorage.ts` 子模块）。
 */

import {
  adPackBlacklistCache,
  adPackBlacklistCounts,
  adPackBlacklistObserver,
  unacknowledgedAdPackBlacklistTotals,
  unacknowledgedAdPackBlacklistWrites,
} from "../../cache/main/adPackBlacklist";
import { STICKER_PACK_NAME_PATTERN } from "../../consts/aiChat/stickers";
import { AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES } from "../../consts/identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../consts/paths";
import {
  assertAdPackBlacklistKind,
  assertAdPackBlacklistPack,
} from "../../database/codec/adPackBlacklist";
import type {
  AdPackBlacklistCounts,
  AdPackBlacklistKind,
  AdPackBlacklistMutationObserver,
  UnacknowledgedAdPackBlacklistWrite,
} from "../../types/adPackBlacklist";
import * as diskIO from "../diskIO";
import { logger } from "../logger";

/**
 * 构造广告包黑名单单行校验的错误源标识。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 目标包名 short name。
 * @returns 供 `invalidInput` 使用的源标识。
 */
export function adPackBlacklistRowSource(kind: AdPackBlacklistKind, pack: string): string {
  return `${IDENTITY_DATABASE_PATH}:ad_pack_blacklists[${String(kind)}:${String(pack)}]`;
}

/**
 * 构造 768 LRU 共享热缓存的复合键（`kind` 仅取 `"sticker"` / `"emoji"`，`pack` 不含冒号，无碰撞）。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 合法贴纸包或自定义表情包 short name。
 * @returns 唯一缓存键字符串。
 */
export function adPackBlacklistCacheKey(kind: AdPackBlacklistKind, pack: string): string {
  return `${kind}:${pack}`;
}

/**
 * 仅在非法时构造诊断来源并抛出校验错误，避免热路径上每次合法查询都拼接路径字符串。
 *
 * @param kind 黑名单种类。
 * @param pack 待校验包名。
 */
function assertPackFast(kind: AdPackBlacklistKind, pack: string): void {
  if (typeof pack !== "string" || !STICKER_PACK_NAME_PATTERN.test(pack)) {
    assertAdPackBlacklistPack(pack, adPackBlacklistRowSource(kind, pack));
  }
}

/**
 * 校验单条写入、查询或确认入口传入的 `(kind, pack)` 合法性；合法热路径不分配错误来源字符串。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 目标包名 short name。
 */
export function assertAdPackBlacklistTarget(kind: AdPackBlacklistKind, pack: string): void {
  if (kind !== "sticker" && kind !== "emoji") {
    assertAdPackBlacklistKind(kind, adPackBlacklistRowSource(kind, pack));
  }
  assertPackFast(kind, pack);
}

/**
 * 向已注册的下游观察者广播最新的广告包黑名单条数统计。
 */
export function notifyAdPackBlacklistObserver(): void {
  try {
    adPackBlacklistObserver.current?.(getAdPackBlacklistCounts());
  } catch (error: unknown) {
    logger.error("Failed to publish the ad pack blacklist count change:", error);
  }
}

/**
 * 启动恢复只灌入 SQLite `ad_pack_blacklists` 两类条数统计并清空热查询 LRU 缓存，不加载全表包名。
 *
 * @param counts 启动时从 SQLite 统计出的两类广告包黑名单条数。
 */
export function hydrateAdPackBlacklistCounts(counts: Readonly<AdPackBlacklistCounts>): void {
  if (!Number.isSafeInteger(counts.sticker) || counts.sticker < 0) {
    throw new Error("Ad sticker pack blacklist count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(counts.emoji) || counts.emoji < 0) {
    throw new Error("Ad emoji pack blacklist count must be a non-negative safe integer.");
  }
  adPackBlacklistCache.clear();
  unacknowledgedAdPackBlacklistWrites.sticker.clear();
  unacknowledgedAdPackBlacklistWrites.emoji.clear();
  unacknowledgedAdPackBlacklistTotals.entries = 0;
  unacknowledgedAdPackBlacklistTotals.bytes = 0;
  adPackBlacklistCounts.sticker = counts.sticker;
  adPackBlacklistCounts.emoji = counts.emoji;
}

/**
 * 读取指定种类当前在主线程维护的广告黑名单总条数。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @returns 当前总条数。
 */
export function getAdPackBlacklistCount(kind: AdPackBlacklistKind): number {
  assertAdPackBlacklistKind(kind, `${IDENTITY_DATABASE_PATH}:ad_pack_blacklists`);
  return adPackBlacklistCounts[kind];
}

/**
 * 读取主线程维护的两类广告包黑名单总条数只读快照。
 *
 * @returns 包含贴纸包与自定义表情包总条数的只读快照。
 */
export function getAdPackBlacklistCounts(): Readonly<AdPackBlacklistCounts> {
  return {
    sticker: adPackBlacklistCounts.sticker,
    emoji: adPackBlacklistCounts.emoji,
  };
}

/**
 * 不刷新 LRU 顺位地探测指定 `(kind, pack)` 的内存状态（优先读本地未 ACK 最终值，再读 768 LRU）。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 目标包名 short name。
 * @returns 已在内存命中时返回布尔结论；冷缺失返回 `undefined`。
 */
export function peekCachedAdPackBlacklist(
  kind: AdPackBlacklistKind,
  pack: string
): boolean | undefined {
  assertAdPackBlacklistTarget(kind, pack);
  const pending: UnacknowledgedAdPackBlacklistWrite | undefined =
    unacknowledgedAdPackBlacklistWrites[kind].get(pack);
  if (pending !== undefined) return pending.blacklisted;
  return adPackBlacklistCache.peek(adPackBlacklistCacheKey(kind, pack));
}

/**
 * 对已通过形态校验的 `(kind, pack)` 读取内存中的正/负缓存结论并刷新 LRU 顺位（本地未 ACK 最终值优先）。
 *
 * @param kind 已校验的黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 已校验的目标包名 short name。
 * @returns 命中时返回 `true`/`false`，冷缺失返回 `undefined`。
 */
function lookupValidatedCachedAdPackBlacklist(
  kind: AdPackBlacklistKind,
  pack: string
): boolean | undefined {
  const key: string = adPackBlacklistCacheKey(kind, pack);
  const pending: UnacknowledgedAdPackBlacklistWrite | undefined =
    unacknowledgedAdPackBlacklistWrites[kind].get(pack);
  if (pending !== undefined) {
    adPackBlacklistCache.set(key, pending.blacklisted);
    return pending.blacklisted;
  }
  return adPackBlacklistCache.get(key);
}

/**
 * 校验并收敛 Disk I/O 返回的单批广告包黑名单命中包名集合，拒绝越权或重复回传。
 *
 * @param kind 目标黑名单种类。
 * @param matchedPacks Disk I/O Worker 回传的命中包名列表。
 * @param requested 本次请求查询的合法包名集合。
 * @returns 校验通过的命中包名集合。
 */
function validateMatchedPackReply(
  kind: AdPackBlacklistKind,
  matchedPacks: readonly string[],
  requested: ReadonlySet<string>
): ReadonlySet<string> {
  const result: Set<string> = new Set<string>();
  for (const pack of matchedPacks) {
    assertPackFast(kind, pack);
    if (!requested.has(pack) || result.has(pack)) {
      throw new Error(
        `Disk I/O returned an unexpected or duplicate ${kind} ad pack blacklist entry "${pack}".`
      );
    }
    result.add(pack);
  }
  return result;
}

/**
 * 读取单块冷缺失包名并回填主线程 768 LRU 缓存；本地未 ACK 最终值始终覆盖数据库迟到结果。
 *
 * @param kind 目标黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param chunk 本次批量查库的去重合法包名切片（不超过 `AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES`）。
 * @param statesOut 可选的结果映射累加器，写入每个包名的最新布尔结论。
 * @returns 若本块存在命中的黑名单包名，按 `chunk` 顺序返回首个命中包名，否则返回 `null`。
 */
async function readAdPackBlacklistChunk(
  kind: AdPackBlacklistKind,
  chunk: readonly string[],
  statesOut?: Map<string, boolean>
): Promise<string | null> {
  const matchedReply: readonly string[] = await diskIO.readAdPackBlacklists(kind, chunk);
  const matchedInDb: ReadonlySet<string> | null = matchedReply.length === 0
    ? null
    : validateMatchedPackReply(kind, matchedReply, new Set<string>(chunk));
  let firstMatched: string | null = null;
  for (const pack of chunk) {
    const pending: UnacknowledgedAdPackBlacklistWrite | undefined =
      unacknowledgedAdPackBlacklistWrites[kind].get(pack);
    const present: boolean = pending !== undefined
      ? pending.blacklisted
      : matchedInDb?.has(pack) === true;
    adPackBlacklistCache.set(adPackBlacklistCacheKey(kind, pack), present);
    statesOut?.set(pack, present);
    if (present && firstMatched === null) firstMatched = pack;
  }
  return firstMatched;
}

/**
 * 批量读取指定种类下各候选包名的权威黑名单状态：优先命中本地未 ACK 表与 768 LRU 缓存，
 * 仅将冷缺失包名按 `AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES` 分块打到 SQLite 并回填 768 LRU。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param packs 待查询的合法包名列表。
 * @returns 包名到最新权威黑名单布尔状态的只读映射。
 */
export async function readAdPackBlacklistStates(
  kind: AdPackBlacklistKind,
  packs: readonly string[]
): Promise<ReadonlyMap<string, boolean>> {
  if (kind !== "sticker" && kind !== "emoji") {
    assertAdPackBlacklistKind(kind, `${IDENTITY_DATABASE_PATH}:ad_pack_blacklists`);
  }
  const states: Map<string, boolean> = new Map<string, boolean>();
  if (packs.length === 0) return states;

  if (packs.length === 1) {
    const pack: string = packs[0]!;
    assertPackFast(kind, pack);
    const cached: boolean | undefined = lookupValidatedCachedAdPackBlacklist(kind, pack);
    if (cached !== undefined) {
      states.set(pack, cached);
      return states;
    }
    if (diskIO.isDiskIOInitialized() !== true) {
      states.set(pack, false);
      return states;
    }
    await readAdPackBlacklistChunk(kind, packs, states);
    return states;
  }

  const coldPacks: string[] = [];
  const seenCold: Set<string> = new Set<string>();
  for (const pack of packs) {
    assertPackFast(kind, pack);
    if (states.has(pack) || seenCold.has(pack)) continue;
    const cached: boolean | undefined = lookupValidatedCachedAdPackBlacklist(kind, pack);
    if (cached !== undefined) {
      states.set(pack, cached);
      continue;
    }
    seenCold.add(pack);
    coldPacks.push(pack);
  }
  if (coldPacks.length === 0) return states;

  if (diskIO.isDiskIOInitialized() !== true) {
    for (const pack of coldPacks) states.set(pack, false);
    return states;
  }

  for (
    let start: number = 0;
    start < coldPacks.length;
    start += AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES
  ) {
    const chunk: readonly string[] = coldPacks.slice(
      start,
      start + AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES
    );
    await readAdPackBlacklistChunk(kind, chunk, states);
  }
  return states;
}

/**
 * 按传入顺序查找指定种类下首个命中广告黑名单的包名（供 Anti-Raid Worker 广告检测快路径使用）：
 * - 若该种类条数为 0 且无未 ACK 写入，直接 O(1) 短路返回 `null`；
 * - 先扫本地未 ACK 表与 768 LRU 热缓存，任一正命中立即短路返回，不打 SQLite；
 * - 仅对冷缺失包名分块查 SQLite 并回填 768 LRU，首个命中块即刻返回。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param packs 候选包名列表。
 * @returns 首个命中的包名 short name；均未命中时返回 `null`。
 */
export async function findFirstBlacklistedAdPack(
  kind: AdPackBlacklistKind,
  packs: readonly string[]
): Promise<string | null> {
  if (kind !== "sticker" && kind !== "emoji") {
    assertAdPackBlacklistKind(kind, `${IDENTITY_DATABASE_PATH}:ad_pack_blacklists`);
  }
  if (packs.length === 0) return null;
  if (
    adPackBlacklistCounts[kind] === 0 &&
    unacknowledgedAdPackBlacklistWrites[kind].size === 0
  ) {
    return null;
  }

  if (packs.length === 1) {
    const pack: string = packs[0]!;
    assertPackFast(kind, pack);
    const cached: boolean | undefined = lookupValidatedCachedAdPackBlacklist(kind, pack);
    if (cached !== undefined) return cached ? pack : null;
    if (diskIO.isDiskIOInitialized() !== true) return null;
    return await readAdPackBlacklistChunk(kind, packs);
  }

  const coldPacks: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const pack of packs) {
    assertPackFast(kind, pack);
    if (seen.has(pack)) continue;
    seen.add(pack);
    const cached: boolean | undefined = lookupValidatedCachedAdPackBlacklist(kind, pack);
    if (cached === true) return pack;
    if (cached === undefined) coldPacks.push(pack);
  }
  if (coldPacks.length === 0 || diskIO.isDiskIOInitialized() !== true) return null;

  for (
    let start: number = 0;
    start < coldPacks.length;
    start += AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES
  ) {
    const chunk: readonly string[] = coldPacks.slice(
      start,
      start + AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES
    );
    const matched: string | null = await readAdPackBlacklistChunk(kind, chunk);
    if (matched !== null) return matched;
  }
  return null;
}

/**
 * 登记广告包黑名单条数变更的下游广播观察者（反向注册单槽位，解除时传入 `null`）。
 *
 * @param observer 接收最新条数统计的观察者回调，或用于解除注册的 `null`。
 */
export function registerAdPackBlacklistObserver(
  observer: AdPackBlacklistMutationObserver | null
): void {
  adPackBlacklistObserver.current = observer;
}
