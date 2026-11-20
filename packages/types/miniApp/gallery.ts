import type { RandomImageMimeType } from "../imageGallery";

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

/** 已解析并通过安全校验的图库单张图片文件句柄信息。 */
export interface ResolvedMiniAppGalleryFile {
  readonly fileName: string;
  readonly filePath: string;
  readonly mimeType: RandomImageMimeType;
  readonly sizeBytes: number;
  readonly etag: string;
}

/** 主线程内存中保存的 60 秒一次性图库下载票据记录（单次 `GET` 消费即焚）。 */
export interface MiniAppGalleryDownloadTicketRecord {
  /** 64 位十六进制随机一次性下载票据。 */
  readonly ticket: string;
  /** 绑定该票据的活跃二次认证会话内部谱系标识（跨滑动轮换保持不变，登出/锁定/淘汰/过期时按谱系吊销）。 */
  readonly sessionLineageId: string;
  /** 经校验规范化的图库文件名（文件删除时同步吊销关联票据）。 */
  readonly fileName: string;
  /** 下载响应与前端下载提示共用的安全下载文件名。 */
  readonly downloadFileName: string;
  /** 票据签发毫秒时间戳。 */
  readonly createdAt: number;
  /** 票据过期毫秒时间戳（`createdAt + MINI_APP_DOWNLOAD_TICKET_TTL_MS`）。 */
  readonly expiresAt: number;
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
