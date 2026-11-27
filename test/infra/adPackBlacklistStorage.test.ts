/**
 * `packages/infra/adPackBlacklistStorage.ts` 主线程 768 LRU 读缓存 + SQLite 持久化测试：
 * 覆盖 hydrate 计数、正/负命中缓存、冷缺失分块落库、超出 768 淘汰并回退 SQLite 命中、
 * 游标冷读分页/搜索不污染 768 LRU、无硬上限单条与批量增删、观察者计数通知、
 * 持久化确认（含未确认重复操作的 revision 补投）、精确 revision ACK、
 * 准入拒收 / revision 耗尽防护以及 768 淘汰后 Worker 重建仍能按 revision 升序完整重放。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AD_PACK_BLACKLIST_PAGE_SIZE,
  AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES,
  AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import type {
  AdPackBlacklistCounts,
  AdPackBlacklistKind,
  AdPackBlacklistPage,
} from "../../packages/types/adPackBlacklist";
import type {
  AdPackBlacklistWriteDiskMessage,
  DiskBusinessMessage,
  DiskIORecoveryTransport,
  DiskIORespawnListener,
} from "../../packages/types/diskIO/messages";
import type {
  AdPackBlacklistPersistedRevision,
  DiskIODomain,
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO/replies";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import { loggerStub } from "../helpers/loggerMock";

const posted: DiskBusinessMessage[] = [];
const errorLogs: unknown[][] = [];
let acceptDiskPost: boolean = true;
let flushResult: DomainFlushOutcome = { result: "flushed" };
let acknowledgeOnFlush: boolean = true;
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
let respawnListener: DiskIORespawnListener | undefined;

const backingStore: Readonly<Record<AdPackBlacklistKind, Set<string>>> = {
  sticker: new Set<string>(),
  emoji: new Set<string>(),
};

const readAdPackBlacklistsMock = mock(async (
  kind: AdPackBlacklistKind,
  packs: readonly string[]
): Promise<readonly string[]> => {
  const rows: ReadonlySet<string> = backingStore[kind];
  return packs.filter((pack: string): boolean => rows.has(pack));
});

const readAdPackBlacklistPageMock = mock(async (
  kind: AdPackBlacklistKind,
  afterPack: string | null
): Promise<AdPackBlacklistPage> => {
  const sorted: string[] = [...backingStore[kind]]
    .filter((pack: string): boolean => afterPack === null || pack > afterPack)
    .sort((left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0));
  const packs: string[] = sorted.slice(0, AD_PACK_BLACKLIST_PAGE_SIZE);
  return {
    packs,
    nextCursor: packs.length === 0 ? afterPack : packs[packs.length - 1]!,
    done: sorted.length <= AD_PACK_BLACKLIST_PAGE_SIZE,
  };
});

const flushDiskIODomain = mock(async (domain: DiskIODomain): Promise<DomainFlushOutcome> => {
  if (domain === "adPackBlacklist" && flushResult.result === "flushed" && acknowledgeOnFlush) {
    const writes: AdPackBlacklistPersistedRevision[] = [];
    for (const message of posted) {
      if (message.type !== "adPackBlacklistWrite") continue;
      writes.push({ kind: message.kind, pack: message.pack, revision: message.revision });
      if (message.blacklisted) {
        backingStore[message.kind].add(message.pack);
      } else {
        backingStore[message.kind].delete(message.pack);
      }
    }
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryAdBypassWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
        adPackBlacklistWrites: writes,
        removalWrites: [],
      });
    }
  }
  return flushResult;
});

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  isDiskIOInitialized: (): boolean => true,
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    posted.push(message);
    return acceptDiskPost;
  },
  readAdPackBlacklists: readAdPackBlacklistsMock,
  readAdPackBlacklistPage: readAdPackBlacklistPageMock,
  flushDiskIODomain,
  onDiskIOReply: diskIOReplyStub({
    identityStoragePersisted: (listener: (reply: IdentityStoragePersistedReply) => void): void => {
      persistedListeners.push(listener);
    },
  }),
  onDiskIORespawn: (_owner: string, _priority: number, listener: DiskIORespawnListener): void => {
    respawnListener = listener;
  },
  relayLogMessage: (): boolean => true,
})));

mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({
    error: (...args: unknown[]): void => { errorLogs.push(args); },
  }),
}));

const {
  adPackBlacklistCache,
  adPackBlacklistObserver,
  nextAdPackBlacklistRevision,
  resetAdPackBlacklistCache,
  unacknowledgedAdPackBlacklistTotals,
  unacknowledgedAdPackBlacklistWrites,
} = await import("../../packages/cache/main/adPackBlacklist");
const { diskIORuntime } = await import("../../packages/cache/main/diskIO");
const {
  addAdPackBlacklistBatch,
  addAdPackBlacklistEntry,
  confirmAdPackBlacklistPersisted,
  findFirstBlacklistedAdPack,
  flushAdPackBlacklistWrites,
  getAdPackBlacklistCount,
  getAdPackBlacklistCounts,
  hydrateAdPackBlacklistCounts,
  listAdPackBlacklistPage,
  peekCachedAdPackBlacklist,
  persistAdPackBlacklistAdd,
  persistAdPackBlacklistRemove,
  readAdPackBlacklistStates,
  registerAdPackBlacklistObserver,
  removeAdPackBlacklistEntry,
} = await import("../../packages/infra/adPackBlacklistStorage");

const observed: AdPackBlacklistCounts[] = [];
let savedObserver: typeof adPackBlacklistObserver.current = null;

beforeEach((): void => {
  posted.length = 0;
  errorLogs.length = 0;
  observed.length = 0;
  backingStore.sticker.clear();
  backingStore.emoji.clear();
  acceptDiskPost = true;
  flushResult = { result: "flushed" };
  acknowledgeOnFlush = true;
  flushDiskIODomain.mockClear();
  readAdPackBlacklistsMock.mockClear();
  readAdPackBlacklistPageMock.mockClear();
  diskIORuntime.fatalSignaled = false;
  resetAdPackBlacklistCache();
  savedObserver = adPackBlacklistObserver.current;
  registerAdPackBlacklistObserver((counts: Readonly<AdPackBlacklistCounts>): void => {
    observed.push({ ...counts });
  });
});

afterEach((): void => {
  diskIORuntime.fatalSignaled = false;
  registerAdPackBlacklistObserver(savedObserver);
  resetAdPackBlacklistCache();
});

describe("adPackBlacklistStorage 768 LRU 读缓存与 SQLite 持久化", () => {
  test("hydrateAdPackBlacklistCounts 重置缓存与未确认写入，计数短路零条冷读", async () => {
    await addAdPackBlacklistEntry("sticker", "OldPack");
    expect(unacknowledgedAdPackBlacklistTotals.entries).toBe(1);

    hydrateAdPackBlacklistCounts({ sticker: 0, emoji: 0 });
    readAdPackBlacklistsMock.mockClear();
    expect(unacknowledgedAdPackBlacklistTotals).toEqual({ entries: 0, bytes: 0 });
    expect(adPackBlacklistCache.size).toBe(0);
    expect(getAdPackBlacklistCounts()).toEqual({ sticker: 0, emoji: 0 });

    // 计数为 0 时直接短路，不打 Disk I/O。
    expect(await findFirstBlacklistedAdPack("sticker", ["AnyPack"])).toBeNull();
    expect(readAdPackBlacklistsMock).not.toHaveBeenCalled();

    backingStore.sticker.add("ColdPack");
    hydrateAdPackBlacklistCounts({ sticker: 1, emoji: 0 });
    expect(peekCachedAdPackBlacklist("sticker", "ColdPack")).toBeUndefined();
    expect(await findFirstBlacklistedAdPack("sticker", ["MissingPack", "ColdPack"])).toBe("ColdPack");
    expect(readAdPackBlacklistsMock).toHaveBeenCalledTimes(1);
    expect(peekCachedAdPackBlacklist("sticker", "ColdPack")).toBeTrue();
    expect(peekCachedAdPackBlacklist("sticker", "MissingPack")).toBeFalse();

    // 二次查询直接命中 768 LRU（含正/负缓存），不再访问 SQLite。
    readAdPackBlacklistsMock.mockClear();
    expect(await findFirstBlacklistedAdPack("sticker", ["MissingPack", "ColdPack"])).toBe("ColdPack");
    expect(await findFirstBlacklistedAdPack("sticker", ["MissingPack"])).toBeNull();
    expect(readAdPackBlacklistsMock).not.toHaveBeenCalled();
  });

  test("写入超过 768 条不再报错，内存封顶在 768 LRU，淘汰条目冷读仍可从 SQLite 命中", async () => {
    const totalCount: number = AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES + 40;
    const packs: string[] = Array.from(
      { length: totalCount },
      (_u: unknown, index: number): string => `Sticker_${String(index).padStart(4, "0")}`
    );

    const batchResult = await addAdPackBlacklistBatch({
      stickerPacks: packs,
      emojiPacks: ["Emoji_OK"],
    });
    expect(batchResult.addedStickerPacks).toHaveLength(totalCount);
    expect(batchResult.addedEmojiPacks).toEqual(["Emoji_OK"]);
    expect(getAdPackBlacklistCount("sticker")).toBe(totalCount);
    expect(getAdPackBlacklistCount("emoji")).toBe(1);
    expect(adPackBlacklistCache.size).toBe(AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES);
    expect(observed).toEqual([{ sticker: totalCount, emoji: 1 }]);

    // 提交到模拟 SQLite 后，最早写入的 Sticker_0000 已被 768 LRU 淘汰，但查询仍回落 SQLite 命中。
    expect(await flushAdPackBlacklistWrites()).toBeTrue();
    expect(peekCachedAdPackBlacklist("sticker", "Sticker_0000")).toBeUndefined();

    readAdPackBlacklistsMock.mockClear();
    const matched: string | null = await findFirstBlacklistedAdPack("sticker", ["NotInDb", "Sticker_0000"]);
    expect(matched).toBe("Sticker_0000");
    expect(readAdPackBlacklistsMock).toHaveBeenCalledTimes(1);
    expect(peekCachedAdPackBlacklist("sticker", "Sticker_0000")).toBeTrue();
    expect(adPackBlacklistCache.size).toBe(AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES);
  });

  test("单次冷读超过分块阈值时按 AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES 拆分请求", async () => {
    const queryCount: number = AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES + 10;
    const queryPacks: string[] = Array.from(
      { length: queryCount },
      (_u: unknown, index: number): string => `ChunkPack_${index}`
    );
    backingStore.sticker.add("ChunkPack_0");
    backingStore.sticker.add(`ChunkPack_${queryCount - 1}`);
    hydrateAdPackBlacklistCounts({ sticker: 2, emoji: 0 });

    const states: ReadonlyMap<string, boolean> = await readAdPackBlacklistStates("sticker", queryPacks);
    expect(readAdPackBlacklistsMock).toHaveBeenCalledTimes(2);
    expect(states.get("ChunkPack_0")).toBeTrue();
    expect(states.get(`ChunkPack_${queryCount - 1}`)).toBeTrue();
    expect(states.get("ChunkPack_5")).toBeFalse();
  });

  test("listAdPackBlacklistPage 游标分页与搜索不污染 768 LRU，且叠加未确认增删", async () => {
    for (let index: number = 0; index < 30; index++) {
      backingStore.sticker.add(`Alpha_${String(index).padStart(2, "0")}`);
    }
    hydrateAdPackBlacklistCounts({ sticker: 30, emoji: 0 });
    expect(adPackBlacklistCache.size).toBe(0);

    const page2 = await listAdPackBlacklistPage({
      kind: "sticker",
      page: 2,
      pageSize: 10,
      clampPage: false,
    });
    expect(page2).toEqual({
      packs: Array.from({ length: 10 }, (_u: unknown, i: number): string => `Alpha_${String(i + 10).padStart(2, "0")}`),
      page: 2,
      pageSize: 10,
      total: 30,
      totalPages: 3,
      kindTotal: 30,
      outOfRange: false,
    });
    // 游标冷读后 768 LRU 仍为空，避免大列表分页/搜索挤出热判定缓存。
    expect(adPackBlacklistCache.size).toBe(0);

    const outOfRange = await listAdPackBlacklistPage({
      kind: "sticker",
      page: 9,
      pageSize: 10,
      clampPage: false,
    });
    expect(outOfRange.outOfRange).toBeTrue();
    expect(outOfRange.packs).toEqual([]);

    const searched = await listAdPackBlacklistPage({
      kind: "sticker",
      page: 1,
      pageSize: 10,
      query: "alpha_2",
      clampPage: true,
    });
    expect(searched.total).toBe(10);
    expect(searched.packs[0]).toBe("Alpha_20");
    expect(adPackBlacklistCache.size).toBe(0);
  });

  test("单条增删校验合法性、回落 SQLite 判重/删除、触发观察者且两类独立计数", async () => {
    await expect(addAdPackBlacklistEntry("sticker", "bad-pack")).rejects.toThrow("valid Telegram sticker pack short name");
    await expect(removeAdPackBlacklistEntry("emoji", " bad ")).rejects.toThrow("valid Telegram sticker pack short name");
    expect(posted).toHaveLength(0);
    expect(observed).toHaveLength(0);

    expect(await addAdPackBlacklistEntry("sticker", "Pack_1")).toBe("added");
    expect(await addAdPackBlacklistEntry("sticker", "Pack_1")).toBe("exists");
    expect(observed).toEqual([{ sticker: 1, emoji: 0 }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "adPackBlacklistWrite",
      kind: "sticker",
      pack: "Pack_1",
      blacklisted: true,
    });

    expect(await removeAdPackBlacklistEntry("sticker", "Missing")).toBeFalse();
    expect(await removeAdPackBlacklistEntry("sticker", "Pack_1")).toBeTrue();
    expect(observed).toEqual([
      { sticker: 1, emoji: 0 },
      { sticker: 0, emoji: 0 },
    ]);
    expect(posted[1]).toMatchObject({
      type: "adPackBlacklistWrite",
      kind: "sticker",
      pack: "Pack_1",
      blacklisted: false,
    });

    // 冷存储中已存在的包：add 识别为 exists，remove 识别并递减计数。
    backingStore.emoji.add("ColdEmoji");
    hydrateAdPackBlacklistCounts({ sticker: 0, emoji: 1 });
    expect(await addAdPackBlacklistEntry("emoji", "ColdEmoji")).toBe("exists");
    expect(await removeAdPackBlacklistEntry("emoji", "ColdEmoji")).toBeTrue();
    expect(getAdPackBlacklistCount("emoji")).toBe(0);
  });

  test("批量新增遇到非法包名在任意变更前 fail-closed 抛错，不留部分状态、队列写入或观察者通知", async () => {
    const initialRevision: number = nextAdPackBlacklistRevision.current;

    await expect(addAdPackBlacklistBatch({
      stickerPacks: ["ValidSticker_1", "bad-pack"],
      emojiPacks: ["ValidEmoji_1"],
    })).rejects.toThrow("valid Telegram sticker pack short name");
    expect(getAdPackBlacklistCount("sticker")).toBe(0);
    expect(getAdPackBlacklistCount("emoji")).toBe(0);
    expect(posted).toHaveLength(0);
    expect(observed).toHaveLength(0);
    expect(unacknowledgedAdPackBlacklistTotals).toEqual({ entries: 0, bytes: 0 });
    expect(nextAdPackBlacklistRevision.current).toBe(initialRevision);

    await expect(addAdPackBlacklistBatch({
      stickerPacks: ["ValidSticker_1"],
      emojiPacks: ["ValidEmoji_1", "bad emoji"],
    })).rejects.toThrow("valid Telegram sticker pack short name");
    expect(peekCachedAdPackBlacklist("sticker", "ValidSticker_1")).toBeUndefined();
    expect(peekCachedAdPackBlacklist("emoji", "ValidEmoji_1")).toBeUndefined();
    expect(posted).toHaveLength(0);
    expect(observed).toHaveLength(0);
    expect(unacknowledgedAdPackBlacklistTotals).toEqual({ entries: 0, bytes: 0 });
    expect(nextAdPackBlacklistRevision.current).toBe(initialRevision);
  });

  test("persistAdPackBlacklistAdd/Remove 确认落盘；重复操作遇到未确认旧 revision 时补投并收敛", async () => {
    acceptDiskPost = false;
    flushResult = { result: "failed", failedDomains: ["adPackBlacklist"] };
    const first = await persistAdPackBlacklistAdd("sticker", "RetryPack");
    expect(first).toEqual({ changed: true, persisted: false });
    const pendingRevision: number = unacknowledgedAdPackBlacklistWrites.sticker.get("RetryPack")!.revision;
    expect(posted).toHaveLength(1);
    expect(errorLogs.length).toBeGreaterThanOrEqual(2);

    acceptDiskPost = true;
    flushResult = { result: "flushed" };
    const retry = await persistAdPackBlacklistAdd("sticker", "RetryPack");
    expect(retry).toEqual({ changed: false, persisted: true });
    expect(posted).toHaveLength(2);
    expect((posted[1] as AdPackBlacklistWriteDiskMessage).revision).toBe(pendingRevision);
    expect(unacknowledgedAdPackBlacklistWrites.sticker.has("RetryPack")).toBeFalse();

    flushDiskIODomain.mockClear();
    expect(await persistAdPackBlacklistAdd("sticker", "RetryPack")).toEqual({
      changed: false,
      persisted: true,
    });
    expect(flushDiskIODomain).not.toHaveBeenCalled();

    acknowledgeOnFlush = false;
    const firstRemove = await persistAdPackBlacklistRemove("sticker", "RetryPack");
    expect(firstRemove).toEqual({ changed: true, persisted: false });
    const deleteRevision: number = unacknowledgedAdPackBlacklistWrites.sticker.get("RetryPack")!.revision;

    acknowledgeOnFlush = true;
    const retryRemove = await persistAdPackBlacklistRemove("sticker", "RetryPack");
    expect(retryRemove).toEqual({ changed: false, persisted: true });
    expect((posted.at(-1) as AdPackBlacklistWriteDiskMessage)).toEqual({
      type: "adPackBlacklistWrite",
      kind: "sticker",
      pack: "RetryPack",
      blacklisted: false,
      revision: deleteRevision,
    });
    expect(unacknowledgedAdPackBlacklistWrites.sticker.has("RetryPack")).toBeFalse();
  });

  test("精确 ACK 才销账，迟到旧 ACK 不清更新 revision；flushAdPackBlacklistWrites 验证全部目标收敛", async () => {
    await addAdPackBlacklistEntry("emoji", "Pack_A");
    const rev1: number = unacknowledgedAdPackBlacklistWrites.emoji.get("Pack_A")!.revision;
    await removeAdPackBlacklistEntry("emoji", "Pack_A");
    const rev2: number = unacknowledgedAdPackBlacklistWrites.emoji.get("Pack_A")!.revision;

    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryAdBypassWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
        adPackBlacklistWrites: [{ kind: "emoji", pack: "Pack_A", revision: rev1 }],
        removalWrites: [],
      });
    }
    expect(unacknowledgedAdPackBlacklistWrites.emoji.get("Pack_A")?.revision).toBe(rev2);
    expect(unacknowledgedAdPackBlacklistTotals.entries).toBe(1);

    acknowledgeOnFlush = false;
    expect(await flushAdPackBlacklistWrites()).toBeFalse();
    expect(await confirmAdPackBlacklistPersisted("emoji", "Pack_A")).toBeFalse();

    acknowledgeOnFlush = true;
    expect(await flushAdPackBlacklistWrites()).toBeTrue();
    expect(unacknowledgedAdPackBlacklistTotals).toEqual({ entries: 0, bytes: 0 });
  });

  test("准入拒收与 revision 空间耗尽在修改内存前失败，不留下脏状态", async () => {
    diskIORuntime.fatalSignaled = true;
    await expect(addAdPackBlacklistEntry("sticker", "BlockedByGate")).rejects.toThrow(
      "Disk I/O refused ad pack blacklist state publication."
    );
    expect(peekCachedAdPackBlacklist("sticker", "BlockedByGate")).not.toBeTrue();
    expect(unacknowledgedAdPackBlacklistWrites.sticker.has("BlockedByGate")).toBeFalse();
    expect(getAdPackBlacklistCount("sticker")).toBe(0);
    expect(observed).toHaveLength(0);

    diskIORuntime.fatalSignaled = false;
    nextAdPackBlacklistRevision.current = Number.MAX_SAFE_INTEGER;
    await expect(addAdPackBlacklistEntry("sticker", "Exhausted")).rejects.toThrow(
      "revision space is exhausted"
    );
    expect(peekCachedAdPackBlacklist("sticker", "Exhausted")).not.toBeTrue();
    expect(unacknowledgedAdPackBlacklistWrites.sticker.has("Exhausted")).toBeFalse();
    expect(getAdPackBlacklistCount("sticker")).toBe(0);
    expect(observed).toHaveLength(0);
  });

  test("未确认写入被 768 LRU 淘汰后，Worker 重建仍按 revision 升序重放精确最终值，投递被拒立即返回 false", async () => {
    await addAdPackBlacklistEntry("sticker", "Pack_A");
    await addAdPackBlacklistEntry("emoji", "Emoji_B");
    await removeAdPackBlacklistEntry("sticker", "Pack_A");

    // 主动塞满 768 LRU 挤出 Pack_A 与 Emoji_B 的缓存槽，验证重放与未确认读视图均不依赖 LRU 驻留。
    for (let index: number = 0; index < AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES + 5; index++) {
      adPackBlacklistCache.set(`sticker:Filler_${index}`, false);
    }
    expect(adPackBlacklistCache.peek("sticker:Pack_A")).toBeUndefined();
    expect(adPackBlacklistCache.peek("emoji:Emoji_B")).toBeUndefined();
    expect(peekCachedAdPackBlacklist("sticker", "Pack_A")).toBeFalse();
    expect(peekCachedAdPackBlacklist("emoji", "Emoji_B")).toBeTrue();

    const replayed: AdPackBlacklistWriteDiskMessage[] = [];
    const transport: DiskIORecoveryTransport = {
      post: (message: DiskBusinessMessage): boolean => {
        replayed.push(message as AdPackBlacklistWriteDiskMessage);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("unused");
      },
    };
    expect(respawnListener?.(transport)).toBeTrue();
    expect(replayed).toEqual([
      {
        type: "adPackBlacklistWrite",
        kind: "emoji",
        pack: "Emoji_B",
        blacklisted: true,
        revision: unacknowledgedAdPackBlacklistWrites.emoji.get("Emoji_B")!.revision,
      },
      {
        type: "adPackBlacklistWrite",
        kind: "sticker",
        pack: "Pack_A",
        blacklisted: false,
        revision: unacknowledgedAdPackBlacklistWrites.sticker.get("Pack_A")!.revision,
      },
    ]);

    const rejectingTransport: DiskIORecoveryTransport = {
      post: (): boolean => false,
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("unused");
      },
    };
    expect(respawnListener?.(rejectingTransport)).toBeFalse();
  });

  test("多游标页冷读在夹紧模式下若扫描期间实际条数收缩，回退返回真实的最后一页且不污染 768 LRU", async () => {
    const seeded: string[] = [];
    for (let index: number = 0; index < AD_PACK_BLACKLIST_PAGE_SIZE + 14; index++) {
      const pack: string = `Pack_${String(index).padStart(4, "0")}`;
      seeded.push(pack);
      backingStore.sticker.add(pack);
    }
    // 模拟计数高估（如多游标页扫描前发生并发删除）：请求页码 15 超出实际 14 页
    hydrateAdPackBlacklistCounts({ sticker: AD_PACK_BLACKLIST_PAGE_SIZE + 40, emoji: 0 });
    const slice = await listAdPackBlacklistPage({
      kind: "sticker",
      page: 15,
      pageSize: 20,
      clampPage: true,
    });
    expect(slice.total).toBe(seeded.length);
    expect(slice.totalPages).toBe(14);
    expect(slice.page).toBe(14);
    expect(slice.outOfRange).toBeFalse();
    expect(slice.packs).toEqual(seeded.slice(260));
    expect(adPackBlacklistCache.size).toBe(0);
  });
});
