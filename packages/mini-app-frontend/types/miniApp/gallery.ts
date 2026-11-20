/**
 * Mini App 前端随机图库接口契约与本地 `CacheStorage` 协商缓存类型。
 * 与服务端 `packages/types/miniApp/gallery.ts` 同名的声明保持编译期恒等（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）；
 * 缓存接口仅属于前端。
 */

/** 图库分页列表中的单张图片元数据视图。 */
export interface MiniAppGalleryItem {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

/** 图库分页响应视图。 */
export interface MiniAppGalleryPage {
  readonly directory: string;
  readonly exists: boolean;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly items: readonly Readonly<MiniAppGalleryItem>[];
}

/** Mini App 图库单张图片上传入库的结局分类。 */
export type MiniAppGalleryUploadOutcome =
  | "added" | "existing" | "missingDirectory" | "empty"
  | "tooLarge" | "unsupportedFormat" | "invalidDimensions" | "failed";

/** Mini App 图库上传单张图片的响应结果。 */
export interface MiniAppGalleryUploadResult {
  readonly ok: boolean;
  readonly outcome: MiniAppGalleryUploadOutcome;
  readonly fileName?: string;
  /** 服务端返回的英文状态码字串，由前端映射为多语言提示。 */
  readonly message: string;
  /** 尺寸超限时检测到的图片像素宽度。 */
  readonly width?: number;
  /** 尺寸超限时检测到的图片像素高度。 */
  readonly height?: number;
}

/** Mini App 图库单张图片删除的结局分类。 */
export type MiniAppGalleryDeleteOutcome = "deleted" | "notFound" | "invalidFileName" | "failed";

/** Mini App 图库删除单张图片的响应结果。 */
export interface MiniAppGalleryDeleteResult {
  readonly ok: boolean;
  readonly outcome: MiniAppGalleryDeleteOutcome;
  readonly fileName?: string;
  readonly message: string;
}

/** `POST /api/gallery/download-ticket` 返回的一次性图库文件下载票据响应。 */
export interface MiniAppGalleryDownloadTicketResponse {
  readonly ok: true;
  /** 64 位十六进制一次性下载票据。 */
  readonly ticket: string;
  /** 票据过期毫秒时间戳。 */
  readonly expiresAt: number;
  /** 建议保存的文件名。 */
  readonly downloadFileName: string;
}

/** 前端图库本地 7 天协商缓存保存的单张图片二进制、服务端 `ETag` 与写入时间戳条目。 */
export interface CachedGalleryBinaryEntry {
  /** 缓存的原始图片二进制 `Blob`。 */
  readonly blob: Blob;
  /** 服务端最近一次 `200 OK` 响应下发的原始 `ETag` 字符串。 */
  readonly etag: string;
  /** 本条二进制缓存写入或更新时的本机毫秒时间戳（用于 7 天绝对过期判断）。 */
  readonly cachedAt: number;
}

/** 浏览器 `CacheStorage.open()` 返回的单个图库缓存桶最小异步读写接口。 */
export interface MiniAppGalleryCacheBucket {
  /** 按标准化缓存键 URL 查找已存条目。 */
  readonly match: (request: string) => Promise<Response | undefined>;
  /** 按标准化缓存键 URL 写入或覆盖响应条目。 */
  readonly put: (request: string, response: Response) => Promise<void>;
  /** 按标准化缓存键 URL 删除条目；存在并删除时返回 `true`。 */
  readonly delete: (request: string) => Promise<boolean>;
  /** 可选枚举桶内全部已缓存请求键，供启动清理满 7 天陈旧条目使用。 */
  readonly keys?: () => Promise<readonly Request[]>;
}

/** 浏览器全局 `caches`（`CacheStorage`）的图库持久化缓存最小接口。 */
export interface MiniAppGalleryCacheStorage {
  /** 打开指定名称的持久化缓存桶。 */
  readonly open: (cacheName: string) => Promise<MiniAppGalleryCacheBucket>;
  /** 可选整桶删除接口（供单测重置隔离使用）。 */
  readonly delete?: (cacheName: string) => Promise<boolean>;
}
