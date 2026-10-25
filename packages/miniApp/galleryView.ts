import { getAssetConfig } from "../config/assets";
import {
  MINI_APP_GALLERY_DEFAULT_PAGE_SIZE,
  MINI_APP_GALLERY_MAX_PAGE_SIZE,
  MINI_APP_GALLERY_SAFE_FILE_NAME_PATTERN,
  MINI_APP_SVG_SAFE_FILE_NAME_PATTERN,
} from "../consts/miniApp";
import {
  RANDOM_IMAGE_MAX_BYTES,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
} from "../consts/randomImage";
import { readImageDimensions, sniffImageFormat } from "../infra/image";
import type { SniffedImageFormat } from "../infra/image";
import {
  deleteRandomImageFile,
  isRandomImageDirectory,
  listRandomImageEntries,
  statRandomImageFile,
  storeRandomImage,
} from "../infra/randomImage";
import { isSendablePhotoDimensions } from "../libs/telegramImage";
import { formatLocalTime } from "../libs/time";
import type { ImageDimensions } from "../types/hImage";
import type {
  MiniAppGalleryDeleteResult,
  MiniAppGalleryItem,
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
  ResolvedMiniAppGalleryFile,
  ResolvedMiniAppSvgResource,
} from "../types/miniApp";
import type {
  RandomImageEntry,
  StoreRandomImageResult,
} from "../types/randomImage";

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
    fileName: entry.fileName,
    filePath: entry.filePath,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes,
    etag: `"gallery-${decodedName}-${entry.sizeBytes}"`,
  };
}

/**
 * 校验并解析 `packages/miniApp/miniAppResoures/` 目录内的受保护 SVG 图标资源文件，防止路径穿越或非 `.svg` 读取。
 * @param rawFileName URL 路径参数中的原始 SVG 文件名。
 * @returns 通过安全校验的 `BunFile`、MIME、字节大小与 `ETag`；文件不存在或文件名不合法时返回 `null`。
 */
export async function readMiniAppSvgResource(
  rawFileName: string
): Promise<Readonly<ResolvedMiniAppSvgResource> | null> {
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(rawFileName).trim();
  } catch (_error: unknown) {
    return null;
  }
  if (
    decodedName.length === 0 ||
    decodedName.includes("..") ||
    !MINI_APP_SVG_SAFE_FILE_NAME_PATTERN.test(decodedName)
  ) {
    return null;
  }
  const svgUrl: URL = new URL(`./miniAppResoures/${decodedName}`, import.meta.url);
  const file: Bun.BunFile = Bun.file(svgUrl);
  if (!(await file.exists())) {
    return null;
  }
  return {
    file,
    mimeType: "image/svg+xml; charset=utf-8",
    sizeBytes: file.size,
    etag: `"svg-${decodedName}-${file.size}"`,
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
      message: "笨蛋杂鱼♡，连图片文件名格式都搞错了！",
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
      message: "笨蛋杂鱼♡，连图片文件名格式都搞错了！",
    };
  }

  const directory: string = getAssetConfig().randomHImageDirectory;
  try {
    const deleted: boolean = await deleteRandomImageFile(directory, decodedName);
    if (!deleted) {
      return {
        ok: false,
        outcome: "notFound",
        message: "杂鱼♡，这张图片早就已经被删掉或者不存在啦！",
      };
    }
    return {
      ok: true,
      outcome: "deleted",
      fileName: decodedName,
      message: `哼，本天才已经帮杂鱼把 ${decodedName} 删掉啦♡`,
    };
  } catch (_error: unknown) {
    return {
      ok: false,
      outcome: "failed",
      message: "啧，从图库目录删除图片失败了，杂鱼快去检查磁盘权限♡",
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
      message: "笨蛋杂鱼♡，上传的图片内容居然是空的！",
    };
  }
  if (bytes.byteLength > RANDOM_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      outcome: "tooLarge",
      message: "杂鱼♡，图片体积超过 10 MiB 上限啦，塞不进去！",
    };
  }

  const directory: string = getAssetConfig().randomHImageDirectory;
  if (!await isRandomImageDirectory(directory)) {
    return {
      ok: false,
      outcome: "missingDirectory",
      message: "啧，当前配置的图库目录不存在，杂鱼还没创建好目录就没法入库♡",
    };
  }

  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (!RANDOM_IMAGE_SAVE_EXTENSIONS.has(format)) {
    return {
      ok: false,
      outcome: "unsupportedFormat",
      message: "笨蛋杂鱼♡，只支持 JPEG、PNG 或 WebP 格式的图片哦！",
    };
  }

  const dimensions: ImageDimensions | null = await readImageDimensions(bytes);
  if (dimensions === null) {
    return {
      ok: false,
      outcome: "failed",
      message: "杂鱼♡，根本无法解析这张图片的像素尺寸，文件是不是坏掉啦？",
    };
  }
  if (!isSendablePhotoDimensions(dimensions)) {
    return {
      ok: false,
      outcome: "invalidDimensions",
      message: `杂鱼♡，图片尺寸 (${dimensions.width}×${dimensions.height}) 不符合 Telegram 发送门槛（宽高之和 ≤ 10000 且长宽比 ≤ 20）！`,
    };
  }

  try {
    const stored: StoreRandomImageResult = await storeRandomImage(directory, bytes);
    if (stored.status === "stored") {
      return {
        ok: true,
        outcome: "added",
        fileName: stored.fileName,
        message: `哼，本天才已按 SHA-256 帮杂鱼收录好啦：${stored.fileName}♡`,
      };
    }
    if (stored.status === "existing") {
      return {
        ok: true,
        outcome: "existing",
        fileName: stored.fileName,
        message: `笨蛋杂鱼♡，图库里早就有一模一样的 SHA-256 图片啦：${stored.fileName}`,
      };
    }
    return {
      ok: false,
      outcome: "unsupportedFormat",
      message: "笨蛋杂鱼♡，只支持 JPEG、PNG 或 WebP 格式的图片哦！",
    };
  } catch (_error: unknown) {
    return {
      ok: false,
      outcome: "failed",
      message: "啧，写入图库目录失败了，杂鱼快去检查磁盘♡",
    };
  }
}
