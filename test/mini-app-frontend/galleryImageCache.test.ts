/**
 * Mini App 前端图库 7 天持久化 + 内存双层 `ETag` 协商缓存测试：
 * - 验证通过独立虚拟缓存键与 `If-None-Match` 在随机 IV `?e=` 及会话轮换下命中服务端 `304` 零字节复用；
 * - 验证 7 天（`MINI_APP_GALLERY_CACHE_TTL_MS`）硬过期淘汰与 `pruneExpiredMiniAppGalleryCache` 清理；
 * - 验证服务端文件更新 `200` 覆盖、`deleteMiniAppGalleryImageByName` 删图驱逐、`404` 驱逐与 `401` 鉴权拦截隔离；
 * - 验证无 `CacheStorage` 环境下的内存后备协商缓存及 `MINI_APP_GALLERY_BLOB_CACHE_MAX` 有界淘汰。
 */

import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { deleteMiniAppGalleryImageByName } from "../../packages/mini-app-frontend/api/galleryDelete";
import { fetchMiniAppGalleryImageObjectUrl } from "../../packages/mini-app-frontend/api/galleryFile";
import {
  MINI_APP_GALLERY_BLOB_CACHE_MAX,
  MINI_APP_GALLERY_CACHE_TTL_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import {
  clearMiniAppGalleryImageCacheForTest,
  pruneExpiredMiniAppGalleryCache,
  readCachedMiniAppGalleryImage,
  writeCachedMiniAppGalleryImage,
} from "../../packages/mini-app-frontend/libs/galleryImageCache";
import type {
  MiniAppGalleryCacheBucket,
  MiniAppGalleryCacheStorage,
  TelegramWindow,
} from "../../packages/mini-app-frontend/types/miniApp";
import {
  TEST_ROTATED_SESSION_KEY,
  TEST_SESSION_KEY,
  seedTestMiniAppSession,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

interface CachedResponseRecord {
  readonly bytes: ArrayBuffer;
  readonly status: number;
  readonly headers: readonly [string, string][];
}

interface MockCacheStorageController {
  readonly storage: MiniAppGalleryCacheStorage;
  readonly getBucketEntryCount: (cacheName: string) => number;
  readonly listBucketKeys: (cacheName: string) => string[];
}

/**
 * 构造符合 `MiniAppGalleryCacheStorage` 最小接口的内存版 `CacheStorage` 替身。
 *
 * @returns 缓存替身与桶内键检查辅助方法
 */
function createMockCacheStorage(): MockCacheStorageController {
  const buckets: Map<string, Map<string, CachedResponseRecord>> = new Map<
    string,
    Map<string, CachedResponseRecord>
  >();

  const ensureBucketMap = (
    cacheName: string
  ): Map<string, CachedResponseRecord> => {
    let entries: Map<string, CachedResponseRecord> | undefined =
      buckets.get(cacheName);
    if (entries === undefined) {
      entries = new Map<string, CachedResponseRecord>();
      buckets.set(cacheName, entries);
    }
    return entries;
  };

  const storage: MiniAppGalleryCacheStorage = {
    open: async (cacheName: string): Promise<MiniAppGalleryCacheBucket> => {
      const entries: Map<string, CachedResponseRecord> =
        ensureBucketMap(cacheName);
      return {
        match: async (request: string): Promise<Response | undefined> => {
          const hit: CachedResponseRecord | undefined = entries.get(request);
          if (hit === undefined) return undefined;
          return new Response(hit.bytes, {
            status: hit.status,
            headers: [...hit.headers],
          });
        },
        put: async (request: string, response: Response): Promise<void> => {
          const bytes: ArrayBuffer = await response.arrayBuffer();
          const headers: [string, string][] = Array.from(
            response.headers.entries()
          );
          entries.set(request, { bytes, status: response.status, headers });
        },
        delete: async (request: string): Promise<boolean> =>
          entries.delete(request),
        keys: async (): Promise<readonly Request[]> =>
          Array.from(entries.keys(), (url: string): Request => new Request(url)),
      };
    },
    delete: async (cacheName: string): Promise<boolean> =>
      buckets.delete(cacheName),
  };

  return {
    storage,
    getBucketEntryCount: (cacheName: string): number =>
      buckets.get(cacheName)?.size ?? 0,
    listBucketKeys: (cacheName: string): string[] =>
      Array.from(buckets.get(cacheName)?.keys() ?? []),
  };
}

const savedCachesDescriptor: PropertyDescriptor | undefined =
  Reflect.getOwnPropertyDescriptor(globalThis, "caches");
const originalFetch: typeof fetch = globalThis.fetch;

/**
 * 在 `globalThis.caches` 安装测试替身。
 *
 * @param value 模拟的 `CacheStorage` 或 `undefined`
 */
function setGlobalCaches(value: Readonly<MiniAppGalleryCacheStorage> | undefined): void {
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

afterEach(async (): Promise<void> => {
  setSystemTime();
  await clearMiniAppGalleryImageCacheForTest();
  if (savedCachesDescriptor !== undefined) {
    Object.defineProperty(globalThis, "caches", savedCachesDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "caches");
  }
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "Telegram");
  clearMiniAppSessionToken();
});

describe("Mini App 前端图库 7 天协商缓存与 ETag 校验", () => {
  test("跨随机 IV ?e= 加密与会话轮换仍命中 CacheStorage + If-None-Match 304 复用", async () => {
    const cacheMock: MockCacheStorageController = createMockCacheStorage();
    setGlobalCaches(cacheMock.storage);
    const tgWindow: TelegramWindow = globalThis;
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "signed-init-v1" },
    };
    seedTestMiniAppSession("a".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);

    const observedRequests: {
      readonly ifNoneMatch: string | null;
      readonly cacheMode: RequestInit["cache"];
    }[] = [];
    const expectedBytes: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const currentEtag: string = '"gallery-pic.png-4-1000"';
    const outboundUrls: string[] = [];

    const encryptedFetch: typeof fetch = wrapEncryptedTestFetch(
      (
        url: URL,
        _decryptedInit: RequestInit | undefined,
        rawInit: RequestInit | undefined
      ): Response => {
        if (url.pathname === "/api/gallery/file") {
          const reqHeaders: Headers = new Headers(rawInit?.headers);
          const ifNoneMatch: string | null = reqHeaders.get("if-none-match");
          observedRequests.push({
            ifNoneMatch,
            cacheMode: rawInit?.cache,
          });
          if (ifNoneMatch === currentEtag) {
            return new Response(null, {
              status: 304,
              headers: { ETag: currentEtag },
            });
          }
          return new Response(expectedBytes, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "ETag": currentEtag,
              "Cache-Control": "private, no-cache, max-age=604800, must-revalidate",
            },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }
    );
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      outboundUrls.push(String(input));
      return await encryptedFetch(input, init);
    }) as typeof fetch;

    const capturedBlobs: Blob[] = [];
    const realCreateObjectURL: typeof URL.createObjectURL = URL.createObjectURL;
    const createSpy = spyOn(URL, "createObjectURL").mockImplementation(
      (obj: Blob): `blob:${string}` => {
        capturedBlobs.push(obj);
        return realCreateObjectURL(obj);
      }
    );
    try {
      const firstUrl: string = await fetchMiniAppGalleryImageObjectUrl("pic.png");
      expect(firstUrl).toStartWith("blob:");
      URL.revokeObjectURL(firstUrl);
      expect(observedRequests).toHaveLength(1);
      expect(observedRequests[0]?.ifNoneMatch).toBeNull();
      expect(observedRequests[0]?.cacheMode).toBe("no-store");
      expect(new Uint8Array(await capturedBlobs[0]!.arrayBuffer())).toEqual(
        expectedBytes
      );

      // 模拟关闭重开 WebView 且会话令牌/密钥与加密随机 IV 全量变更，仅保留 CacheStorage。
      tgWindow.__copyNinjaGalleryBinaryCache?.clear();
      tgWindow.__copyNinjaGalleryBinaryCache = undefined;
      tgWindow.__copyNinjaGalleryCachePrunePromise = undefined;
      (globalThis as { Telegram?: unknown }).Telegram = {
        WebApp: { initData: "signed-init-v2" },
      };
      seedTestMiniAppSession(
        "b".repeat(64),
        Date.now() + 600_000,
        TEST_ROTATED_SESSION_KEY
      );

      const secondUrl: string = await fetchMiniAppGalleryImageObjectUrl("pic.png");
      expect(secondUrl).toStartWith("blob:");
      URL.revokeObjectURL(secondUrl);
      expect(observedRequests).toHaveLength(2);
      expect(observedRequests[1]?.ifNoneMatch).toBe(currentEtag);
      expect(observedRequests[1]?.cacheMode).toBe("no-store");
      expect(outboundUrls).toHaveLength(2);
      expect(outboundUrls[0]).toContain("?e=");
      expect(outboundUrls[1]).toContain("?e=");
      expect(outboundUrls[1]).not.toBe(outboundUrls[0]);
      expect(new Uint8Array(await capturedBlobs[1]!.arrayBuffer())).toEqual(
        expectedBytes
      );
    } finally {
      createSpy.mockRestore();
    }
  });

  test("满 7 天后自动失效淘汰并重拉，且主动清扫过期持久化条目", async () => {
    const cacheMock: MockCacheStorageController = createMockCacheStorage();
    setGlobalCaches(cacheMock.storage);
    const tgWindow: TelegramWindow = globalThis;
    const baseMs: number = 1_700_000_000_000;
    setSystemTime(baseMs);
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "signed-init" },
    };
    seedTestMiniAppSession("c".repeat(64), baseMs + MINI_APP_CACHE_WAIT_SAFE_MS, TEST_SESSION_KEY);

    let activeTag: string = '"etag-day0"';
    let payloadByte: number = 11;
    const sentIfNoneMatches: (string | null)[] = [];

    globalThis.fetch = wrapEncryptedTestFetch(
      (
        url: URL,
        _decryptedInit: RequestInit | undefined,
        rawInit: RequestInit | undefined
      ): Response => {
        if (url.pathname === "/api/gallery/file") {
          const reqHeaders: Headers = new Headers(rawInit?.headers);
          const ifNoneMatch: string | null = reqHeaders.get("if-none-match");
          sentIfNoneMatches.push(ifNoneMatch);
          if (ifNoneMatch === activeTag) {
            return new Response(null, { status: 304, headers: { ETag: activeTag } });
          }
          return new Response(new Uint8Array([payloadByte, 2, 3]), {
            status: 200,
            headers: { "Content-Type": "image/png", ETag: activeTag },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }
    );

    const url0: string = await fetchMiniAppGalleryImageObjectUrl("weekly.png");
    URL.revokeObjectURL(url0);
    expect(sentIfNoneMatches).toEqual([null]);

    // 接近 7 天阈值前 1 毫秒：仍走 304 协商缓存（不延长初始缓存时刻）。
    const nearExpiryMs: number = baseMs + MINI_APP_GALLERY_CACHE_TTL_MS - 1;
    setSystemTime(nearExpiryMs);
    seedTestMiniAppSession("c".repeat(64), nearExpiryMs + 600_000, TEST_SESSION_KEY);
    const urlNear: string = await fetchMiniAppGalleryImageObjectUrl("weekly.png");
    URL.revokeObjectURL(urlNear);
    expect(sentIfNoneMatches).toEqual([null, '"etag-day0"']);

    // 到达满 7 天（清除内存缓存强制验证持久化桶同样按 7 天过期）：不发 If-None-Match，全量重拉。
    const expiredMs: number = baseMs + MINI_APP_GALLERY_CACHE_TTL_MS;
    setSystemTime(expiredMs);
    seedTestMiniAppSession("c".repeat(64), expiredMs + 600_000, TEST_SESSION_KEY);
    tgWindow.__copyNinjaGalleryBinaryCache?.clear();
    tgWindow.__copyNinjaGalleryBinaryCache = undefined;
    tgWindow.__copyNinjaGalleryCachePrunePromise = undefined;
    activeTag = '"etag-day7"';
    payloadByte = 99;

    const urlAfterWeek: string = await fetchMiniAppGalleryImageObjectUrl("weekly.png");
    URL.revokeObjectURL(urlAfterWeek);
    expect(sentIfNoneMatches).toEqual([null, '"etag-day0"', null]);
    const refreshedEntry = await readCachedMiniAppGalleryImage("weekly.png", expiredMs);
    expect(refreshedEntry?.etag).toBe('"etag-day7"');
    expect(refreshedEntry?.cachedAt).toBe(expiredMs);

    // 主动清扫函数移除满 7 天的 stale.png，保留仍在 7 天内的 weekly.png。
    await writeCachedMiniAppGalleryImage({
      fileName: "stale.png",
      blob: new Blob([new Uint8Array([1, 2])], { type: "image/png" }),
      etag: '"stale-tag"',
      nowMs: expiredMs - MINI_APP_GALLERY_CACHE_TTL_MS,
    });
    await pruneExpiredMiniAppGalleryCache(expiredMs);
    expect(await readCachedMiniAppGalleryImage("stale.png", expiredMs)).toBeNull();
    expect(
      (await readCachedMiniAppGalleryImage("weekly.png", expiredMs))?.etag
    ).toBe('"etag-day7"');
  });

  test("支持 200 ETag 更新覆盖、删除图片即刻驱逐、404 驱逐及 401 拒绝泄露", async () => {
    const cacheMock: MockCacheStorageController = createMockCacheStorage();
    setGlobalCaches(cacheMock.storage);
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "signed-init" },
    };
    seedTestMiniAppSession("d".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);

    let mode: "v1" | "v2" | "notFound" | "unauth" = "v1";
    const observedTags: (string | null)[] = [];

    globalThis.fetch = wrapEncryptedTestFetch(
      (
        url: URL,
        _decryptedInit: RequestInit | undefined,
        rawInit: RequestInit | undefined
      ): Response => {
        if (url.pathname === "/api/gallery/delete") {
          return Response.json({
            ok: true,
            outcome: "deleted",
            fileName: "mutating.png",
            message: "GALLERY_IMAGE_DELETED",
          });
        }
        if (url.pathname === "/api/gallery/file") {
          const reqHeaders: Headers = new Headers(rawInit?.headers);
          observedTags.push(reqHeaders.get("if-none-match"));
          if (mode === "unauth") {
            return Response.json(
              { code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" },
              { status: 401 }
            );
          }
          if (mode === "notFound") {
            return Response.json({ error: "Image not found" }, { status: 404 });
          }
          if (mode === "v1") {
            return new Response(new Uint8Array([1, 1, 1]), {
              status: 200,
              headers: { "Content-Type": "image/png", ETag: '"tag-v1"' },
            });
          }
          if (reqHeaders.get("if-none-match") === '"tag-v2"') {
            return new Response(null, { status: 304, headers: { ETag: '"tag-v2"' } });
          }
          return new Response(new Uint8Array([2, 2, 2]), {
            status: 200,
            headers: { "Content-Type": "image/png", ETag: '"tag-v2"' },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }
    );

    const u1: string = await fetchMiniAppGalleryImageObjectUrl("mutating.png");
    URL.revokeObjectURL(u1);

    // 服务端文件更新（带旧 tag-v1 协商返回 200 + 新 tag-v2），本地缓存随之刷新。
    mode = "v2";
    const u2: string = await fetchMiniAppGalleryImageObjectUrl("mutating.png");
    URL.revokeObjectURL(u2);
    const u3: string = await fetchMiniAppGalleryImageObjectUrl("mutating.png");
    URL.revokeObjectURL(u3);
    expect(observedTags).toEqual([null, '"tag-v1"', '"tag-v2"']);

    // 删除图片成功后，内存与 CacheStorage 中的条目必须同步被清除。
    const deleteRes = await deleteMiniAppGalleryImageByName("mutating.png");
    expect(deleteRes.ok).toBeTrue();
    expect(await readCachedMiniAppGalleryImage("mutating.png")).toBeNull();

    // 200 OK 若响应缺失 ETag，同步驱逐旧缓存条目防止残留。
    mode = "v1";
    const uNoTagBase: string = await fetchMiniAppGalleryImageObjectUrl("notag.png");
    URL.revokeObjectURL(uNoTagBase);
    expect((await readCachedMiniAppGalleryImage("notag.png"))?.etag).toBe('"tag-v1"');
    const prevFetch: typeof fetch = globalThis.fetch;
    globalThis.fetch = wrapEncryptedTestFetch(
      (): Response =>
        new Response(new Uint8Array([9, 9, 9]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        })
    );
    const uNoTagNext: string = await fetchMiniAppGalleryImageObjectUrl("notag.png");
    URL.revokeObjectURL(uNoTagNext);
    globalThis.fetch = prevFetch;
    expect(await readCachedMiniAppGalleryImage("notag.png")).toBeNull();

    // 404 自动驱逐陈旧缓存；401 鉴权失败绝不回退返回缓存图片且擦除凭据。
    mode = "v1";
    const uGone1: string = await fetchMiniAppGalleryImageObjectUrl("gone.png");
    URL.revokeObjectURL(uGone1);
    mode = "notFound";
    await expect(fetchMiniAppGalleryImageObjectUrl("gone.png")).rejects.toThrow(
      "Image not found"
    );
    expect(await readCachedMiniAppGalleryImage("gone.png")).toBeNull();

    mode = "v1";
    const uAuth: string = await fetchMiniAppGalleryImageObjectUrl("secret.png");
    URL.revokeObjectURL(uAuth);
    mode = "unauth";
    await expect(fetchMiniAppGalleryImageObjectUrl("secret.png")).rejects.toThrow(
      "[PASSWORD_REQUIRED] SESSION_EXPIRED"
    );
    expect(readMiniAppSessionToken()).toBe("");
  });

  test("无 CacheStorage 宿主环境下依赖有界内存协商缓存，超出上限按最久未用淘汰", async () => {
    setGlobalCaches(undefined);
    const tgWindow: TelegramWindow = globalThis;
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "signed-init" },
    };
    seedTestMiniAppSession("e".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);

    const observedHeadersByFile: Map<string, (string | null)[]> = new Map<
      string,
      (string | null)[]
    >();

    globalThis.fetch = wrapEncryptedTestFetch(
      (
        url: URL,
        _decryptedInit: RequestInit | undefined,
        rawInit: RequestInit | undefined
      ): Response => {
        if (url.pathname === "/api/gallery/file") {
          const fileName: string = url.searchParams.get("fileName") ?? "";
          const reqHeaders: Headers = new Headers(rawInit?.headers);
          const tag: string | null = reqHeaders.get("if-none-match");
          const list: (string | null)[] = observedHeadersByFile.get(fileName) ?? [];
          list.push(tag);
          observedHeadersByFile.set(fileName, list);
          const expectedTag: string = `"mem-${fileName}"`;
          if (tag === expectedTag) {
            return new Response(null, { status: 304, headers: { ETag: expectedTag } });
          }
          return new Response(new Uint8Array([7, 8, 9]), {
            status: 200,
            headers: { "Content-Type": "image/png", ETag: expectedTag },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }
    );

    const overflowCount: number = 5;
    const totalFiles: number = MINI_APP_GALLERY_BLOB_CACHE_MAX + overflowCount;
    for (let i: number = 0; i < totalFiles; i += 1) {
      const url: string = await fetchMiniAppGalleryImageObjectUrl(`item-${i}.png`);
      URL.revokeObjectURL(url);
    }
    expect(tgWindow.__copyNinjaGalleryBinaryCache?.size).toBe(
      MINI_APP_GALLERY_BLOB_CACHE_MAX
    );
    expect(await readCachedMiniAppGalleryImage("item-0.png")).toBeNull();
    expect(
      (await readCachedMiniAppGalleryImage(`item-${totalFiles - 1}.png`))?.etag
    ).toBe(`"mem-item-${totalFiles - 1}.png"`);

    const recentUrl: string = await fetchMiniAppGalleryImageObjectUrl(
      `item-${totalFiles - 1}.png`
    );
    URL.revokeObjectURL(recentUrl);
    expect(observedHeadersByFile.get(`item-${totalFiles - 1}.png`)).toEqual([
      null,
      `"mem-item-${totalFiles - 1}.png"`,
    ]);
  });

  test("首屏并发读取共享单飞过期清扫且不误删并发回写的新缓存条目", async () => {
    const cacheMock: MockCacheStorageController = createMockCacheStorage();
    let keysCallCount: number = 0;
    const baseOpen = cacheMock.storage.open;
    setGlobalCaches({
      open: async (cacheName: string): Promise<MiniAppGalleryCacheBucket> => {
        const bucket: MiniAppGalleryCacheBucket = await baseOpen(cacheName);
        return {
          match: bucket.match,
          put: bucket.put,
          delete: bucket.delete,
          keys: async (): Promise<readonly Request[]> => {
            keysCallCount += 1;
            return await (bucket.keys?.() ?? Promise.resolve([]));
          },
        };
      },
      delete: cacheMock.storage.delete,
    });
    const nowMs: number = 1_700_000_000_000;
    setSystemTime(nowMs);
    await writeCachedMiniAppGalleryImage({
      fileName: "expired-old.png",
      blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
      etag: '"old"',
      nowMs: nowMs - MINI_APP_GALLERY_CACHE_TTL_MS - 1,
    });
    await writeCachedMiniAppGalleryImage({
      fileName: "fresh-1.png",
      blob: new Blob([new Uint8Array([2])], { type: "image/png" }),
      etag: '"f1"',
      nowMs,
    });
    const tgWindow: TelegramWindow = globalThis;
    tgWindow.__copyNinjaGalleryBinaryCache?.clear();
    tgWindow.__copyNinjaGalleryBinaryCache = undefined;
    tgWindow.__copyNinjaGalleryCachePrunePromise = undefined;

    const results = await Promise.allSettled([
      readCachedMiniAppGalleryImage("fresh-1.png", nowMs),
      readCachedMiniAppGalleryImage("missing-2.png", nowMs),
      readCachedMiniAppGalleryImage("expired-old.png", nowMs),
    ]);
    expect(keysCallCount).toBe(1);
    expect(results[0]?.status === "fulfilled" && results[0].value?.etag).toBe('"f1"');
    expect(results[1]?.status === "fulfilled" && results[1].value).toBeNull();
    expect(results[2]?.status === "fulfilled" && results[2].value).toBeNull();
  });
});

/** 测试中使用的长会话续期余量（覆盖 7 天以上窗口避免测试期会话先过期）。 */
const MINI_APP_CACHE_WAIT_SAFE_MS: number = MINI_APP_GALLERY_CACHE_TTL_MS + 3_600_000;
