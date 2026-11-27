/**
 * 主线程广告包黑名单持久化门面：对外收敛 768 LRU 热读、SQLite 冷读分页、串行化写入、落盘确认屏障以及 Disk I/O 精确 ACK 销账与重建重放。
 * 热读与查库位于 `adPackBlacklistStorage/read.ts`，不污染 LRU 的游标冷读位于 `adPackBlacklistStorage/page.ts`，串行写入位于 `adPackBlacklistStorage/write.ts`。
 */

import {
  unacknowledgedAdPackBlacklistTotals,
  unacknowledgedAdPackBlacklistWrites,
} from "../cache/main/adPackBlacklist";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import { AD_PACK_BLACKLIST_KINDS } from "../consts/identityStorage";
import type {
  AdPackBlacklistKind,
  AdPackBlacklistPersistResult,
  UnacknowledgedAdPackBlacklistWrite,
} from "../types/adPackBlacklist";
import type {
  AdPackBlacklistWriteDiskMessage,
  DiskIORecoveryTransport,
} from "../types/diskIO/messages";
import type {
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../types/diskIO/replies";
import * as diskIO from "./diskIO";
import { describeFlushFailure, postWithTransport } from "./diskIO/businessWrite";
import { logger } from "./logger";
import { assertAdPackBlacklistTarget } from "./adPackBlacklistStorage/read";
import {
  addAdPackBlacklistEntry,
  removeAdPackBlacklistEntry,
  requeueUnacknowledgedAdPackBlacklistWrite,
} from "./adPackBlacklistStorage/write";

export {
  findFirstBlacklistedAdPack,
  getAdPackBlacklistCount,
  getAdPackBlacklistCounts,
  hydrateAdPackBlacklistCounts,
  peekCachedAdPackBlacklist,
  readAdPackBlacklistStates,
  registerAdPackBlacklistObserver,
} from "./adPackBlacklistStorage/read";
export type {
  AdPackBlacklistPageSlice,
  ListAdPackBlacklistPageOptions,
} from "./adPackBlacklistStorage/page";
export {
  listAdPackBlacklistPage,
} from "./adPackBlacklistStorage/page";
export type { AddAdPackBlacklistBatchOptions } from "./adPackBlacklistStorage/write";
export {
  addAdPackBlacklistBatch,
  addAdPackBlacklistEntry,
  removeAdPackBlacklistEntry,
} from "./adPackBlacklistStorage/write";

/** 待按 revision 升序重放或复核的未确认广告包黑名单写入条目。 */
interface QueuedAdPackBlacklistWrite {
  /** 黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: AdPackBlacklistKind;
  /** 目标包名 short name。 */
  readonly pack: string;
  /** 本条写入分配的单调递增 revision。 */
  readonly revision: number;
}

/**
 * 等待已校验 `(kind, pack)` 当前未确认的最终值写入 SQLite 并收到精确 revision ACK。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 目标包名 short name。
 * @param retryUnacknowledged 为 `true` 时先向 Disk I/O Worker 补投尚未确认的同一 revision。
 * @returns 无未确认写入或已确认落盘返回 `true`，刷盘失败或未收到 ACK 时记录错误日志并返回 `false`。
 */
async function confirmValidatedAdPackBlacklistPersisted(
  kind: AdPackBlacklistKind,
  pack: string,
  retryUnacknowledged: boolean
): Promise<boolean> {
  const pending: UnacknowledgedAdPackBlacklistWrite | undefined =
    unacknowledgedAdPackBlacklistWrites[kind].get(pack);
  if (pending === undefined) return true;
  if (retryUnacknowledged) requeueUnacknowledgedAdPackBlacklistWrite(kind, pack);
  const outcome: DomainFlushOutcome = await diskIO.flushDiskIODomain("adPackBlacklist");
  if (outcome.result !== "flushed") {
    logger.error(
      "Ad pack blacklist write was not persisted to disk.",
      {
        kind,
        pack,
        revision: pending.revision,
        result: outcome.result,
        detail: describeFlushFailure(outcome),
      }
    );
    return false;
  }
  if (unacknowledgedAdPackBlacklistWrites[kind].get(pack)?.revision === pending.revision) {
    logger.error(
      "Persistence Worker did not acknowledge ad pack blacklist write.",
      { kind, pack, revision: pending.revision }
    );
    return false;
  }
  return true;
}

/**
 * 等待指定 `(kind, pack)` 当前未确认的最终值写入 SQLite 并收到精确 revision ACK。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 目标包名 short name。
 * @param retryUnacknowledged 为 `true` 时先向 Disk I/O Worker 补投尚未确认的同一 revision。
 * @returns 无未确认写入或已确认落盘返回 `true`，刷盘失败或未收到 ACK 时记录错误日志并返回 `false`。
 */
export async function confirmAdPackBlacklistPersisted(
  kind: AdPackBlacklistKind,
  pack: string,
  retryUnacknowledged: boolean = false
): Promise<boolean> {
  assertAdPackBlacklistTarget(kind, pack);
  return await confirmValidatedAdPackBlacklistPersisted(kind, pack, retryUnacknowledged);
}

/**
 * 刷新 `"adPackBlacklist"` 落盘领域并核验调用时刻的全部未确认广告包黑名单写入均已收到 ACK。
 *
 * @returns 无待确认写入或全部目标 revision 均已确认落盘时返回 `true`，否则返回 `false`。
 */
export async function flushAdPackBlacklistWrites(): Promise<boolean> {
  const pendingTargets: QueuedAdPackBlacklistWrite[] = [];
  for (const kind of AD_PACK_BLACKLIST_KINDS) {
    for (const [pack, pending] of unacknowledgedAdPackBlacklistWrites[kind]) {
      pendingTargets.push({ kind, pack, revision: pending.revision });
    }
  }
  if (pendingTargets.length === 0) return true;
  const outcome: DomainFlushOutcome = await diskIO.flushDiskIODomain("adPackBlacklist");
  if (outcome.result !== "flushed") return false;
  for (const target of pendingTargets) {
    if (
      unacknowledgedAdPackBlacklistWrites[target.kind].get(target.pack)?.revision ===
      target.revision
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 新增一条广告包黑名单记录并等待 `"adPackBlacklist"` 领域落盘确认；若原已存在但仍有未确认写入，
 * 会补投既有 revision 并等待其落盘确认。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 待拉黑的包名 short name。
 * @returns 是否改变了黑名单成员状态以及目标 revision 是否已确认落盘。
 */
export async function persistAdPackBlacklistAdd(
  kind: AdPackBlacklistKind,
  pack: string
): Promise<AdPackBlacklistPersistResult> {
  const changed: boolean = (await addAdPackBlacklistEntry(kind, pack)) === "added";
  const persisted: boolean = await confirmValidatedAdPackBlacklistPersisted(kind, pack, !changed);
  return { changed, persisted };
}

/**
 * 移除一条广告包黑名单记录并等待 `"adPackBlacklist"` 领域落盘确认；若原不存在但仍有未确认删除，
 * 会补投既有 revision 并等待其落盘确认。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param pack 待移除的包名 short name。
 * @returns 是否改变了黑名单成员状态以及目标 revision 是否已确认落盘。
 */
export async function persistAdPackBlacklistRemove(
  kind: AdPackBlacklistKind,
  pack: string
): Promise<AdPackBlacklistPersistResult> {
  const changed: boolean = await removeAdPackBlacklistEntry(kind, pack);
  const persisted: boolean = await confirmValidatedAdPackBlacklistPersisted(kind, pack, !changed);
  return { changed, persisted };
}

/**
 * 收到精确 ACK 后清除对应未确认 revision 并释放字节预算；迟到的旧 ACK 不得清掉更新的写入。
 *
 * @param reply Disk I/O Worker 返回的身份存储持久化回执。
 */
function settleAdPackBlacklistWrites(reply: IdentityStoragePersistedReply): void {
  for (const write of reply.adPackBlacklistWrites) {
    const pendingByKind: Map<string, UnacknowledgedAdPackBlacklistWrite> =
      unacknowledgedAdPackBlacklistWrites[write.kind];
    const pending: UnacknowledgedAdPackBlacklistWrite | undefined = pendingByKind.get(write.pack);
    if (pending?.revision === write.revision) {
      pendingByKind.delete(write.pack);
      unacknowledgedAdPackBlacklistTotals.entries--;
      unacknowledgedAdPackBlacklistTotals.bytes -= pending.bytes;
    }
  }
}

/**
 * Disk I/O Worker 重建后按 revision 升序重放全部未确认的广告包黑名单最终值（直接读取未 ACK 表中的最终意图，不依赖 LRU 驻留）。
 *
 * @param transport 新一代 Disk I/O Worker 的恢复期投递通道。
 * @returns 全部未确认写入均成功投递时返回 `true`，中途投递失败时返回 `false`。
 */
function replayAdPackBlacklistWrites(transport: DiskIORecoveryTransport): boolean {
  const writes: QueuedAdPackBlacklistWrite[] = [];
  for (const kind of AD_PACK_BLACKLIST_KINDS) {
    for (const [pack, pending] of unacknowledgedAdPackBlacklistWrites[kind]) {
      writes.push({ kind, pack, revision: pending.revision });
    }
  }
  writes.sort(
    (left: QueuedAdPackBlacklistWrite, right: QueuedAdPackBlacklistWrite): number =>
      left.revision - right.revision
  );
  for (const write of writes) {
    const current: UnacknowledgedAdPackBlacklistWrite | undefined =
      unacknowledgedAdPackBlacklistWrites[write.kind].get(write.pack);
    if (current?.revision !== write.revision) continue;
    if (
      !postWithTransport(
        {
          type: "adPackBlacklistWrite",
          kind: write.kind,
          pack: write.pack,
          blacklisted: current.blacklisted,
          revision: write.revision,
        } satisfies AdPackBlacklistWriteDiskMessage,
        transport
      )
    ) {
      return false;
    }
  }
  return true;
}

diskIO.onDiskIOReply("identityStoragePersisted", settleAdPackBlacklistWrites);
diskIO.onDiskIORespawn(
  "ad pack blacklist",
  DISK_IO_RESPAWN_PRIORITIES.AD_PACK_BLACKLIST,
  replayAdPackBlacklistWrites
);
