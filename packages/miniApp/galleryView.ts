import { getAssetConfig } from "../config/assets";
import {
  MINI_APP_GALLERY_DEFAULT_PAGE_SIZE,
  MINI_APP_GALLERY_MAX_PAGE_SIZE,
  MINI_APP_GALLERY_SAFE_FILE_NAME_PATTERN,
} from "../consts/miniApp";
import {
  RANDOM_IMAGE_MAX_BYTES,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
} from "../consts/randomImage";
import { readImageDimensions, sniffImageFormat } from "../infra/image";
import type { SniffedImageFormat } from "../infra/image";
import {
  isRandomImageDirectory,
  listRandomImageEntries,
  statRandomImageFile,
  storeRandomImage,
} from "../infra/randomImage";
import { isSendablePhotoDimensions } from "../libs/telegramImage";
import { formatLocalTime } from "../libs/time";
import type { ImageDimensions } from "../types/hImage";
import type {
  MiniAppGalleryItem,
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
} from "../types/miniApp";
import type {
  RandomImageEntry,
  RandomImageMimeType,
  StoreRandomImageResult,
} from "../types/randomImage";

/** 已解析并通过安全校验的图库单张图片文件句柄信息。 */
export interface ResolvedMiniAppGalleryFile {
  /** 本机图片文件的绝对路径。 */
  readonly filePath: string;
  /** 图片 MIME 类型。 */
  readonly mimeType: RandomImageMimeType;
  /** 文件字节大小。 */
  readonly sizeBytes: number;
}

/**
 * 分页读取当前配置的图库目录（`getAssetConfig().randomHImageDirectory`）内的图片列表；目录不存在或为空时原样返回空列表，不自动创建目录。
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

  const rawEntries: readonly Readonly<RandomImageEntry>[] | null =
    await listRandomImageEntries(directory);
  if (rawEntries === null) {
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

  const candidates: Readonly<RandomImageEntry>[] = [...rawEntries].sort(
    (a: Readonly<RandomImageEntry>, b: Readonly<RandomImageEntry>): number =>
      b.mtimeMs - a.mtimeMs || a.fileName.localeCompare(b.fileName)
  );

  const total: number = candidates.length;
  const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage: number =
    pageRaw !== undefined && Number.isSafeInteger(pageRaw)
      ? Math.max(1, pageRaw)
      : 1;
  const page: number = Math.min(totalPages, requestedPage);
  const startOffset: number = (page - 1) * pageSize;
  const slice: readonly Readonly<RandomImageEntry>[] = candidates.slice(
    startOffset,
    startOffset + pageSize
  );

  const items: Readonly<MiniAppGalleryItem>[] = slice.map(
    (record: Readonly<RandomImageEntry>): Readonly<MiniAppGalleryItem> => ({
      fileName: record.fileName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      updatedAt: formatLocalTime(Math.max(0, Math.trunc(record.mtimeMs))),
    })
  );

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
    filePath: entry.filePath,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes,
  };
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
      message: "上传的图片内容为空。",
    };
  }
  if (bytes.byteLength > RANDOM_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      outcome: "tooLarge",
      message: "图片体积超过 10 MiB 上限。",
    };
  }

  const directory: string = getAssetConfig().randomHImageDirectory;
  if (!await isRandomImageDirectory(directory)) {
    return {
      ok: false,
      outcome: "missingDirectory",
      message: "当前配置的图库目录不存在，无法上传入库。",
    };
  }

  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (!RANDOM_IMAGE_SAVE_EXTENSIONS.has(format)) {
    return {
      ok: false,
      outcome: "unsupportedFormat",
      message: "仅支持 JPEG、PNG 或 WebP 格式图片。",
    };
  }

  const dimensions: ImageDimensions | null = await readImageDimensions(bytes);
  if (dimensions === null) {
    return {
      ok: false,
      outcome: "failed",
      message: "无法解析图片像素尺寸，文件可能已损坏。",
    };
  }
  if (!isSendablePhotoDimensions(dimensions)) {
    return {
      ok: false,
      outcome: "invalidDimensions",
      message: `图片尺寸 (${dimensions.width}×${dimensions.height}) 不符合 Telegram 发送门槛（宽高之和 ≤ 10000 且长宽比 ≤ 20）。`,
    };
  }

  try {
    const stored: StoreRandomImageResult = await storeRandomImage(directory, bytes);
    if (stored.status === "stored") {
      return {
        ok: true,
        outcome: "added",
        fileName: stored.fileName,
        message: `已按 SHA-256 收录：${stored.fileName}`,
      };
    }
    if (stored.status === "existing") {
      return {
        ok: true,
        outcome: "existing",
        fileName: stored.fileName,
        message: `图库已存在相同 SHA-256 图片：${stored.fileName}`,
      };
    }
    return {
      ok: false,
      outcome: "unsupportedFormat",
      message: "仅支持 JPEG、PNG 或 WebP 格式图片。",
    };
  } catch (_error: unknown) {
    return {
      ok: false,
      outcome: "failed",
      message: "写入图库目录失败。",
    };
  }
}
