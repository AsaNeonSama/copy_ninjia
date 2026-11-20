/**
 * 随机图库运行时读写操作：候选计数、均匀抽图、目录探测、Mini App 分页列表读取、单文件元数据核对、安全删除与按内容 SHA-256 原子收图。
 */

import { lstat, rename } from "node:fs/promises";
import type { Stats } from "node:fs";
import { extname, join } from "node:path";
import {
  RANDOM_IMAGE_EXTENSIONS,
  RANDOM_IMAGE_MAX_BYTES,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
  RANDOM_IMAGE_TEMP_PREFIX,
} from "../../consts/imageGallery";
import { isErrno } from "../../libs/errno";
import { sniffImageFormat } from "../../libs/imageFormat";
import { pickRandom } from "../../libs/random";
import {
  clearCachedRandomImageDirectory,
  isVanishedImageError,
  readOrLoadRandomImageCache,
  readOrLoadRandomImageGalleryCache,
  recordCachedRandomImage,
  removeCachedRandomImageName,
} from "./cache";
import type {
  RandomImageDirectoryCache,
  RandomImageEntry,
  RandomImageGalleryCache,
  RandomImageGalleryCacheEntry,
  RandomImageLibrary,
  RandomImageMimeType,
  RandomImagePick,
  StoreRandomImageResult,
} from "../../types/imageGallery";

/**
 * 统计当前图库有效图片张数（优先读取已加载的目录缓存，未缓存时列一次目录填充缓存）；目录读取失败原样上抛。
 * @param directory 专用图库目录的绝对路径。
 * @returns 包含当前有效图片张数的图库摘要。
 */
export async function readRandomImageLibrary(directory: string): Promise<RandomImageLibrary> {
  const cache: RandomImageDirectoryCache = await readOrLoadRandomImageCache(directory);
  return { size: cache.names.length };
}

/**
 * 从图库文件名缓存中均匀随机抽取一张不超过 `RANDOM_IMAGE_MAX_BYTES` 的图片并读取字节；
 * 抽中已消失的文件时同步从两边的缓存剔除，抽中超限文件时从本次剩余候选中剔除并继续抽取。
 * @param directory 专用图库目录的绝对路径。
 * @returns 抽取结果（成功读取图片字节，或目录缺失、为空、全部超限）。
 */
export async function pickRandomImage(directory: string): Promise<RandomImagePick> {
  let cache: RandomImageDirectoryCache;
  try {
    cache = await readOrLoadRandomImageCache(directory);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      clearCachedRandomImageDirectory(directory);
      return { status: "missingDirectory" };
    }
    throw error;
  }
  if (cache.names.length === 0) return { status: "empty" };

  let oversized: string | undefined;
  let candidates: string[] | null = null;
  for (
    let fileName: string | undefined = pickRandom(cache.names);
    fileName !== undefined;
    fileName = pickRandom(candidates ?? cache.names)
  ) {
    const path: string = join(directory, fileName);
    try {
      if ((await Bun.file(path).stat()).size > RANDOM_IMAGE_MAX_BYTES) {
        oversized = fileName;
        candidates ??= [...cache.names];
        const idx: number = candidates.indexOf(fileName);
        if (idx !== -1) candidates.splice(idx, 1);
        continue;
      }
      const mimeType: RandomImageMimeType = RANDOM_IMAGE_EXTENSIONS.get(extname(fileName).toLowerCase())!;
      return { status: "ok", bytes: await Bun.file(path).bytes(), mimeType, fileName };
    } catch (error: unknown) {
      if (!isVanishedImageError(error)) throw error;
    }
    removeCachedRandomImageName(directory, fileName);
    if (candidates !== null) {
      const idx: number = candidates.indexOf(fileName);
      if (idx !== -1) candidates.splice(idx, 1);
    }
  }
  return oversized === undefined ? { status: "empty" } : { status: "tooLarge", fileName: oversized };
}

/**
 * 路径此刻是不是目录（跟随符号链接）；不存在或读不到都按不是处理，若原缓存指向该失效目录则一并清空。
 * @param directory 待探测的目录路径。
 * @returns 路径存在且为目录时返回 true，否则返回 false。
 */
export async function isRandomImageDirectory(directory: string): Promise<boolean> {
  try {
    if ((await Bun.file(directory).stat()).isDirectory()) return true;
  } catch (_error: unknown) {
    // 路径不存在或不可访问时视为非目录
  }
  clearCachedRandomImageDirectory(directory);
  return false;
}

/**
 * 返回图库目录内已按修改时间从新到老（降序）缓存的全部有效普通图片缓存项（翻页不重复排序）；目录不存在或非目录时返回 `null`。
 * @param directory 专用图库目录的绝对路径。
 * @returns 按修改时间降序排列的有效图片缓存项只读数组；目录不存在或非目录时返回 `null`。
 */
export async function listRandomImageGalleryEntries(
  directory: string
): Promise<readonly Readonly<RandomImageGalleryCacheEntry>[] | null> {
  if (!await isRandomImageDirectory(directory)) return null;
  try {
    const cache: RandomImageGalleryCache = await readOrLoadRandomImageGalleryCache(directory);
    return cache.entries;
  } catch (error: unknown) {
    if (isVanishedImageError(error)) {
      clearCachedRandomImageDirectory(directory);
      return null;
    }
    throw error;
  }
}

/**
 * 核对图库目录内指定文件名的普通图片文件（不跟随文件级符号链接）并返回其路径与元数据；探测到文件已消失或非普通文件时同步从两边的缓存移除。
 * @param directory 专用图库目录的绝对路径。
 * @param fileName 已通过文件名形态校验的图片文件名。
 * @returns 有效普通图片文件的元数据；目录或文件不存在、为符号链接或扩展名不支持时返回 `null`。
 */
export async function statRandomImageFile(
  directory: string,
  fileName: string
): Promise<Readonly<RandomImageEntry> | null> {
  if (fileName.startsWith(".")) return null;
  const mimeType: RandomImageMimeType | undefined = RANDOM_IMAGE_EXTENSIONS.get(extname(fileName).toLowerCase());
  if (mimeType === undefined) return null;
  const filePath: string = join(directory, fileName);
  try {
    const stat: Stats = await lstat(filePath);
    if (!stat.isFile()) {
      removeCachedRandomImageName(directory, fileName);
      return null;
    }
    return { fileName, filePath, mimeType, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error: unknown) {
    if (isVanishedImageError(error)) {
      removeCachedRandomImageName(directory, fileName);
      return null;
    }
    throw error;
  }
}

/**
 * 安全删除图库目录内指定文件名的普通图片文件（不跟随文件级符号链接），并在删除成功或文件已消失时同步从两边的缓存移除。
 * @param directory 专用图库目录的绝对路径。
 * @param fileName 已通过文件名形态校验的图片文件名。
 * @returns 删除成功时返回 `true`；文件不存在、非普通图片文件或已消失时返回 `false`。
 */
export async function deleteRandomImageFile(directory: string, fileName: string): Promise<boolean> {
  const entry: Readonly<RandomImageEntry> | null = await statRandomImageFile(directory, fileName);
  if (entry === null) return false;
  try {
    await Bun.file(entry.filePath).delete();
    removeCachedRandomImageName(directory, fileName);
    return true;
  } catch (error: unknown) {
    if (isVanishedImageError(error)) {
      removeCachedRandomImageName(directory, fileName);
      return false;
    }
    throw error;
  }
}

/**
 * 将图片按魔数嗅探格式与内容 SHA-256 命名写入图库并同步维护两边的内存缓存：目标已存在时返回 `existing`；
 * 新增时先写同目录隐藏临时文件再原子改名，失败时清理临时文件并上抛。
 * @param directory 专用图库目录的绝对路径。
 * @param bytes 待存入的图片原始字节。
 * @returns 存储结果（已新增、已存在同名摘要文件或格式不支持）。
 */
export async function storeRandomImage(directory: string, bytes: Uint8Array): Promise<StoreRandomImageResult> {
  const extension: string | undefined = RANDOM_IMAGE_SAVE_EXTENSIONS.get(sniffImageFormat(bytes));
  if (extension === undefined) return { status: "unsupportedFormat" };
  const fileName: string = `${Bun.SHA256.hash(bytes, "hex")}${extension}`;
  const target: string = join(directory, fileName);
  if (await Bun.file(target).exists()) {
    await recordCachedRandomImage(directory, fileName);
    return { status: "existing", fileName };
  }
  const temporary: string = join(directory, `${RANDOM_IMAGE_TEMP_PREFIX}${Bun.randomUUIDv7()}${extension}`);
  try {
    await Bun.write(temporary, bytes);
    await rename(temporary, target);
  } catch (error: unknown) {
    await Bun.file(temporary).delete().catch((): undefined => undefined);
    throw error;
  }
  await recordCachedRandomImage(directory, fileName);
  return { status: "stored", fileName };
}
