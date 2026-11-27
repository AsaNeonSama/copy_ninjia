/**
 * Mini App 广告包黑名单（`GET|POST /api/ad-blacklists`）加密路由与视图层测试：
 * - 鉴权拦截（未认证 401）、会话密钥端到端加解密往返与 `?e=` 加密查询串；
 * - `GET /api/ad-blacklists` 默认参数、SQLite 游标冷读（不污染 768 LRU）、贴纸/表情分表计数、大小写不敏感子串搜索、页码夹紧、非法参数 `400` 与存储冷读失败 `503`；
 * - `POST /api/ad-blacklists` 严格键集与包名校验（`400`）、机器人自用贴纸包拦截（`409`，表情包放行、移除放行）、
 *   无硬上限写入超出 768 内存缓存容量（`200`）、新增/重复/移除/不存在（`200`）、Disk I/O 刷盘失败或准入拒绝（`503`）及 `logger.operation` 审计日志。
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  AD_PACK_BLACKLIST_PAGE_SIZE,
  AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import {
  MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH,
} from "../../packages/consts/miniApp/features";
import type {
  AdPackBlacklistKind,
  AdPackBlacklistPage,
} from "../../packages/types/adPackBlacklist";
import type { StickerConfig } from "../../packages/types/config";
import type { DiskBusinessMessage } from "../../packages/types/diskIO/messages";
import type {
  AdPackBlacklistPersistedRevision,
  DiskIODomain,
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO/replies";
import type {
  MiniAppAdBlacklistMutationResponse,
  MiniAppAdBlacklistsResponse,
} from "../../packages/types/miniApp/adBlacklists";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import {
  buildSuperAdminHeaders,
  ensureReusableTestSession,
} from "../helpers/miniAppInitData";

const postedMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
let acceptDiskPost: boolean = true;
let flushOutcome: DomainFlushOutcome = { result: "flushed" };
let acknowledgeOnFlush: boolean = true;
let failPageReadOnce: boolean = false;

const backingStore: Readonly<Record<AdPackBlacklistKind, Set<string>>> = {
  sticker: new Set<string>(),
  emoji: new Set<string>(),
};

mock.module("../../packages/infra/diskIO", () =>
  diskIOStub({
    isDiskIOInitialized: (): boolean => true,
    postDiskIO: (message: DiskBusinessMessage): boolean => {
      postedMessages.push(message);
      return acceptDiskPost;
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
      if (failPageReadOnce) {
        failPageReadOnce = false;
        throw new Error("sqlite page read failed");
      }
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
    flushDiskIODomain: async (domain: DiskIODomain): Promise<DomainFlushOutcome> => {
      if (
        domain === "adPackBlacklist" &&
        flushOutcome.result === "flushed" &&
        acknowledgeOnFlush
      ) {
        const queued: DiskBusinessMessage[] = postedMessages.splice(0, postedMessages.length);
        const adPackBlacklistWrites: AdPackBlacklistPersistedRevision[] = [];
        for (const message of queued) {
          if (message.type !== "adPackBlacklistWrite") continue;
          adPackBlacklistWrites.push({
            kind: message.kind,
            pack: message.pack,
            revision: message.revision,
          });
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
            adPackBlacklistWrites,
            removalWrites: [],
          });
        }
      }
      return flushOutcome;
    },
    onDiskIOReply: diskIOReplyStub({
      identityStoragePersisted: (
        listener: (reply: IdentityStoragePersistedReply) => void
      ): void => {
        persistedListeners.push(listener);
      },
    }),
    relayLogMessage: (): boolean => true,
  })
);

const {
  adPackBlacklistCache,
  resetAdPackBlacklistCache,
} = await import("../../packages/cache/main/adPackBlacklist");
const { diskIORuntime } = await import("../../packages/cache/main/diskIO");
const { miniAppAuthSessions } = await import("../../packages/cache/main/miniApp");
const { defaultStickerConfigCache } = await import(
  "../../packages/cache/perThread/config"
);
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { adoptStickerConfig } = await import("../../packages/config/stickers");
const {
  findFirstBlacklistedAdPack,
  hydrateAdPackBlacklistCounts,
} = await import("../../packages/infra/adPackBlacklistStorage");
const { logger } = await import("../../packages/infra/logger");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { mutateMiniAppAdBlacklist } = await import(
  "../../packages/mini-app-api-server/view/adBlacklists"
);
const {
  dispatchMiniAppTestRequest: handleMiniAppHttpRequest,
  dispatchRawMiniAppTestRequest,
} = await import("../helpers/miniAppRequest");

/**
 * 构造携带有效超级管理员 `initData` 与会话令牌的测试请求头。
 * @returns HTTP 请求头字典。
 */
function superAdminHeaders(): Record<string, string> {
  return buildSuperAdminHeaders({
    botToken: BOT_TOKEN,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    sessionToken: ensureReusableTestSession(issueMiniAppAuthSession).token,
    username: "super_admin",
  });
}

let savedStickerConfig: StickerConfig | null = null;

function seedAdPackBlacklists(seed: {
  readonly sticker: Iterable<string>;
  readonly emoji: Iterable<string>;
}): void {
  backingStore.sticker.clear();
  backingStore.emoji.clear();
  for (const pack of seed.sticker) backingStore.sticker.add(pack);
  for (const pack of seed.emoji) backingStore.emoji.add(pack);
  hydrateAdPackBlacklistCounts({
    sticker: backingStore.sticker.size,
    emoji: backingStore.emoji.size,
  });
}

beforeEach((): void => {
  savedStickerConfig = defaultStickerConfigCache.current;
  postedMessages.length = 0;
  backingStore.sticker.clear();
  backingStore.emoji.clear();
  acceptDiskPost = true;
  flushOutcome = { result: "flushed" };
  acknowledgeOnFlush = true;
  failPageReadOnce = false;
  diskIORuntime.fatalSignaled = false;
  resetAdPackBlacklistCache();
  adoptStickerConfig(null);
});

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  postedMessages.length = 0;
  backingStore.sticker.clear();
  backingStore.emoji.clear();
  acceptDiskPost = true;
  flushOutcome = { result: "flushed" };
  acknowledgeOnFlush = true;
  failPageReadOnce = false;
  diskIORuntime.fatalSignaled = false;
  resetAdPackBlacklistCache();
  adoptStickerConfig(savedStickerConfig);
  miniAppAuthSessions.clear();
});

describe("Mini App 广告包黑名单路由 GET|POST /api/ad-blacklists", () => {
  test("未携带鉴权头返回 401，且拒绝未加密查询串或明文 POST 请求体", async () => {
    const unauthGet: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/ad-blacklists")
    );
    expect(unauthGet.status).toBe(401);
    expect(((await unauthGet.json()) as { readonly code: string }).code).toBe(
      "MISSING_INIT_DATA"
    );

    const unauthPost: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/ad-blacklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "sticker", pack: "SpamPack", enabled: true }),
      })
    );
    expect(unauthPost.status).toBe(401);

    const plainQueryRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/ad-blacklists?kind=sticker", {
        headers: superAdminHeaders(),
      })
    );
    expect(plainQueryRes.status).toBe(400);

    const plainPostRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/ad-blacklists", {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "sticker", pack: "SpamPack", enabled: true }),
      })
    );
    expect(plainPostRes.status).toBe(400);
  });

  test("GET /api/ad-blacklists 支持默认参数、升序分页、页码夹紧、大小写不敏感子串搜索与两类总量统计", async () => {
    const numberedCount: number = MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE + 5;
    const padWidth: number = String(numberedCount).length;
    const firstNumberedPack: string = `SpamPack_${String(1).padStart(padWidth, "0")}`;
    const stickerSeed: string[] = [];
    for (let i: number = 1; i <= numberedCount; i += 1) {
      stickerSeed.push(`SpamPack_${String(i).padStart(padWidth, "0")}`);
    }
    stickerSeed.push("Promo_Alpha", "promo_beta");
    const expectedStickerTotal: number = stickerSeed.length;
    const expectedTotalPages: number = Math.ceil(
      expectedStickerTotal / MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE
    );
    const expectedLastPageItems: number =
      expectedStickerTotal -
      (expectedTotalPages - 1) * MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE;
    seedAdPackBlacklists({
      sticker: stickerSeed,
      emoji: ["EmojiSpam_B", "EmojiSpam_A", "EmojiPromo_1"],
    });

    const opSpy = spyOn(logger, "operation");
    try {
      // 1. 缺省参数：kind="sticker", page=1, pageSize=MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE, query=""
      const defaultRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          headers: superAdminHeaders(),
        })
      );
      expect(defaultRes.status).toBe(200);
      const defaultBody: MiniAppAdBlacklistsResponse =
        (await defaultRes.json()) as MiniAppAdBlacklistsResponse;
      expect(defaultBody.kind).toBe("sticker");
      expect(defaultBody.page).toBe(1);
      expect(defaultBody.pageSize).toBe(MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE);
      expect(defaultBody.total).toBe(expectedStickerTotal);
      expect(defaultBody.totalPages).toBe(expectedTotalPages);
      expect(defaultBody.stickerTotal).toBe(expectedStickerTotal);
      expect(defaultBody.emojiTotal).toBe(3);
      expect(defaultBody.query).toBe("");
      expect(defaultBody.items).toHaveLength(MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE);
      expect(defaultBody.items[0]).toEqual({ pack: "Promo_Alpha" });
      expect(defaultBody.items[1]).toEqual({ pack: firstNumberedPack });
      // 分页冷读不得污染主线程 768 LRU 热缓存。
      expect(adPackBlacklistCache.size).toBe(0);

      // 2. 超出总页数自动夹紧至 totalPages
      const clampedRes: Response = await handleMiniAppHttpRequest(
        new Request(
          `http://127.0.0.1:3000/api/ad-blacklists?kind=sticker&page=${expectedTotalPages + 10}&pageSize=${MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE}`,
          { headers: superAdminHeaders() }
        )
      );
      expect(clampedRes.status).toBe(200);
      const clampedBody: MiniAppAdBlacklistsResponse =
        (await clampedRes.json()) as MiniAppAdBlacklistsResponse;
      expect(clampedBody.page).toBe(expectedTotalPages);
      expect(clampedBody.totalPages).toBe(expectedTotalPages);
      expect(clampedBody.items).toHaveLength(expectedLastPageItems);
      expect(clampedBody.items.at(-1)).toEqual({ pack: "promo_beta" });

      // 3. 大小写不敏感子串搜索并保留两类总量与裁剪后的 query
      const searchRes: Response = await handleMiniAppHttpRequest(
        new Request(
          `http://127.0.0.1:3000/api/ad-blacklists?kind=sticker&query=%20PROMO%20&page=1&pageSize=${MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE}`,
          { headers: superAdminHeaders() }
        )
      );
      expect(searchRes.status).toBe(200);
      const searchBody: MiniAppAdBlacklistsResponse =
        (await searchRes.json()) as MiniAppAdBlacklistsResponse;
      expect(searchBody.query).toBe("PROMO");
      expect(searchBody.total).toBe(2);
      expect(searchBody.totalPages).toBe(1);
      expect(searchBody.stickerTotal).toBe(expectedStickerTotal);
      expect(searchBody.emojiTotal).toBe(3);
      expect(searchBody.items).toEqual([
        { pack: "Promo_Alpha" },
        { pack: "promo_beta" },
      ]);

      // 4. emoji 分表查询与空匹配页码夹紧为 1
      const emojiRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists?kind=emoji&page=1&pageSize=2", {
          headers: superAdminHeaders(),
        })
      );
      expect(emojiRes.status).toBe(200);
      const emojiBody: MiniAppAdBlacklistsResponse =
        (await emojiRes.json()) as MiniAppAdBlacklistsResponse;
      expect(emojiBody.kind).toBe("emoji");
      expect(emojiBody.total).toBe(3);
      expect(emojiBody.totalPages).toBe(2);
      expect(emojiBody.items).toEqual([
        { pack: "EmojiPromo_1" },
        { pack: "EmojiSpam_A" },
      ]);

      const emptyMatchRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists?kind=emoji&query=no_such_pack&page=5", {
          headers: superAdminHeaders(),
        })
      );
      expect(emptyMatchRes.status).toBe(200);
      const emptyMatchBody: MiniAppAdBlacklistsResponse =
        (await emptyMatchRes.json()) as MiniAppAdBlacklistsResponse;
      expect(emptyMatchBody.items).toEqual([]);
      expect(emptyMatchBody.total).toBe(0);
      expect(emptyMatchBody.totalPages).toBe(1);
      expect(emptyMatchBody.page).toBe(1);

      // 只读查询不写 operation 审计日志。
      expect(opSpy).not.toHaveBeenCalled();
    } finally {
      opSpy.mockRestore();
    }
  });

  test("GET /api/ad-blacklists 拒绝非法 kind、page、pageSize、超长 query、重复键与未知键（返回 400）", async () => {
    const overlongQuery: string = "a".repeat(MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH + 1);
    const invalidPaths: readonly string[] = [
      "/api/ad-blacklists?kind=",
      "/api/ad-blacklists?kind=invalid",
      "/api/ad-blacklists?kind=sticker&kind=emoji",
      "/api/ad-blacklists?page=0",
      "/api/ad-blacklists?page=-1",
      "/api/ad-blacklists?page=1.5",
      "/api/ad-blacklists?page=abc",
      "/api/ad-blacklists?page=01",
      "/api/ad-blacklists?page=1&page=2",
      "/api/ad-blacklists?pageSize=0",
      `/api/ad-blacklists?pageSize=${MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE + 1}`,
      "/api/ad-blacklists?pageSize=-5",
      "/api/ad-blacklists?pageSize=abc",
      `/api/ad-blacklists?query=${overlongQuery}`,
      "/api/ad-blacklists?query=a&query=b",
      "/api/ad-blacklists?unknown=1",
    ];
    for (const path of invalidPaths) {
      const res: Response = await handleMiniAppHttpRequest(
        new Request(`http://127.0.0.1:3000${path}`, {
          headers: superAdminHeaders(),
        })
      );
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 400`);
      expect(await res.json()).toEqual({ error: "INVALID_AD_BLACKLIST_PARAMS" });
    }
  });

  test("POST /api/ad-blacklists 支持新增、重复、移除、不存在并记录 logger.operation 审计日志", async () => {
    const opSpy = spyOn(logger, "operation");
    const infoSpy = spyOn(console, "info").mockImplementation((): void => {});
    try {
      // 1. 新增贴纸包（带首尾空白时规范化裁剪）
      const addRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sticker", pack: "  AdSpam_Pack1  ", enabled: true }),
        })
      );
      expect(addRes.status).toBe(200);
      const addBody: MiniAppAdBlacklistMutationResponse =
        (await addRes.json()) as MiniAppAdBlacklistMutationResponse;
      expect(addBody).toEqual({
        ok: true,
        kind: "sticker",
        pack: "AdSpam_Pack1",
        enabled: true,
        changed: true,
        persisted: true,
        code: "AD_BLACKLIST_ADDED",
        message: "AD_BLACKLIST_ADDED",
      });
      expect(await findFirstBlacklistedAdPack("sticker", ["AdSpam_Pack1"])).toBe("AdSpam_Pack1");
      expect(opSpy).toHaveBeenLastCalledWith("[MiniApp] adBlacklists.mutate", {
        kind: "sticker",
        pack: "AdSpam_Pack1",
        enabled: true,
        ok: true,
        changed: true,
        persisted: true,
      });

      // 2. 重复新增同一包名
      const dupRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sticker", pack: "AdSpam_Pack1", enabled: true }),
        })
      );
      expect(dupRes.status).toBe(200);
      expect(await dupRes.json()).toEqual({
        ok: true,
        kind: "sticker",
        pack: "AdSpam_Pack1",
        enabled: true,
        changed: false,
        duplicate: true,
        persisted: true,
        code: "AD_BLACKLIST_DUPLICATE",
        message: "AD_BLACKLIST_DUPLICATE",
      });
      expect(opSpy).toHaveBeenLastCalledWith("[MiniApp] adBlacklists.mutate", {
        kind: "sticker",
        pack: "AdSpam_Pack1",
        enabled: true,
        ok: true,
        changed: false,
        persisted: true,
      });

      // 3. 移除已存在包名
      const remRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sticker", pack: "AdSpam_Pack1", enabled: false }),
        })
      );
      expect(remRes.status).toBe(200);
      expect(await remRes.json()).toEqual({
        ok: true,
        kind: "sticker",
        pack: "AdSpam_Pack1",
        enabled: false,
        changed: true,
        persisted: true,
        code: "AD_BLACKLIST_REMOVED",
        message: "AD_BLACKLIST_REMOVED",
      });
      expect(await findFirstBlacklistedAdPack("sticker", ["AdSpam_Pack1"])).toBeNull();

      // 4. 移除不存在的包名
      const notFoundRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "emoji", pack: "MissingEmojiPack", enabled: false }),
        })
      );
      expect(notFoundRes.status).toBe(200);
      expect(await notFoundRes.json()).toEqual({
        ok: true,
        kind: "emoji",
        pack: "MissingEmojiPack",
        enabled: false,
        changed: false,
        persisted: true,
        code: "AD_BLACKLIST_NOT_FOUND",
        message: "AD_BLACKLIST_NOT_FOUND",
      });
    } finally {
      opSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test("POST /api/ad-blacklists 严格校验 JSON 结构、字段类型、多余键与包名规则（返回 400）", async () => {
    const opSpy = spyOn(logger, "operation");
    try {
      for (const rawBody of [
        "not-json",
        "[]",
        "{}",
        JSON.stringify({ kind: "other", pack: "ValidPack", enabled: true }),
        JSON.stringify({ kind: "sticker", pack: 123, enabled: true }),
        JSON.stringify({ kind: "sticker", pack: "ValidPack", enabled: "true" }),
        JSON.stringify({ kind: "sticker", pack: "ValidPack", enabled: true, extra: 1 }),
        JSON.stringify({ kind: "sticker", enabled: true }),
      ]) {
        const res: Response = await handleMiniAppHttpRequest(
          new Request("http://127.0.0.1:3000/api/ad-blacklists", {
            method: "POST",
            headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
            body: rawBody,
          })
        );
        expect(res.status).toBe(400);
        const body: MiniAppAdBlacklistMutationResponse =
          (await res.json()) as MiniAppAdBlacklistMutationResponse;
        expect(body.ok).toBeFalse();
        expect(body.code).toBe("INVALID_AD_BLACKLIST_PARAMS");
        expect(body.message).toBe("INVALID_AD_BLACKLIST_PARAMS");
      }

      for (const badPack of ["", "   ", "bad-pack", "bad pack", "中文包名", "a".repeat(65)]) {
        const res: Response = await handleMiniAppHttpRequest(
          new Request("http://127.0.0.1:3000/api/ad-blacklists", {
            method: "POST",
            headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "sticker", pack: badPack, enabled: true }),
          })
        );
        expect(res.status).toBe(400);
        const body: MiniAppAdBlacklistMutationResponse =
          (await res.json()) as MiniAppAdBlacklistMutationResponse;
        expect(body.ok).toBeFalse();
        expect(body.code).toBe("INVALID_AD_BLACKLIST_PACK");
        expect(body.message).toBe("INVALID_AD_BLACKLIST_PACK");
      }

      // 直接调用视图函数同样拒绝非法包名。
      const directBadPack = await mutateMiniAppAdBlacklist({
        kind: "emoji",
        pack: "bad-pack",
        enabled: true,
      });
      expect(directBadPack.status).toBe(400);
      expect(directBadPack.body.code).toBe("INVALID_AD_BLACKLIST_PACK");

      expect(opSpy).not.toHaveBeenCalled();
    } finally {
      opSpy.mockRestore();
    }
  });

  test("POST /api/ad-blacklists 拒绝拉黑机器人自用贴纸包（409），但放行同名表情包与贴纸包移除", async () => {
    adoptStickerConfig({ packs: ["BotOwnStickerPack"] });
    const opSpy = spyOn(logger, "operation");
    const infoSpy = spyOn(console, "info").mockImplementation((): void => {});
    try {
      const ownStickerRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sticker", pack: "BotOwnStickerPack", enabled: true }),
        })
      );
      expect(ownStickerRes.status).toBe(409);
      expect(await ownStickerRes.json()).toEqual({
        ok: false,
        kind: "sticker",
        pack: "BotOwnStickerPack",
        enabled: true,
        changed: false,
        code: "AD_BLACKLIST_BOT_OWN_PACK",
        message: "AD_BLACKLIST_BOT_OWN_PACK",
      });
      expect(await findFirstBlacklistedAdPack("sticker", ["BotOwnStickerPack"])).toBeNull();
      expect(opSpy).toHaveBeenLastCalledWith("[MiniApp] adBlacklists.mutate", {
        kind: "sticker",
        pack: "BotOwnStickerPack",
        enabled: true,
        ok: false,
        changed: false,
        persisted: false,
      });

      // 同名自定义表情包不受 stickers.json 限制。
      const sameNameEmojiRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "emoji", pack: "BotOwnStickerPack", enabled: true }),
        })
      );
      expect(sameNameEmojiRes.status).toBe(200);
      expect(((await sameNameEmojiRes.json()) as MiniAppAdBlacklistMutationResponse).code).toBe(
        "AD_BLACKLIST_ADDED"
      );

      // 已存在于黑名单中的自用贴纸包（如后期新增到 stickers.json）允许移除。
      seedAdPackBlacklists({
        sticker: ["BotOwnStickerPack"],
        emoji: [],
      });
      const removeOwnRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sticker", pack: "BotOwnStickerPack", enabled: false }),
        })
      );
      expect(removeOwnRes.status).toBe(200);
      expect(((await removeOwnRes.json()) as MiniAppAdBlacklistMutationResponse).code).toBe(
        "AD_BLACKLIST_REMOVED"
      );
    } finally {
      opSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test("超出 768 内存缓存容量时 POST 无硬上限正常新增且 GET 跨页冷读完整返回，冷读失败返回 503", async () => {
    const largeSeedCount: number = AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES + 20;
    seedAdPackBlacklists({
      sticker: Array.from(
        { length: largeSeedCount },
        (_unused: unknown, index: number): string =>
          `LargePack_${String(index).padStart(4, "0")}`
      ),
      emoji: [],
    });
    const opSpy = spyOn(logger, "operation");
    const errSpy = spyOn(logger, "error").mockImplementation((): void => {});
    const infoSpy = spyOn(console, "info").mockImplementation((): void => {});
    try {
      const addRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sticker", pack: "Z_UnlimitedPack", enabled: true }),
        })
      );
      expect(addRes.status).toBe(200);
      expect(((await addRes.json()) as MiniAppAdBlacklistMutationResponse).code).toBe(
        "AD_BLACKLIST_ADDED"
      );

      const expectedTotal: number = largeSeedCount + 1;
      const lastPageNum: number = Math.ceil(expectedTotal / MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE);
      const lastPageRes: Response = await handleMiniAppHttpRequest(
        new Request(
          `http://127.0.0.1:3000/api/ad-blacklists?kind=sticker&page=${lastPageNum}&pageSize=${MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE}`,
          { headers: superAdminHeaders() }
        )
      );
      expect(lastPageRes.status).toBe(200);
      const lastPageBody: MiniAppAdBlacklistsResponse =
        (await lastPageRes.json()) as MiniAppAdBlacklistsResponse;
      expect(lastPageBody.total).toBe(expectedTotal);
      expect(lastPageBody.stickerTotal).toBe(expectedTotal);
      expect(lastPageBody.items.at(-1)).toEqual({ pack: "Z_UnlimitedPack" });
      expect(adPackBlacklistCache.size).toBeLessThanOrEqual(AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES);

      failPageReadOnce = true;
      const unavailableRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists?kind=sticker", {
          headers: superAdminHeaders(),
        })
      );
      expect(unavailableRes.status).toBe(503);
      expect(await unavailableRes.json()).toEqual({ error: "AD_BLACKLIST_STORAGE_UNAVAILABLE" });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      opSpy.mockRestore();
      errSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test("POST /api/ad-blacklists 在 Disk I/O 刷盘失败、未收到 ACK 或准入拒收时返回 503 AD_BLACKLIST_STORAGE_UNAVAILABLE", async () => {
    const opSpy = spyOn(logger, "operation");
    const errSpy = spyOn(logger, "error").mockImplementation((): void => {});
    const infoSpy = spyOn(console, "info").mockImplementation((): void => {});
    try {
      // 1. 新增时刷盘失败（persisted: false）
      flushOutcome = { result: "failed", failedDomains: ["adPackBlacklist"] };
      const flushFailAdd: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sticker", pack: "FlushFailPack", enabled: true }),
        })
      );
      expect(flushFailAdd.status).toBe(503);
      expect(await flushFailAdd.json()).toEqual({
        ok: false,
        kind: "sticker",
        pack: "FlushFailPack",
        enabled: true,
        changed: true,
        persisted: false,
        code: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
        message: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
      });
      expect(opSpy).toHaveBeenLastCalledWith("[MiniApp] adBlacklists.mutate", {
        kind: "sticker",
        pack: "FlushFailPack",
        enabled: true,
        ok: false,
        changed: true,
        persisted: false,
      });

      // 2. 移除时未收到 ACK（persisted: false）
      flushOutcome = { result: "flushed" };
      acknowledgeOnFlush = false;
      const unackRemove: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sticker", pack: "FlushFailPack", enabled: false }),
        })
      );
      expect(unackRemove.status).toBe(503);
      expect(await unackRemove.json()).toEqual({
        ok: false,
        kind: "sticker",
        pack: "FlushFailPack",
        enabled: false,
        changed: true,
        persisted: false,
        code: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
        message: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
      });

      // 3. Disk I/O 准入拒收直接抛错（fatalSignaled）
      acknowledgeOnFlush = true;
      diskIORuntime.fatalSignaled = true;
      const refusedAdd: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/ad-blacklists", {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "emoji", pack: "RefusedPack", enabled: true }),
        })
      );
      expect(refusedAdd.status).toBe(503);
      expect(await refusedAdd.json()).toEqual({
        ok: false,
        kind: "emoji",
        pack: "RefusedPack",
        enabled: true,
        changed: false,
        persisted: false,
        code: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
        message: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
      });
      expect(await findFirstBlacklistedAdPack("emoji", ["RefusedPack"])).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      opSpy.mockRestore();
      errSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
