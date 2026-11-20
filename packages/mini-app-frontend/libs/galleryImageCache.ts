import {
  MINI_APP_GALLERY_BLOB_CACHE_MAX,
  MINI_APP_GALLERY_CACHE_KEY_PREFIX,
  MINI_APP_GALLERY_CACHE_NAME,
  MINI_APP_GALLERY_CACHE_PRUNE_BATCH_SIZE,
  MINI_APP_GALLERY_CACHE_TTL_MS,
  MINI_APP_GALLERY_CACHED_AT_HEADER,
} from "../consts/miniApp";
import { MINUTE_MS } from "../consts/time";
import type {
  CachedGalleryBinaryEntry,
  MiniAppGalleryCacheBucket,
  MiniAppGalleryCacheStorage,
} from "../types/miniApp/gallery";
import type { TelegramWindow } from "../types/miniApp/host";

/** 写入图库 7 天协商缓存条目时的参数。 */
export interface WriteCachedGalleryImageOptions {
  /** 图库图片文件名。 */
  readonly fileName: string;
  /** 服务端返回的图片原始二进制 `Blob`。 */
  readonly blob: Blob;
  /** 服务端响应下发的 `ETag` 字符串。 */
  readonly etag: string;
  /** 可选写入时刻毫秒时间戳（缺省取 `Date.now()`）。 */
  readonly nowMs?: number;
}

/** 已解析并通过 7 天时效校验的持久化缓存条目元数据。 */
interface ParsedCacheEntryMeta {
  /** 缓存条目携带的服务端原始 `ETag`。 */
  readonly etag: string;
  /** 缓存条目写入时的本机毫秒时间戳。 */
  readonly cachedAt: number;
}

/**
 * 构造专用于浏览器 `CacheStorage` 的标准化虚拟 `https:` 缓存键（与真实网络 URL 及一次性 `?e=` 密文彻底隔离）。
 *
 * @param fileName 图库图片文件名
 * @returns 标准化虚拟缓存键 URL
 */
function buildGalleryCacheUrl(fileName: string): string {
  return `${MINI_APP_GALLERY_CACHE_KEY_PREFIX}${encodeURIComponent(fileName)}`;
}

/**
 * 获取或按需在全局宿主页签上下文初始化图库二进制与 `ETag` 内存协商缓存表
 * （作为 `CacheStorage` 热层与无 `caches` 环境的回退层）。
 *
 * @returns 文件名到缓存条目的可变映射表
 */
function getMemoryGalleryCache(): Map<string, Readonly<CachedGalleryBinaryEntry>> {
  const tgWindow: TelegramWindow = globalThis;
  const existing: Map<string, Readonly<CachedGalleryBinaryEntry>> | undefined =
    tgWindow.__copyNinjaGalleryBinaryCache;
  if (existing !== undefined) {
    return existing;
  }
  const created: Map<string, Readonly<CachedGalleryBinaryEntry>> = new Map();
  tgWindow.__copyNinjaGalleryBinaryCache = created;
  return created;
}

/**
 * 将图库缓存条目写入或更新至内存缓存表，超出 `MINI_APP_GALLERY_BLOB_CACHE_MAX` 时按最久未访问顺序淘汰。
 *
 * @param fileName 图库图片文件名
 * @param entry 完整的二进制缓存条目
 */
function setMemoryCacheEntry(
  fileName: string,
  entry: Readonly<CachedGalleryBinaryEntry>
): void {
  const memoryCache: Map<string, Readonly<CachedGalleryBinaryEntry>> =
    getMemoryGalleryCache();
  memoryCache.delete(fileName);
  memoryCache.set(fileName, entry);
  if (memoryCache.size > MINI_APP_GALLERY_BLOB_CACHE_MAX) {
    for (const [oldestName] of memoryCache) {
      if (memoryCache.size <= MINI_APP_GALLERY_BLOB_CACHE_MAX) {
        break;
      }
      memoryCache.delete(oldestName);
    }
  }
}

/**
 * 尝试打开浏览器标准 `CacheStorage` 中的图库缓存桶；
 * 宿主未实现 `caches`、处于受限隐私模式或存储抛出异常时安全返回 `null`。
 *
 * @returns 已打开的图库缓存桶，不可用或失败时返回 `null`
 */
async function openMiniAppGalleryCacheBucket(): Promise<Readonly<MiniAppGalleryCacheBucket> | null> {
  const tgWindow: TelegramWindow = globalThis;
  const cacheStorage: Readonly<MiniAppGalleryCacheStorage> | undefined =
    tgWindow.caches;
  if (
    cacheStorage === undefined ||
    typeof cacheStorage.open !== "function"
  ) {
    return null;
  }
  try {
    return await cacheStorage.open(MINI_APP_GALLERY_CACHE_NAME);
  } catch (_error: unknown) {
    return null;
  }
}

/**
 * 判断图库缓存条目的写入时间是否在 7 天（`MINI_APP_GALLERY_CACHE_TTL_MS`）有效窗口内
 * （允许最多 1 分钟的本机时钟回拨容差）。
 *
 * @param cachedAt 缓存条目的写入毫秒时间戳
 * @param nowMs 当前本机毫秒时间戳（缺省取 `Date.now()`）
 * @returns 写入时间合法且尚未满 7 天时返回 `true`
 */
function isGalleryCacheEntryFresh(
  cachedAt: number,
  nowMs: number = Date.now()
): boolean {
  return (
    Number.isFinite(cachedAt) &&
    cachedAt > 0 &&
    cachedAt <= nowMs + MINUTE_MS &&
    nowMs - cachedAt < MINI_APP_GALLERY_CACHE_TTL_MS
  );
}

/**
 * 解析并校验 `CacheStorage` 命中响应头的 `ETag` 与 7 天写入时间戳。
 *
 * @param response `CacheStorage` 中匹配的响应对象
 * @param nowMs 当前毫秒时间戳
 * @returns 合法且未过期时返回 `{ etag, cachedAt }`，否则返回 `null`
 */
function parseFreshCacheResponseMeta(
  response: Response,
  nowMs: number
): Readonly<ParsedCacheEntryMeta> | null {
  const etag: string = response.headers.get("etag")?.trim() ?? "";
  const rawCachedAt: string =
    response.headers.get(MINI_APP_GALLERY_CACHED_AT_HEADER)?.trim() ?? "";
  if (etag.length === 0 || rawCachedAt.length === 0) {
    return null;
  }
  const cachedAt: number = Number(rawCachedAt);
  if (!isGalleryCacheEntryFresh(cachedAt, nowMs)) {
    return null;
  }
  return { etag, cachedAt };
}

/**
 * 清扫内存缓存表与 `CacheStorage` 持久化桶中已满 7 天或缺少 `ETag`/时间戳的陈旧图库条目。
 *
 * @param nowMs 当前本机毫秒时间戳（缺省取 `Date.now()`）
 */
export async function pruneExpiredMiniAppGalleryCache(
  nowMs: number = Date.now()
): Promise<void> {
  const memoryCache: Map<string, Readonly<CachedGalleryBinaryEntry>> =
    getMemoryGalleryCache();
  for (const [fileName, entry] of memoryCache) {
    if (
      entry.etag.trim().length === 0 ||
      !isGalleryCacheEntryFresh(entry.cachedAt, nowMs)
    ) {
      memoryCache.delete(fileName);
    }
  }
  const bucket: Readonly<MiniAppGalleryCacheBucket> | null =
    await openMiniAppGalleryCacheBucket();
  if (bucket === null || typeof bucket.keys !== "function") {
    return;
  }
  try {
    const requests: readonly Request[] = await bucket.keys();
    for (
      let offset: number = 0;
      offset < requests.length;
      offset += MINI_APP_GALLERY_CACHE_PRUNE_BATCH_SIZE
    ) {
      const batch: readonly Request[] = requests.slice(
        offset,
        offset + MINI_APP_GALLERY_CACHE_PRUNE_BATCH_SIZE
      );
      await Promise.allSettled(
        batch.map(async (req: Request): Promise<void> => {
          const keyUrl: string = req.url;
          if (!keyUrl.startsWith(MINI_APP_GALLERY_CACHE_KEY_PREFIX)) {
            return;
          }
          const matched: Response | undefined = await bucket.match(keyUrl);
          if (
            matched !== undefined &&
            parseFreshCacheResponseMeta(matched, nowMs) === null
          ) {
            await bucket.delete(keyUrl);
          }
        })
      );
    }
  } catch (_error: unknown) {
    // 忽略受限宿主环境 CacheStorage 清扫失败
  }
}

/**
 * 读取指定图库图片文件的 7 天协商缓存条目（优先命中内存热层并刷新 LRU 顺序，其次从 `CacheStorage` 恢复并回填内存层）；
 * 首轮读取通过单飞 `Promise` 共享一次过期持久化条目清扫并在完成后继续读写，过期或损坏条目立即删除并返回 `null`。
 *
 * @param fileName 图库图片文件名
 * @param nowMs 当前本机毫秒时间戳（缺省取 `Date.now()`）
 * @returns 有效且未满 7 天的缓存条目；未命中或已过期时返回 `null`
 */
export async function readCachedMiniAppGalleryImage(
  fileName: string,
  nowMs: number = Date.now()
): Promise<Readonly<CachedGalleryBinaryEntry> | null> {
  const tgWindow: TelegramWindow = globalThis;
  let prunePromise: Promise<void> | undefined =
    tgWindow.__copyNinjaGalleryCachePrunePromise;
  if (prunePromise === undefined) {
    prunePromise = pruneExpiredMiniAppGalleryCache(nowMs);
    tgWindow.__copyNinjaGalleryCachePrunePromise = prunePromise;
  }
  await prunePromise;

  const memoryCache: Map<string, Readonly<CachedGalleryBinaryEntry>> =
    getMemoryGalleryCache();
  const memEntry: Readonly<CachedGalleryBinaryEntry> | undefined =
    memoryCache.get(fileName);
  if (memEntry !== undefined) {
    if (
      memEntry.etag.trim().length > 0 &&
      isGalleryCacheEntryFresh(memEntry.cachedAt, nowMs)
    ) {
      memoryCache.delete(fileName);
      memoryCache.set(fileName, memEntry);
      return memEntry;
    }
    memoryCache.delete(fileName);
  }

  const bucket: Readonly<MiniAppGalleryCacheBucket> | null =
    await openMiniAppGalleryCacheBucket();
  if (bucket === null) {
    return null;
  }
  const cacheUrl: string = buildGalleryCacheUrl(fileName);
  try {
    const matched: Response | undefined = await bucket.match(cacheUrl);
    if (matched === undefined) {
      return null;
    }
    const meta: Readonly<ParsedCacheEntryMeta> | null =
      parseFreshCacheResponseMeta(matched, nowMs);
    if (meta === null) {
      await bucket.delete(cacheUrl);
      return null;
    }
    const blob: Blob = await matched.blob();
    const hydrated: Readonly<CachedGalleryBinaryEntry> = {
      blob,
      etag: meta.etag,
      cachedAt: meta.cachedAt,
    };
    setMemoryCacheEntry(fileName, hydrated);
    return hydrated;
  } catch (_error: unknown) {
    return null;
  }
}

/**
 * 将服务端新下发的图库图片 `Blob` 与 `ETag` 写入内存热层与 `CacheStorage`（记录写入时间戳以在满 7 天后强制重拉）；
 * `ETag` 空白时跳过写入。
 *
 * @param options 图库缓存条目写入参数（含文件名、二进制 `Blob`、响应 `ETag` 与可选写入时间戳）
 */
export async function writeCachedMiniAppGalleryImage({
  fileName,
  blob,
  etag,
  nowMs,
}: Readonly<WriteCachedGalleryImageOptions>): Promise<void> {
  const trimmedEtag: string = etag.trim();
  if (trimmedEtag.length === 0) {
    return;
  }
  const cachedAt: number = nowMs ?? Date.now();
  setMemoryCacheEntry(fileName, {
    blob,
    etag: trimmedEtag,
    cachedAt,
  });
  const bucket: Readonly<MiniAppGalleryCacheBucket> | null =
    await openMiniAppGalleryCacheBucket();
  if (bucket === null) {
    return;
  }
  const contentType: string =
    blob.type.length > 0 ? blob.type : "application/octet-stream";
  const response: Response = new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "ETag": trimmedEtag,
      [MINI_APP_GALLERY_CACHED_AT_HEADER]: String(cachedAt),
    },
  });
  try {
    await bucket.put(buildGalleryCacheUrl(fileName), response);
  } catch (_error: unknown) {
    // 忽略受限宿主环境 CacheStorage 写入异常，内存协商缓存仍保持可用
  }
}

/**
 * 立即从内存缓存表与 `CacheStorage` 持久化桶中驱逐指定文件名的图库缓存（图片被删除或服务端返回 `404` 时调用）。
 *
 * @param fileName 图库图片文件名
 */
export async function evictCachedMiniAppGalleryImage(
  fileName: string
): Promise<void> {
  const memoryCache: Map<string, Readonly<CachedGalleryBinaryEntry>> =
    getMemoryGalleryCache();
  memoryCache.delete(fileName);
  const bucket: Readonly<MiniAppGalleryCacheBucket> | null =
    await openMiniAppGalleryCacheBucket();
  if (bucket === null) {
    return;
  }
  try {
    await bucket.delete(buildGalleryCacheUrl(fileName));
  } catch (_error: unknown) {
    // 忽略受限宿主环境 CacheStorage 删除异常
  }
}

/**
 * 重置图库 7 天协商缓存的全部内存与持久化状态（仅供测试隔离使用）。
 */
export async function clearMiniAppGalleryImageCacheForTest(): Promise<void> {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.__copyNinjaGalleryBinaryCache?.clear();
  tgWindow.__copyNinjaGalleryBinaryCache = undefined;
  tgWindow.__copyNinjaGalleryCachePrunePromise = undefined;
  try {
    await tgWindow.caches?.delete?.(MINI_APP_GALLERY_CACHE_NAME);
  } catch (_error: unknown) {
    // 忽略测试重置时的存储异常
  }
}
