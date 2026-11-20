/**
 * Mini App 前端随机图库分页、上传大小上限、本地 `CacheStorage` 协商缓存与附件下载回收常量。
 */

import { DAY_MS } from "../time";

/** 图库分页接口缺省每页返回的图片张数（10 张）。不变量：属于 `MINI_APP_GALLERY_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/gallery.ts`。 */
export const MINI_APP_GALLERY_DEFAULT_PAGE_SIZE: number = 10;

/** 图库页面可选的每页张数档位（默认 10 张，可切换 15、20 张）。不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/GalleryPage.tsx`。 */
export const MINI_APP_GALLERY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 图库预览缩略图与大图在组件内缓存的 `blob:` 对象 URL 上限条数（64 条）。
 * 不变量：正整数；超出上限时按插入顺序淘汰最旧的非当前可见条目并调用 `URL.revokeObjectURL` 释放。所属模块：`packages/mini-app-frontend/libs/useGalleryImageUrls.ts`。
 */
export const MINI_APP_GALLERY_BLOB_CACHE_MAX: number = 64;

/**
 * 前端受保护图库二进制图片与 `ETag` 协商缓存的最长保留毫秒数（7 天 = `604_800_000` 毫秒）。
 * 不变量：正整数毫秒数；与服务端 `MINI_APP_GALLERY_FILE_CACHE_CONTROL` 的 `max-age=604800` 对齐，满 7 天后自动淘汰并强制全量重拉。
 * 所属模块：`packages/mini-app-frontend/libs/galleryImageCache.ts`。
 */
export const MINI_APP_GALLERY_CACHE_TTL_MS: number = 7 * DAY_MS;

/**
 * 前端图库持久化缓存清扫过期条目时每批并发检查的请求键数量上限（16 条）。
 * 不变量：正整数；用于通过 `Promise.allSettled` 有界分批核验 `CacheStorage` 写入时间戳，兼顾首屏吞吐与受限宿主并发稳定性。
 * 所属模块：`packages/mini-app-frontend/libs/galleryImageCache.ts`。
 */
export const MINI_APP_GALLERY_CACHE_PRUNE_BATCH_SIZE: number = 16;

/**
 * 浏览器标准 `CacheStorage` 中保存图库协商缓存条目的命名空间桶名。
 * 不变量：非空版本号后缀字符串；与 `?e=` 加密请求解耦，仅以标准化缓存键存储最近一次验证通过的图片二进制与 `ETag`。
 * 所属模块：`packages/mini-app-frontend/libs/galleryImageCache.ts`。
 */
export const MINI_APP_GALLERY_CACHE_NAME: string =
  "copy-ninja-mini-app-gallery-v1";

/**
 * 浏览器 `CacheStorage` 条目使用的虚拟 `https:` 键前缀（与真实网络 URL 与一次性 `?e=` 密文彻底隔离）。
 * 不变量：以 `"https://"` 开头且以 `"/"` 结尾，确保 `CacheStorage.match` / `put` / `delete` 在所有标准 WebView 中合法执行。
 * 所属模块：`packages/mini-app-frontend/libs/galleryImageCache.ts`。
 */
export const MINI_APP_GALLERY_CACHE_KEY_PREFIX: string =
  "https://mini-app.local/__gallery_cache__/";

/**
 * 写入 `CacheStorage` 条目响应头以记录本地缓存写入毫秒时间戳的自定义响应头名（小写）。
 * 不变量：仅存在于本地 `CacheStorage` 人工构造的 `Response` 中，不发往网络；用于判定 7 天绝对过期淘汰边界。
 * 所属模块：`packages/mini-app-frontend/libs/galleryImageCache.ts`。
 */
export const MINI_APP_GALLERY_CACHED_AT_HEADER: string =
  "x-mini-app-cached-at";

/**
 * 随机图库单张图片上传允许的最大字节数（10 MiB）。
 * 不变量：正整数；取值与 `packages/consts/imageGallery.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/gallery.ts`。
 */
export const RANDOM_IMAGE_MAX_BYTES: number = 10 * 1_024 * 1_024;

/**
 * 不支持 Telegram 原生 `downloadFile` 时，图库附件以 `blob:` 对象 URL 经隐藏链接保存后，延迟释放该对象 URL 的毫秒数。
 * 不变量：正整数毫秒数，须留足浏览器开始读取下载内容的时间。所属模块：`packages/mini-app-frontend/api/galleryDownload.ts`。
 */
export const MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS: number = 60_000;
