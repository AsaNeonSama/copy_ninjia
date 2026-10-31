import { getAssetConfig } from "../../config/assets";
import {
  MINI_APP_GALLERY_DEFAULT_PAGE_SIZE,
  MINI_APP_GALLERY_MAX_PAGE_SIZE,
  MINI_APP_GALLERY_SAFE_FILE_NAME_PATTERN,
} from "../../consts/miniApp";
import {
  RANDOM_IMAGE_MAX_BYTES,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
} from "../../consts/randomImage";
import { readImageDimensions, sniffImageFormat } from "../../infra/image";
import type { SniffedImageFormat } from "../../infra/image";
import {
  deleteRandomImageFile,
  isRandomImageDirectory,
  listRandomImageNames,
  statRandomImageFile,
  storeRandomImage,
} from "../../infra/randomImage";
import { isSendablePhotoDimensions } from "../../libs/telegramImage";
import { formatLocalTime } from "../../libs/time";
import type { ImageDimensions } from "../../types/hImage";
import type {
  MiniAppGalleryDeleteResult,
  MiniAppGalleryItem,
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
  ResolvedMiniAppGalleryFile,
} from "../../types/miniApp";
import type {
  RandomImageEntry,
  StoreRandomImageResult,
} from "../../types/randomImage";

/**
 * 分页读取当前配置的图库目录（`getAssetConfig().randomHImageDirectory`）内的图片列表：
 * 直接按内存文件名缓存切出当前页切片（不重复扫描或排序），再仅对当前页的图片文件执行 `lstat` 读取元数据；目录不存在或为空时原样返回空列表，不自动创建目录。
 * @param pageRaw 请求页码（从 1 开始，缺省为 1）。
 * @param pageSizeRaw 请求每页张数（缺省为 `MINI_APP_GALLERY_DEFAULT_PAGE_SIZE`）。
 * @returns 图库分页视图。
 */
export async function listMiniAppGalleryPage(
  pageRaw?: number,
  pageSizeRaw?: number
): Promise<Readonly<MiniAppGalleryPage>> {
  const directory: string = getAssetConfig().randomHImageDirectory;
  const pageSize: number =
    pageSizeRaw !== undefined && Number.isSafeInteger(pageSizeRaw)
      ? Math.min(MINI_APP_GALLERY_MAX_PAGE_SIZE, Math.max(1, pageSizeRaw))
      : MINI_APP_GALLERY_DEFAULT_PAGE_SIZE;

  const candidates: readonly string[] | null =
    await listRandomImageNames(directory);
  if (candidates === null) {
    return {
      directory,
      exists: false,
      total: 0,
      page: 1,
      pageSize,
      totalPages: 1,
      items: [],
    };
  }

  const total: number = candidates.length;
  const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage: number =
    pageRaw !== undefined && Number.isSafeInteger(pageRaw)
      ? Math.max(1, pageRaw)
      : 1;
  const page: number = Math.min(totalPages, requestedPage);
  const startOffset: number = (page - 1) * pageSize;
  const slice: readonly string[] = candidates.slice(
    startOffset,
    startOffset + pageSize
  );

  const items: Readonly<MiniAppGalleryItem>[] = [];
  for (const fileName of slice) {
    const record: Readonly<RandomImageEntry> | null = await statRandomImageFile(
      directory,
      fileName
    );
    if (record === null) continue;
    items.push({
      fileName: record.fileName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      updatedAt: formatLocalTime(Math.max(0, Math.trunc(record.mtimeMs))),
    });
  }

  return {
    directory,
    exists: true,
    total,
    page,
    pageSize,
    totalPages,
    items,
  };
}

/**
 * 校验并解析图库目录内的单张图片文件路径，防止路径穿越、隐藏文件读取或符号链接越权。
 * @param rawFileName URL 路径参数中的原始文件名。
 * @returns 通过安全校验的文件路径、MIME 与字节大小；文件不存在或文件名不合法时返回 `null`。
 */
export async function readMiniAppGalleryFile(
  rawFileName: string
): Promise<Readonly<ResolvedMiniAppGalleryFile> | null> {
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(rawFileName).trim();
  } catch (_error: unknown) {
    return null;
  }
  if (
    decodedName.length === 0 ||
    decodedName.includes("..") ||
    !MINI_APP_GALLERY_SAFE_FILE_NAME_PATTERN.test(decodedName)
  ) {
    return null;
  }

  const directory: string = getAssetConfig().randomHImageDirectory;
  const entry: Readonly<RandomImageEntry> | null = await statRandomImageFile(
    directory,
    decodedName
  );
  if (entry === null) return null;
  return {
    fileName: entry.fileName,
    filePath: entry.filePath,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes,
    etag: `"gallery-${decodedName}-${entry.sizeBytes}"`,
  };
}

/**
 * 校验并从图库目录删除指定文件名的单张图片。
 * @param rawFileName URL 路径参数或请求体中的原始文件名。
 * @returns 结构化的删除结果。
 */
export async function deleteMiniAppGalleryImage(
  rawFileName: string
): Promise<Readonly<MiniAppGalleryDeleteResult>> {
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(rawFileName).trim();
  } catch (_error: unknown) {
    return {
      ok: false,
      outcome: "invalidFileName",
      message: "GALLERY_INVALID_FILE_NAME",
    };
  }
  if (
    decodedName.length === 0 ||
    decodedName.includes("..") ||
    !MINI_APP_GALLERY_SAFE_FILE_NAME_PATTERN.test(decodedName)
  ) {
    return {
      ok: false,
      outcome: "invalidFileName",
      message: "GALLERY_INVALID_FILE_NAME",
    };
  }

  const directory: string = getAssetConfig().randomHImageDirectory;
  try {
    const deleted: boolean = await deleteRandomImageFile(directory, decodedName);
    if (!deleted) {
      return {
        ok: false,
        outcome: "notFound",
        fileName: decodedName,
        message: "GALLERY_IMAGE_NOT_FOUND",
      };
    }
    return {
      ok: true,
      outcome: "deleted",
      fileName: decodedName,
      message: "GALLERY_IMAGE_DELETED",
    };
  } catch (_error: unknown) {
    return {
      ok: false,
      outcome: "failed",
      fileName: decodedName,
      message: "GALLERY_DELETE_FAILED",
    };
  }
}

/**
 * 按现有 `/h_image add` 协议（字节上限、魔数格式嗅探、`sendPhoto` 像素尺寸门槛、内容 SHA-256 命名原子入库）将上传的图片写入当前配置的图库目录。
 * @param bytes 上传的图片原始字节数组。
 * @returns 结构化的上传入库结果。
 */
export async function uploadMiniAppGalleryImage(
  bytes: Uint8Array
): Promise<Readonly<MiniAppGalleryUploadResult>> {
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      outcome: "empty",
      message: "GALLERY_IMAGE_EMPTY",
    };
  }
  if (bytes.byteLength > RANDOM_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      outcome: "tooLarge",
      message: "GALLERY_IMAGE_TOO_LARGE",
    };
  }

  const directory: string = getAssetConfig().randomHImageDirectory;
  if (!await isRandomImageDirectory(directory)) {
    return {
      ok: false,
      outcome: "missingDirectory",
      message: "GALLERY_DIRECTORY_MISSING",
    };
  }

  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (!RANDOM_IMAGE_SAVE_EXTENSIONS.has(format)) {
    return {
      ok: false,
      outcome: "unsupportedFormat",
      message: "GALLERY_UNSUPPORTED_FORMAT",
    };
  }

  const dimensions: ImageDimensions | null = await readImageDimensions(bytes);
  if (dimensions === null) {
    return {
      ok: false,
      outcome: "failed",
      message: "GALLERY_UPLOAD_FAILED",
    };
  }
  if (!isSendablePhotoDimensions(dimensions)) {
    return {
      ok: false,
      outcome: "invalidDimensions",
      width: dimensions.width,
      height: dimensions.height,
      message: "GALLERY_INVALID_DIMENSIONS",
    };
  }

  try {
    const stored: StoreRandomImageResult = await storeRandomImage(directory, bytes);
    if (stored.status === "stored") {
      return {
        ok: true,
        outcome: "added",
        fileName: stored.fileName,
        message: "GALLERY_IMAGE_ADDED",
      };
    }
    if (stored.status === "existing") {
      return {
        ok: true,
        outcome: "existing",
        fileName: stored.fileName,
        message: "GALLERY_IMAGE_EXISTING",
      };
    }
    return {
      ok: false,
      outcome: "unsupportedFormat",
      message: "GALLERY_UNSUPPORTED_FORMAT",
    };
  } catch (_error: unknown) {
    return {
      ok: false,
      outcome: "failed",
      message: "GALLERY_UPLOAD_FAILED",
    };
  }
}
