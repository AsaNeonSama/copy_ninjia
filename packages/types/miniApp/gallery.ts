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
