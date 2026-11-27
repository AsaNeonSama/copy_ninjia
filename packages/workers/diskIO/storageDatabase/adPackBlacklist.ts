/**
 * 广告包黑名单（`ad_pack_blacklists`）在共享 SQLite 中的写入入队与叠加未提交缓冲的批量/游标分页读取接口（Disk I/O Worker 侧）。
 */
import {
  pendingAdPackBlacklistEntryCount,
  pendingAdPackBlacklistWrites,
  storagePendingBudgets,
} from "../../../cache/workers/diskIO/storageDatabase";
import {
  AD_PACK_BLACKLIST_PAGE_PENDING_DELTA_MAX_ENTRIES,
  AD_PACK_BLACKLIST_PAGE_SIZE,
  AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES,
} from "../../../consts/identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import {
  assertAdPackBlacklistKind,
  assertAdPackBlacklistPack,
} from "../../../database/codec/adPackBlacklist";
import {
  readStoredAdPackBlacklistMatches,
  readStoredAdPackBlacklistPage,
} from "../../../database/interact/adPackBlacklist";
import { errorMessage } from "../../../libs/errorMessage";
import { invalidInput } from "../../../libs/inputValidation";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
import type {
  AdPackBlacklistKind,
  AdPackBlacklistPage,
  PendingAdPackBlacklistWrite,
} from "../../../types/adPackBlacklist";
import type {
  AdPackBlacklistWriteDiskMessage,
  ReadAdPackBlacklistPageRequest,
  ReadAdPackBlacklistsRequest,
} from "../../../types/diskIO/messages";
import type {
  AdPackBlacklistPageReadReply,
  AdPackBlacklistsReadReply,
  IdentityPersistenceReply,
} from "../../../types/diskIO/replies";
import type { StorageDatabaseReader } from "../../../types/storageDatabase";
import {
  assertPositiveRevision,
  requireStorageDatabase,
  requireStorageDatabaseReader,
  storageSource,
} from "./context";
import { flushIfStorageFull } from "./flush";

/**
 * 按 ASCII 字典序升序比较两个包名。
 *
 * @param left 左侧包名。
 * @param right 右侧包名。
 * @returns 升序比较结果（`-1`、`0` 或 `1`）。
 */
function comparePackNamesAscending(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 校验并接收一条广告包黑名单写入或删除，不设条数硬上限，按 `(kind, pack)` 覆写进事务缓冲。
 *
 * @param message 广告包黑名单写入或删除请求消息。
 * @param reply 向主线程发送持久化回执的出口。
 */
export function handleAdPackBlacklistWrite(
  message: AdPackBlacklistWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  const rowSource: string = storageSource(
    "ad_pack_blacklists",
    `${String(message.kind)}:${String(message.pack)}`
  );
  assertAdPackBlacklistKind(message.kind, rowSource);
  assertAdPackBlacklistPack(message.pack, rowSource);
  if (typeof message.blacklisted !== "boolean") {
    invalidInput(rowSource, "$.blacklisted", "a boolean");
  }
  assertPositiveRevision(message.revision, rowSource);

  const pendingByKind: Map<string, PendingAdPackBlacklistWrite> =
    pendingAdPackBlacklistWrites[message.kind];
  const current: PendingAdPackBlacklistWrite | undefined = pendingByKind.get(message.pack);
  if (current !== undefined && current.revision >= message.revision) return;

  storagePendingBudgets.adPackBlacklist.reserve(
    current === undefined ? 1 : 0,
    current === undefined ? storageWriteCost(null, message.pack) : 0
  );
  pendingByKind.set(message.pack, {
    blacklisted: message.blacklisted,
    revision: message.revision,
  });
  if (current === undefined) pendingAdPackBlacklistEntryCount.current++;
  flushIfStorageFull(reply);
}

/**
 * 批量读取指定种类下给定包名集合中处于有效黑名单状态（已提交叠加未提交变更）的包名列表。
 *
 * @param message 批量读取广告包黑名单请求消息。
 * @returns 包含命中包名列表或错误信息的应答消息。
 */
export function readAdPackBlacklists(
  message: ReadAdPackBlacklistsRequest
): AdPackBlacklistsReadReply {
  try {
    const source: string = `${IDENTITY_DATABASE_PATH}:readAdPackBlacklists`;
    assertAdPackBlacklistKind(message.kind, source);
    const uniquePacks: readonly string[] = message.packs.length <= 1
      ? message.packs
      : [...new Set<string>(message.packs)];
    if (uniquePacks.length > AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES) {
      throw new Error(
        `Ad pack blacklist reads accept at most ${AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES} packs.`
      );
    }
    for (const pack of uniquePacks) {
      assertAdPackBlacklistPack(pack, source);
    }
    if (uniquePacks.length === 0) {
      return {
        type: "adPackBlacklistsRead",
        requestId: message.requestId,
        matchedPacks: [],
      };
    }
    const pendingByKind: Map<string, PendingAdPackBlacklistWrite> =
      pendingAdPackBlacklistWrites[message.kind];
    const reader: StorageDatabaseReader = requireStorageDatabaseReader();
    if (uniquePacks.length === 1) {
      const pack: string = uniquePacks[0]!;
      const pending: PendingAdPackBlacklistWrite | undefined = pendingByKind.get(pack);
      if (pending !== undefined) {
        return {
          type: "adPackBlacklistsRead",
          requestId: message.requestId,
          matchedPacks: pending.blacklisted ? [pack] : [],
        };
      }
      return {
        type: "adPackBlacklistsRead",
        requestId: message.requestId,
        matchedPacks: readStoredAdPackBlacklistMatches(reader, message.kind, uniquePacks),
      };
    }
    const storedMatches: readonly string[] =
      readStoredAdPackBlacklistMatches(reader, message.kind, uniquePacks);
    if (pendingByKind.size === 0) {
      return {
        type: "adPackBlacklistsRead",
        requestId: message.requestId,
        matchedPacks: storedMatches,
      };
    }
    const matched: Set<string> = new Set<string>(storedMatches);
    for (const pack of uniquePacks) {
      const pending: PendingAdPackBlacklistWrite | undefined = pendingByKind.get(pack);
      if (pending === undefined) continue;
      if (pending.blacklisted) matched.add(pack);
      else matched.delete(pack);
    }
    return {
      type: "adPackBlacklistsRead",
      requestId: message.requestId,
      matchedPacks: [...matched],
    };
  } catch (error: unknown) {
    return {
      type: "adPackBlacklistsRead",
      requestId: message.requestId,
      error: errorMessage(error),
    };
  }
}

/**
 * 读取一页已提交的广告黑名单包名并叠加同种类事务缓冲中的未提交变更。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param afterPack 游标起点（不含），首屏传 `null`。
 * @returns 叠加未提交变更后的包名分页结果。
 */
function effectiveAdPackBlacklistPage(
  kind: AdPackBlacklistKind,
  afterPack: string | null
): AdPackBlacklistPage {
  const pendingWrites: Map<string, PendingAdPackBlacklistWrite> =
    pendingAdPackBlacklistWrites[kind];
  if (pendingWrites.size > AD_PACK_BLACKLIST_PAGE_PENDING_DELTA_MAX_ENTRIES) {
    throw new Error(
      `Pending ad pack blacklist ${kind} delta exceeds ${AD_PACK_BLACKLIST_PAGE_PENDING_DELTA_MAX_ENTRIES} entries; ` +
      "refusing to expand a blacklist page."
    );
  }
  const storedPacks: readonly string[] = readStoredAdPackBlacklistPage(
    requireStorageDatabase(),
    kind,
    { afterPack, limit: AD_PACK_BLACKLIST_PAGE_SIZE + pendingWrites.size + 1 }
  );
  const candidates: Set<string> = new Set<string>();
  for (const pack of storedPacks) {
    if (pendingWrites.get(pack)?.blacklisted !== false) candidates.add(pack);
  }
  for (const [pack, pending] of pendingWrites) {
    if (pending.blacklisted && (afterPack === null || pack > afterPack)) {
      candidates.add(pack);
    }
  }
  const ordered: string[] = [...candidates].sort(comparePackNamesAscending);
  const done: boolean = ordered.length <= AD_PACK_BLACKLIST_PAGE_SIZE;
  const packs: string[] = done ? ordered : ordered.slice(0, AD_PACK_BLACKLIST_PAGE_SIZE);
  return {
    packs,
    nextCursor: packs.length === 0 ? afterPack : packs[packs.length - 1]!,
    done,
  };
}

/**
 * 读取一页有界广告黑名单包名并叠加尚未提交的最终值（供命令分页与 Mini App 列表/搜索使用）。
 *
 * @param message 广告包黑名单分页读取请求消息。
 * @returns 包含包名分页结果或错误信息的应答消息。
 */
export function readAdPackBlacklistPage(
  message: ReadAdPackBlacklistPageRequest
): AdPackBlacklistPageReadReply {
  try {
    const source: string = `${IDENTITY_DATABASE_PATH}:readAdPackBlacklistPage`;
    assertAdPackBlacklistKind(message.kind, source);
    if (message.afterPack !== null) {
      assertAdPackBlacklistPack(message.afterPack, `${source}.afterPack`);
    }
    return {
      type: "adPackBlacklistPageRead",
      requestId: message.requestId,
      page: effectiveAdPackBlacklistPage(message.kind, message.afterPack),
    };
  } catch (error: unknown) {
    return {
      type: "adPackBlacklistPageRead",
      requestId: message.requestId,
      error: errorMessage(error),
    };
  }
}
