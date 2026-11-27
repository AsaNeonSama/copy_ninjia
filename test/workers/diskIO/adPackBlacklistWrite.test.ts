/**
 * Disk I/O Worker 广告包黑名单（`ad_pack_blacklists`）读写闸测试：
 * 覆盖缓冲写入与迟到旧 revision 忽略、无硬上限大规模落盘与恢复计数、
 * `readAdPackBlacklists` 批量存在性冷读与未提交写入叠加、`readAdPackBlacklistPage` 游标分页与未提交叠加、
 * `storageFlushHold` 延后提交、入参严格校验、事务提交精确 ACK 及满批自动提交。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  AD_PACK_BLACKLIST_PAGE_SIZE,
  AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES,
  AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES,
  AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
import {
  pendingAdPackBlacklistEntryCount,
  pendingAdPackBlacklistWrites,
  resetStorageDatabaseCache,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  handleAdPackBlacklistWrite,
  readAdPackBlacklistPage,
  readAdPackBlacklists,
} from "../../../packages/workers/diskIO/storageDatabase/adPackBlacklist";
import { requireStorageDatabase } from "../../../packages/workers/diskIO/storageDatabase/context";
import { flushStorageDatabase } from "../../../packages/workers/diskIO/storageDatabase/flush";
import { setStorageFlushHold } from "../../../packages/workers/diskIO/storageDatabase/flushHold";
import type {
  AdPackBlacklistKind,
  AdPackBlacklistPage,
} from "../../../packages/types/adPackBlacklist";
import type { AdPackBlacklistWriteDiskMessage } from "../../../packages/types/diskIO/messages";
import type {
  AdPackBlacklistPersistedRevision,
  IdentityStoragePersistedReply,
} from "../../../packages/types/diskIO/replies";
import { clearStorageBusinessTables } from "../../../scripts/fixtures/storageDatabase";
import { hydrateStorageDatabase } from "../../helpers/storageDatabaseHydration";

const noReply: () => void = (): void => {};

interface BlacklistWriteFixtureOptions {
  readonly kind: AdPackBlacklistKind;
  readonly pack: string;
  readonly blacklisted: boolean;
  readonly revision: number;
}

function blacklistWrite({
  kind,
  pack,
  blacklisted,
  revision,
}: BlacklistWriteFixtureOptions): AdPackBlacklistWriteDiskMessage {
  return {
    type: "adPackBlacklistWrite",
    kind,
    pack,
    blacklisted,
    revision,
  };
}

function stickerWrite(pack: string, blacklisted: boolean, revision: number): AdPackBlacklistWriteDiskMessage {
  return blacklistWrite({ kind: "sticker", pack, blacklisted, revision });
}

function emojiWrite(pack: string, blacklisted: boolean, revision: number): AdPackBlacklistWriteDiskMessage {
  return blacklistWrite({ kind: "emoji", pack, blacklisted, revision });
}

beforeEach((): void => {
  resetStorageDatabaseCache();
  hydrateStorageDatabase();
  clearStorageBusinessTables(requireStorageDatabase());
});

describe("Disk I/O Worker 的广告包黑名单读写闸", () => {
  test("收下最终值并按 (kind, pack) 进缓冲，同一主键覆写不重复计条数", () => {
    handleAdPackBlacklistWrite(stickerWrite("SpamPack_1", true, 1), noReply);
    expect(pendingAdPackBlacklistWrites.sticker.get("SpamPack_1")).toEqual({
      blacklisted: true,
      revision: 1,
    });
    expect(pendingAdPackBlacklistEntryCount.current).toBe(1);

    handleAdPackBlacklistWrite(stickerWrite("SpamPack_1", false, 2), noReply);
    expect(pendingAdPackBlacklistWrites.sticker.get("SpamPack_1")).toEqual({
      blacklisted: false,
      revision: 2,
    });
    expect(pendingAdPackBlacklistEntryCount.current).toBe(1);
  });

  test("迟到的旧 revision 写入不得覆盖更新的最终值", () => {
    handleAdPackBlacklistWrite(emojiWrite("SpamEmoji_1", true, 5), noReply);
    handleAdPackBlacklistWrite(emojiWrite("SpamEmoji_1", false, 3), noReply);
    handleAdPackBlacklistWrite(emojiWrite("SpamEmoji_1", false, 5), noReply);

    expect(pendingAdPackBlacklistWrites.emoji.get("SpamEmoji_1")).toEqual({
      blacklisted: true,
      revision: 5,
    });
  });

  test("不再设单类硬上限：写入超过 768 内存缓存容量的记录可落盘并准确恢复计数", () => {
    const totalStickers: number = AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES + 32;
    for (let index: number = 0; index < totalStickers; index++) {
      handleAdPackBlacklistWrite(stickerWrite(`Sticker_${index}`, true, index + 1), noReply);
    }
    handleAdPackBlacklistWrite(emojiWrite("EmojiAllowed", true, totalStickers + 1), noReply);
    expect(flushStorageDatabase(noReply)).toBeTrue();

    resetStorageDatabaseCache();
    expect(hydrateStorageDatabase().adPackBlacklistCounts).toEqual({
      sticker: totalStickers,
      emoji: 1,
    });
  });

  test("storageFlushHold 期间延后满批自动提交，解除后随事务一并落盘", () => {
    const acknowledged: AdPackBlacklistPersistedRevision[] = [];
    const reply = (persisted: IdentityStoragePersistedReply): void => {
      acknowledged.push(...persisted.adPackBlacklistWrites);
    };

    setStorageFlushHold(true, reply);
    for (let index: number = 0; index < AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES + 5; index++) {
      handleAdPackBlacklistWrite(stickerWrite(`HoldPack_${index}`, true, index + 1), reply);
    }
    expect(acknowledged).toHaveLength(0);
    expect(pendingAdPackBlacklistEntryCount.current).toBe(
      AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES + 5
    );

    expect(setStorageFlushHold(false, reply)).toBeNull();
    expect(acknowledged).toHaveLength(AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES + 5);
    expect(pendingAdPackBlacklistEntryCount.current).toBe(0);
  });

  test("readAdPackBlacklists 合并 SQLite 已提交行与未提交写入视图，并拒绝超块与非法参数", () => {
    handleAdPackBlacklistWrite(stickerWrite("Committed_A", true, 1), noReply);
    handleAdPackBlacklistWrite(stickerWrite("Committed_Removed", true, 2), noReply);
    handleAdPackBlacklistWrite(emojiWrite("Committed_A", true, 3), noReply);
    expect(flushStorageDatabase(noReply)).toBeTrue();

    // 未提交缓冲：新增 Pending_Add、删除 Committed_Removed。
    handleAdPackBlacklistWrite(stickerWrite("Pending_Add", true, 4), noReply);
    handleAdPackBlacklistWrite(stickerWrite("Committed_Removed", false, 5), noReply);

    expect(
      readAdPackBlacklists({
        type: "readAdPackBlacklists",
        requestId: 1,
        kind: "sticker",
        packs: ["Committed_A", "Committed_Removed", "Pending_Add", "Unknown_Pack", "Committed_A"],
      })
    ).toEqual({
      type: "adPackBlacklistsRead",
      requestId: 1,
      matchedPacks: ["Committed_A", "Pending_Add"],
    });

    expect(
      readAdPackBlacklists({
        type: "readAdPackBlacklists",
        requestId: 2,
        kind: "emoji",
        packs: ["Committed_A", "Pending_Add"],
      })
    ).toEqual({
      type: "adPackBlacklistsRead",
      requestId: 2,
      matchedPacks: ["Committed_A"],
    });

    expect(
      readAdPackBlacklists({
        type: "readAdPackBlacklists",
        requestId: 3,
        kind: "sticker",
        packs: [],
      })
    ).toEqual({
      type: "adPackBlacklistsRead",
      requestId: 3,
      matchedPacks: [],
    });

    const oversized: string[] = Array.from(
      { length: AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES + 1 },
      (_u: unknown, index: number): string => `Over_${index}`
    );
    expect(
      readAdPackBlacklists({
        type: "readAdPackBlacklists",
        requestId: 4,
        kind: "sticker",
        packs: oversized,
      })
    ).toEqual({
      type: "adPackBlacklistsRead",
      requestId: 4,
      error: expect.stringContaining(`at most ${AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES} packs`),
    });
  });

  test("readAdPackBlacklistPage 按 ASCII 游标分页读取并叠加未提交增删", () => {
    const committedCount: number = AD_PACK_BLACKLIST_PAGE_SIZE + 5;
    for (let index: number = 0; index < committedCount; index++) {
      const padded: string = String(index).padStart(4, "0");
      handleAdPackBlacklistWrite(stickerWrite(`Pack_${padded}`, true, index + 1), noReply);
    }
    expect(flushStorageDatabase(noReply)).toBeTrue();

    // 删掉第一页内的 Pack_0001，同时新增一条落在第一页游标窗口前的 Pack_0000_A 与一条在末尾之后的 Pack_9999。
    handleAdPackBlacklistWrite(stickerWrite("Pack_0001", false, 10_000), noReply);
    handleAdPackBlacklistWrite(stickerWrite("Pack_0000_A", true, 10_001), noReply);
    handleAdPackBlacklistWrite(stickerWrite("Pack_9999", true, 10_002), noReply);

    const firstReply = readAdPackBlacklistPage({
      type: "readAdPackBlacklistPage",
      requestId: 10,
      kind: "sticker",
      afterPack: null,
    });
    expect(firstReply.error).toBeUndefined();
    const firstPage: AdPackBlacklistPage = firstReply.page!;
    expect(firstPage.done).toBeFalse();
    expect(firstPage.packs).toHaveLength(AD_PACK_BLACKLIST_PAGE_SIZE);
    expect(firstPage.packs.slice(0, 3)).toEqual(["Pack_0000", "Pack_0000_A", "Pack_0002"]);
    expect(firstPage.packs).not.toContain("Pack_0001");
    expect(firstPage.nextCursor).toBe(firstPage.packs.at(-1)!);

    const secondReply = readAdPackBlacklistPage({
      type: "readAdPackBlacklistPage",
      requestId: 11,
      kind: "sticker",
      afterPack: firstPage.nextCursor,
    });
    expect(secondReply.error).toBeUndefined();
    const secondPage: AdPackBlacklistPage = secondReply.page!;
    expect(secondPage.done).toBeTrue();
    expect(secondPage.packs).toHaveLength(6);
    expect(secondPage.packs.at(-1)).toBe("Pack_9999");
    expect(secondPage.nextCursor).toBe("Pack_9999");

    const allCollected: string[] = [...firstPage.packs, ...secondPage.packs];
    expect(allCollected).toHaveLength(committedCount - 1 + 2);
  });

  test("非法 kind、非法 pack、非布尔 blacklisted 与非法 revision 一律拒绝", () => {
    expect(() =>
      handleAdPackBlacklistWrite(
        { type: "adPackBlacklistWrite", kind: "invalid" as AdPackBlacklistKind, pack: "Pack_1", blacklisted: true, revision: 1 },
        noReply
      )
    ).toThrow('"sticker" or "emoji"');
    expect(() =>
      handleAdPackBlacklistWrite(stickerWrite("bad-pack", true, 1), noReply)
    ).toThrow("valid Telegram sticker pack short name");
    expect(() =>
      handleAdPackBlacklistWrite(stickerWrite(" Pack_1", true, 1), noReply)
    ).toThrow("valid Telegram sticker pack short name");
    expect(() =>
      handleAdPackBlacklistWrite(
        { type: "adPackBlacklistWrite", kind: "sticker", pack: "Pack_1", blacklisted: "yes" as unknown as boolean, revision: 1 },
        noReply
      )
    ).toThrow("a boolean");
    expect(() =>
      handleAdPackBlacklistWrite(stickerWrite("Pack_1", true, 0), noReply)
    ).toThrow("positive safe integer");
  });

  test("提交后清空缓冲、带精确 (kind, pack, revision) ACK 且重启 hydrate 可恢复计数", () => {
    handleAdPackBlacklistWrite(stickerWrite("SpamSticker_1", true, 4), noReply);
    handleAdPackBlacklistWrite(emojiWrite("SpamEmoji_1", true, 5), noReply);
    const acknowledged: AdPackBlacklistPersistedRevision[] = [];

    expect(flushStorageDatabase((reply: IdentityStoragePersistedReply): void => {
      acknowledged.push(...reply.adPackBlacklistWrites);
    })).toBeTrue();

    expect(acknowledged).toEqual([
      { kind: "sticker", pack: "SpamSticker_1", revision: 4 },
      { kind: "emoji", pack: "SpamEmoji_1", revision: 5 },
    ]);
    expect(pendingAdPackBlacklistEntryCount.current).toBe(0);

    resetStorageDatabaseCache();
    expect(hydrateStorageDatabase().adPackBlacklistCounts).toEqual({
      sticker: 1,
      emoji: 1,
    });
  });

  test("跨两类累计到 AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES 条变化立即提交整批", () => {
    const acknowledged: AdPackBlacklistPersistedRevision[] = [];
    const reply = (persisted: IdentityStoragePersistedReply): void => {
      acknowledged.push(...persisted.adPackBlacklistWrites);
    };
    for (let index: number = 0; index < AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES - 1; index++) {
      const kind: AdPackBlacklistKind = index % 2 === 0 ? "sticker" : "emoji";
      handleAdPackBlacklistWrite(
        blacklistWrite({ kind, pack: `BatchPack_${index}`, blacklisted: true, revision: index + 1 }),
        reply
      );
    }
    // 覆盖已有键不重复计入批次计数。
    handleAdPackBlacklistWrite(stickerWrite("BatchPack_0", false, 999), reply);
    expect(pendingAdPackBlacklistEntryCount.current).toBe(
      AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES - 1
    );
    expect(acknowledged).toHaveLength(0);

    handleAdPackBlacklistWrite(emojiWrite("FinalPack", true, 1_000), reply);
    expect(acknowledged).toHaveLength(AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES);
    expect(pendingAdPackBlacklistEntryCount.current).toBe(0);
    expect(pendingAdPackBlacklistWrites.sticker.size).toBe(0);
    expect(pendingAdPackBlacklistWrites.emoji.size).toBe(0);
  });
});
