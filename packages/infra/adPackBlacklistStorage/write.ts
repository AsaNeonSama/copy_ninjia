/**
 * 主线程广告包黑名单串行化写入、预算准入、768 LRU 覆写、批量新增与未确认写入排队/补投（`packages/infra/adPackBlacklistStorage.ts` 子模块）。
 */

import {
  adPackBlacklistCache,
  adPackBlacklistCounts,
  adPackBlacklistMutationChain,
  nextAdPackBlacklistRevision,
  unacknowledgedAdPackBlacklistTotals,
  unacknowledgedAdPackBlacklistWrites,
} from "../../cache/main/adPackBlacklist";
import { assertAdPackBlacklistPack } from "../../database/codec/adPackBlacklist";
import { runSerialChain } from "../../libs/serialChain";
import { storageWriteCost } from "../../libs/storageWriteBudget";
import type {
  AdPackBlacklistBatchAddResult,
  AdPackBlacklistKind,
  UnacknowledgedAdPackBlacklistWrite,
} from "../../types/adPackBlacklist";
import type { AdPackBlacklistWriteDiskMessage } from "../../types/diskIO/messages";
import { postWithTransport } from "../diskIO/businessWrite";
import { assertStorageAdmission } from "../diskIO/storageAdmission";
import { canQueueDiskIOBusiness } from "../diskIO/transport";
import { logger } from "../logger";
import {
  adPackBlacklistCacheKey,
  adPackBlacklistRowSource,
  assertAdPackBlacklistTarget,
  notifyAdPackBlacklistObserver,
  readAdPackBlacklistStates,
} from "./read";

/** 批量新增广告包黑名单条目的入参。 */
export interface AddAdPackBlacklistBatchOptions {
  /** 待新增进贴纸包黑名单的合法 short name 列表。 */
  readonly stickerPacks: readonly string[];
  /** 待新增进自定义表情包黑名单的合法 short name 列表。 */
  readonly emojiPacks: readonly string[];
}

/**
 * 批量新增前逐项校验包名合法性并按首次出现顺序去重。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param candidates 待新增的原始包名列表。
 * @returns 全部通过校验且去重后的包名列表。
 */
function normalizeUniqueBatchPacks(
  kind: AdPackBlacklistKind,
  candidates: readonly string[]
): readonly string[] {
  const unique: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const pack of candidates) {
    if (seen.has(pack)) continue;
    assertAdPackBlacklistPack(pack, adPackBlacklistRowSource(kind, pack));
    seen.add(pack);
    unique.push(pack);
  }
  return unique;
}

/**
 * 登记一条未 ACK 写入并按差额更新总条数与估算字节（同时记录最终意图 `blacklisted` 供重放与冷读覆盖）。
 *
 * @param message 已分配 revision 的广告包黑名单写入消息。
 */
function trackUnacknowledged(message: AdPackBlacklistWriteDiskMessage): void {
  const pendingByKind: Map<string, UnacknowledgedAdPackBlacklistWrite> =
    unacknowledgedAdPackBlacklistWrites[message.kind];
  const previous: UnacknowledgedAdPackBlacklistWrite | undefined = pendingByKind.get(message.pack);
  const bytes: number = storageWriteCost(null, message.pack);
  pendingByKind.set(message.pack, {
    blacklisted: message.blacklisted,
    revision: message.revision,
    bytes,
  });
  if (previous === undefined) unacknowledgedAdPackBlacklistTotals.entries++;
  unacknowledgedAdPackBlacklistTotals.bytes += bytes - (previous?.bytes ?? 0);
}

/**
 * 发布前校验未确认写入预算与 Disk I/O 业务队列准入（调用方须先完成主键合法性校验）。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 目标包名 short name。
 * @param blacklisted `true` 表示写入黑名单，`false` 表示删除。
 * @returns 通过准入检查的广告包黑名单落盘消息。
 */
function prepareAdPackBlacklistWrite(
  kind: AdPackBlacklistKind,
  pack: string,
  blacklisted: boolean
): AdPackBlacklistWriteDiskMessage {
  const revision: number = nextAdPackBlacklistRevision.current + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new Error("Ad pack blacklist revision space is exhausted.");
  }
  const previous: UnacknowledgedAdPackBlacklistWrite | undefined =
    unacknowledgedAdPackBlacklistWrites[kind].get(pack);
  const bytes: number = storageWriteCost(null, pack);
  assertStorageAdmission(
    unacknowledgedAdPackBlacklistTotals.entries + (previous === undefined ? 1 : 0),
    unacknowledgedAdPackBlacklistTotals.bytes + bytes - (previous?.bytes ?? 0)
  );
  const message: AdPackBlacklistWriteDiskMessage = {
    type: "adPackBlacklistWrite",
    kind,
    pack,
    blacklisted,
    revision,
  };
  if (!canQueueDiskIOBusiness(message)) {
    throw new Error("Disk I/O refused ad pack blacklist state publication.");
  }
  return message;
}

/**
 * 推进 revision、登记未 ACK 写入并投递给 Disk I/O Worker；投递失败只记日志，由重建重放补齐。
 *
 * @param message 待投递的广告包黑名单落盘消息。
 */
function queueAdPackBlacklistWrite(message: AdPackBlacklistWriteDiskMessage): void {
  nextAdPackBlacklistRevision.current = message.revision;
  trackUnacknowledged(message);
  if (!postWithTransport(message)) {
    logger.error(
      "Failed to queue ad pack blacklist write; retaining revision for replay.",
      {
        kind: message.kind,
        pack: message.pack,
        blacklisted: message.blacklisted,
        revision: message.revision,
      }
    );
  }
}

/**
 * 重投某主键仍未 ACK 的当前最终值（沿用既有 revision 与意图，不依赖 LRU 驻留，不新建 revision）。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 目标包名 short name。
 * @returns 存在未 ACK 写入（已尝试补投）时返回 `true`，无未 ACK 写入时返回 `false`。
 */
export function requeueUnacknowledgedAdPackBlacklistWrite(
  kind: AdPackBlacklistKind,
  pack: string
): boolean {
  const pending: UnacknowledgedAdPackBlacklistWrite | undefined =
    unacknowledgedAdPackBlacklistWrites[kind].get(pack);
  if (pending === undefined) return false;
  const posted: boolean = postWithTransport({
    type: "adPackBlacklistWrite",
    kind,
    pack,
    blacklisted: pending.blacklisted,
    revision: pending.revision,
  } satisfies AdPackBlacklistWriteDiskMessage);
  if (!posted) {
    logger.error(
      "Failed to re-queue ad pack blacklist write.",
      { kind, pack, blacklisted: pending.blacklisted, revision: pending.revision }
    );
  }
  return true;
}

/**
 * 在写串行链内新增一条广告包黑名单记录（冷缺失先打 SQLite 核实去重与计数），不设条数硬上限，
 * 写入 768 LRU 热缓存、递增计数并向观察者同步最新条数。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 待拉黑的包名 short name。
 * @returns 新增成功返回 `"added"`，原已存在返回 `"exists"`。
 */
export async function addAdPackBlacklistEntry(
  kind: AdPackBlacklistKind,
  pack: string
): Promise<"added" | "exists"> {
  assertAdPackBlacklistTarget(kind, pack);
  return await runSerialChain(adPackBlacklistMutationChain, async (): Promise<"added" | "exists"> => {
    const states: ReadonlyMap<string, boolean> = await readAdPackBlacklistStates(kind, [pack]);
    if (states.get(pack) === true) return "exists";
    const message: AdPackBlacklistWriteDiskMessage = prepareAdPackBlacklistWrite(kind, pack, true);
    adPackBlacklistCache.set(adPackBlacklistCacheKey(kind, pack), true);
    adPackBlacklistCounts[kind]++;
    queueAdPackBlacklistWrite(message);
    notifyAdPackBlacklistObserver();
    return "added";
  });
}

/**
 * 在写串行链内移除一条广告包黑名单记录（冷缺失先打 SQLite 核实存在性与计数），
 * 将 768 LRU 覆写为负缓存 `false`、递减计数并向观察者同步最新条数。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 待移除的包名 short name。
 * @returns 调用前存在并已移除返回 `true`，原不存在返回 `false`。
 */
export async function removeAdPackBlacklistEntry(
  kind: AdPackBlacklistKind,
  pack: string
): Promise<boolean> {
  assertAdPackBlacklistTarget(kind, pack);
  return await runSerialChain(adPackBlacklistMutationChain, async (): Promise<boolean> => {
    const states: ReadonlyMap<string, boolean> = await readAdPackBlacklistStates(kind, [pack]);
    if (states.get(pack) !== true) return false;
    const message: AdPackBlacklistWriteDiskMessage = prepareAdPackBlacklistWrite(kind, pack, false);
    adPackBlacklistCache.set(adPackBlacklistCacheKey(kind, pack), false);
    if (adPackBlacklistCounts[kind] > 0) adPackBlacklistCounts[kind]--;
    queueAdPackBlacklistWrite(message);
    notifyAdPackBlacklistObserver();
    return true;
  });
}

/**
 * 在写串行链内批量新增广告包黑名单条目：先全量校验并去重全部候选包名（任一非法立即 fail-closed 抛错且不改状态），
 * 批量核对冷缺失并跳过已存在项，不设单类条数硬上限，全部变更结束后统一向观察者广播一次最新条数。
 *
 * @param options 待新增的贴纸包与自定义表情包 short name 列表。
 * @returns 实际新增进两类黑名单的包名统计。
 */
export async function addAdPackBlacklistBatch({
  stickerPacks,
  emojiPacks,
}: AddAdPackBlacklistBatchOptions): Promise<AdPackBlacklistBatchAddResult> {
  const uniqueStickerPacks: readonly string[] = normalizeUniqueBatchPacks("sticker", stickerPacks);
  const uniqueEmojiPacks: readonly string[] = normalizeUniqueBatchPacks("emoji", emojiPacks);
  if (uniqueStickerPacks.length === 0 && uniqueEmojiPacks.length === 0) {
    return { addedStickerPacks: [], addedEmojiPacks: [] };
  }
  return await runSerialChain(
    adPackBlacklistMutationChain,
    async (): Promise<AdPackBlacklistBatchAddResult> => {
      const addedStickerPacks: string[] = [];
      const addedEmojiPacks: string[] = [];
      const groups: readonly (readonly [
        AdPackBlacklistKind,
        readonly string[],
        string[]
      ])[] = [
        ["sticker", uniqueStickerPacks, addedStickerPacks],
        ["emoji", uniqueEmojiPacks, addedEmojiPacks],
      ];
      try {
        for (const [kind, candidates, added] of groups) {
          if (candidates.length === 0) continue;
          const states: ReadonlyMap<string, boolean> = await readAdPackBlacklistStates(
            kind,
            candidates
          );
          for (const pack of candidates) {
            if (states.get(pack) === true) continue;
            const message: AdPackBlacklistWriteDiskMessage = prepareAdPackBlacklistWrite(
              kind,
              pack,
              true
            );
            adPackBlacklistCache.set(adPackBlacklistCacheKey(kind, pack), true);
            adPackBlacklistCounts[kind]++;
            queueAdPackBlacklistWrite(message);
            added.push(pack);
          }
        }
      } finally {
        if (addedStickerPacks.length > 0 || addedEmojiPacks.length > 0) {
          notifyAdPackBlacklistObserver();
        }
      }
      return {
        addedStickerPacks,
        addedEmojiPacks,
      };
    }
  );
}
