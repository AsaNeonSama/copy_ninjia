/**
 * `packages/antiRaid/adBlacklistPersistence.ts` 主线程自动拉黑写回测试：
 * 覆盖 SQLite `ad_pack_blacklists` 持久化与 `"adPackBlacklist"` 领域刷盘、
 * 观察者实时同步 Anti-Raid Worker 计数、去重与非法包名过滤、排除机器人自身 `stickers.json` 贴纸包、
 * 无硬上限写入与 768 LRU 内存上限，以及落盘失败或准入拒绝时的降级日志语义。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AD_PACK_BLACKLIST_PAGE_SIZE,
  AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import type {
  AdPackBlacklistCounts,
  AdPackBlacklistKind,
  AdPackBlacklistPage,
} from "../../packages/types/adPackBlacklist";
import type { DiskBusinessMessage } from "../../packages/types/diskIO/messages";
import type {
  AdPackBlacklistPersistedRevision,
  DiskIODomain,
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO/replies";
import type { StickerConfig } from "../../packages/types/config";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import { loggerStub } from "../helpers/loggerMock";

const infoLogs: unknown[][] = [];
const warnLogs: unknown[][] = [];
const errorLogs: unknown[][] = [];
const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
let flushOutcome: DomainFlushOutcome = { result: "flushed" };
let acknowledgeOnFlush: boolean = true;

const backingStore: Readonly<Record<AdPackBlacklistKind, Set<string>>> = {
  sticker: new Set<string>(),
  emoji: new Set<string>(),
};

const flushDiskIODomain = mock(async (domain: DiskIODomain): Promise<DomainFlushOutcome> => {
  if (domain === "adPackBlacklist" && flushOutcome.result === "flushed" && acknowledgeOnFlush) {
    const writes: AdPackBlacklistPersistedRevision[] = [];
    for (const message of diskMessages) {
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
  return flushOutcome;
});

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  isDiskIOInitialized: (): boolean => true,
  onDiskIOReply: diskIOReplyStub({
    identityStoragePersisted: (listener: (reply: IdentityStoragePersistedReply) => void): void => {
      persistedListeners.push(listener);
    },
  }),
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskMessages.push(message);
    return true;
  },
  readAdPackBlacklists: async (
    kind: AdPackBlacklistKind,
    packs: readonly string[]
  ): Promise<readonly string[]> => {
    const rows: ReadonlySet<string> = backingStore[kind];
    return packs.filter((pack: string): boolean => rows.has(pack));
  },
  readAdPackBlacklistPage: async (
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
  },
  flushDiskIODomain,
  relayLogMessage: (): boolean => true,
})));

mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({
    info: (...args: unknown[]): void => { infoLogs.push(args); },
    warn: (...args: unknown[]): void => { warnLogs.push(args); },
    error: (...args: unknown[]): void => { errorLogs.push(args); },
  }),
}));

const { persistAutoBlacklistedAdPacks } = await import("../../packages/antiRaid/adBlacklistPersistence");
const {
  adPackBlacklistCache,
  adPackBlacklistObserver,
  resetAdPackBlacklistCache,
} = await import("../../packages/cache/main/adPackBlacklist");
const { diskIORuntime } = await import("../../packages/cache/main/diskIO");
const { defaultStickerConfigCache } = await import("../../packages/cache/perThread/config");
const { adoptStickerConfig } = await import("../../packages/config/stickers");
const {
  getAdPackBlacklistCounts,
  hydrateAdPackBlacklistCounts,
  peekCachedAdPackBlacklist,
  registerAdPackBlacklistObserver,
} = await import("../../packages/infra/adPackBlacklistStorage");

const observedCounts: AdPackBlacklistCounts[] = [];
let savedStickerCache: StickerConfig | null = null;
let savedObserver: typeof adPackBlacklistObserver.current = null;

function seedBlacklists(
  stickerPacks: readonly string[],
  emojiPacks: readonly string[]
): void {
  backingStore.sticker.clear();
  backingStore.emoji.clear();
  for (const pack of stickerPacks) backingStore.sticker.add(pack);
  for (const pack of emojiPacks) backingStore.emoji.add(pack);
  hydrateAdPackBlacklistCounts({
    sticker: backingStore.sticker.size,
    emoji: backingStore.emoji.size,
  });
}

function sortedBackingPacks(kind: AdPackBlacklistKind): readonly string[] {
  return [...backingStore[kind]].sort(
    (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
  );
}

beforeEach((): void => {
  infoLogs.length = 0;
  warnLogs.length = 0;
  errorLogs.length = 0;
  diskMessages.length = 0;
  observedCounts.length = 0;
  backingStore.sticker.clear();
  backingStore.emoji.clear();
  flushOutcome = { result: "flushed" };
  acknowledgeOnFlush = true;
  flushDiskIODomain.mockClear();
  resetAdPackBlacklistCache();
  savedStickerCache = defaultStickerConfigCache.current;
  savedObserver = adPackBlacklistObserver.current;
  adoptStickerConfig({ packs: ["BotOwnPack_1", "BotOwnPack_2"] });
  registerAdPackBlacklistObserver((counts: Readonly<AdPackBlacklistCounts>): void => {
    observedCounts.push({ ...counts });
  });
});

afterEach((): void => {
  diskIORuntime.fatalSignaled = false;
  defaultStickerConfigCache.current = savedStickerCache;
  registerAdPackBlacklistObserver(savedObserver);
  resetAdPackBlacklistCache();
});

describe("persistAutoBlacklistedAdPacks", () => {
  test("规范化、去重并过滤非法包名后写入权威存储、同步观察者计数并刷新 adPackBlacklist 领域", async () => {
    seedBlacklists(["ExistingSticker"], ["ExistingEmoji"]);

    await persistAutoBlacklistedAdPacks({
      stickerPacks: ["  SpamPack_A ", "SpamPack_A", "ExistingSticker", "bad-pack", "bad pack", "", "SpamPack_B"],
      emojiPacks: ["  EmojiAd_1 ", "EmojiAd_1", "ExistingEmoji", "invalid!name", "x".repeat(65)],
    });

    expect(sortedBackingPacks("sticker")).toEqual(["ExistingSticker", "SpamPack_A", "SpamPack_B"]);
    expect(sortedBackingPacks("emoji")).toEqual(["EmojiAd_1", "ExistingEmoji"]);
    expect(diskMessages.map((message: DiskBusinessMessage) => {
      if (message.type !== "adPackBlacklistWrite") throw new Error("Expected adPackBlacklistWrite.");
      return { kind: message.kind, pack: message.pack, blacklisted: message.blacklisted };
    })).toEqual([
      { kind: "sticker", pack: "SpamPack_A", blacklisted: true },
      { kind: "sticker", pack: "SpamPack_B", blacklisted: true },
      { kind: "emoji", pack: "EmojiAd_1", blacklisted: true },
    ]);
    expect(flushDiskIODomain).toHaveBeenCalledTimes(1);
    expect(flushDiskIODomain).toHaveBeenCalledWith("adPackBlacklist");
    expect(observedCounts).toEqual([{ sticker: 3, emoji: 2 }]);
    expect(warnLogs).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
    expect(infoLogs).toEqual([[
      "Auto-blacklisted ad packs.",
      {
        addedStickerPacks: ["SpamPack_A", "SpamPack_B"],
        addedEmojiPacks: ["EmojiAd_1"],
        persistedToDisk: true,
      },
    ]]);
  });

  test("排除机器人自身 stickers.json 配置的贴纸包并记告警，不影响合法表情包写入", async () => {
    await persistAutoBlacklistedAdPacks({
      stickerPacks: ["BotOwnPack_1", "ExternalSpamPack"],
      emojiPacks: ["BotOwnPack_1"],
    });

    expect(sortedBackingPacks("sticker")).toEqual(["ExternalSpamPack"]);
    expect(sortedBackingPacks("emoji")).toEqual(["BotOwnPack_1"]);
    expect(warnLogs).toEqual([[
      expect.stringContaining("Excluded bot's own configured sticker packs"),
      { excludedPacks: ["BotOwnPack_1"] },
    ]]);
  });

  test("全部候选已存在、全为非法或己方包时直接返回，不投递 Disk I/O 也不触发观察者", async () => {
    seedBlacklists(["AlreadyBlocked"], ["AlreadyBlockedEmoji"]);

    await persistAutoBlacklistedAdPacks({
      stickerPacks: ["AlreadyBlocked", "BotOwnPack_2", "invalid-name"],
      emojiPacks: ["AlreadyBlockedEmoji"],
    });

    expect(diskMessages).toHaveLength(0);
    expect(flushDiskIODomain).not.toHaveBeenCalled();
    expect(observedCounts).toHaveLength(0);
    expect(infoLogs).toHaveLength(0);
  });

  test("已有条目超过 768 内存缓存容量时自动拉黑仍无硬上限继续落盘，并保持 768 LRU 上界", async () => {
    const existingCount: number = AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES + 10;
    const existingStickers: string[] = Array.from(
      { length: existingCount },
      (_unused: unknown, index: number): string => `Sticker_${index}`
    );
    const existingEmojis: string[] = Array.from(
      { length: existingCount },
      (_unused: unknown, index: number): string => `Emoji_${index}`
    );
    seedBlacklists(existingStickers, existingEmojis);

    await persistAutoBlacklistedAdPacks({
      stickerPacks: ["NewUnlimitedSticker_1", "NewUnlimitedSticker_2"],
      emojiPacks: ["NewUnlimitedEmoji_1"],
    });

    expect(getAdPackBlacklistCounts()).toEqual({
      sticker: existingCount + 2,
      emoji: existingCount + 1,
    });
    expect(backingStore.sticker.has("NewUnlimitedSticker_1")).toBeTrue();
    expect(backingStore.sticker.has("NewUnlimitedSticker_2")).toBeTrue();
    expect(backingStore.emoji.has("NewUnlimitedEmoji_1")).toBeTrue();
    expect(adPackBlacklistCache.size).toBeLessThanOrEqual(AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES);
    expect(flushDiskIODomain).toHaveBeenCalledTimes(1);
    expect(observedCounts).toEqual([{ sticker: existingCount + 2, emoji: existingCount + 1 }]);
    expect(warnLogs).toHaveLength(0);
  });

  test("刷盘失败或缺少 ACK 时不抛错，保留缓存与观察者同步，并在日志里标明 persistedToDisk=false", async () => {
    flushOutcome = { result: "failed", failedDomains: ["adPackBlacklist"] };

    await persistAutoBlacklistedAdPacks({
      stickerPacks: ["MemoryOnlyPack_1"],
      emojiPacks: ["MemoryOnlyEmoji_1"],
    });

    expect(getAdPackBlacklistCounts()).toEqual({ sticker: 1, emoji: 1 });
    expect(peekCachedAdPackBlacklist("sticker", "MemoryOnlyPack_1")).toBeTrue();
    expect(peekCachedAdPackBlacklist("emoji", "MemoryOnlyEmoji_1")).toBeTrue();
    expect(observedCounts).toEqual([{ sticker: 1, emoji: 1 }]);
    expect(warnLogs).toHaveLength(1);
    expect(infoLogs).toEqual([[
      "Auto-blacklisted ad packs.",
      {
        addedStickerPacks: ["MemoryOnlyPack_1"],
        addedEmojiPacks: ["MemoryOnlyEmoji_1"],
        persistedToDisk: false,
      },
    ]]);
  });

  test("Disk I/O 拒收发布时记录告警并直接返回，不向调用方抛错", async () => {
    diskIORuntime.fatalSignaled = true;

    await persistAutoBlacklistedAdPacks({
      stickerPacks: ["RefusedPack"],
      emojiPacks: [],
    });

    expect(getAdPackBlacklistCounts().sticker).toBe(0);
    expect(observedCounts).toHaveLength(0);
    expect(flushDiskIODomain).not.toHaveBeenCalled();
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]?.[0]).toContain("failed to queue auto-blacklisted packs");
  });

  test("stickers.json 未配置时按原样放行贴纸包", async () => {
    adoptStickerConfig(null);
    await persistAutoBlacklistedAdPacks({
      stickerPacks: ["BotOwnPack_1"],
      emojiPacks: [],
    });

    expect(sortedBackingPacks("sticker")).toEqual(["BotOwnPack_1"]);
    expect(warnLogs).toHaveLength(0);
    expect(observedCounts).toEqual([{ sticker: 1, emoji: 0 }]);
  });
});
