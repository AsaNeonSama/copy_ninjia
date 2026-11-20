/**
 * 随机图库内存缓存维护：字典序文件名缓存与按修改时间降序排列的 Mini App 图库缓存的加载、二分定位、同步增删与目录失效清理。
 */

import { lstat, readdir } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { extname, join } from "node:path";
import { randomImageDirectoryCache, randomImageGalleryCache } from "../../cache/main/hImage";
import { RANDOM_IMAGE_EXTENSIONS } from "../../consts/imageGallery";
import { isErrno } from "../../libs/errno";
import type {
  RandomImageDirectoryCache,
  RandomImageGalleryCache,
  RandomImageGalleryCacheEntry,
} from "../../types/imageGallery";

/**
 * 在按字典序升序排列的文件名数组中二分查找目标文件名的插入下标（lower bound）。
 * @param names 已按字典序升序排列的文件名数组。
 * @param target 目标文件名。
 * @returns 首个大于或等于 `target` 的下标（`0 .. names.length`）。
 */
function findRandomImageNameIndex(names: readonly string[], target: string): number {
  let low: number = 0;
  let high: number = names.length;
  while (low < high) {
    const mid: number = (low + high) >>> 1;
    if (names[mid]! < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 比较两个 Mini App 图库缓存项的排序先后：先按修改时间从新到老（`mtimeMs` 降序）排列，修改时间相同时按文件名字典序升序排列。
 * @param left 左侧图库缓存项。
 * @param right 右侧图库缓存项。
 * @returns 小于 0 表示 `left` 排在前面，大于 0 表示 `right` 排在前面，等于 0 表示顺序相同。
 */
function compareRandomImageGalleryEntries(
  left: Readonly<RandomImageGalleryCacheEntry>,
  right: Readonly<RandomImageGalleryCacheEntry>
): number {
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
  return left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0;
}

/**
 * 在按修改时间降序排列的图库缓存项数组中二分查找目标项的插入下标（排在同修改时间已有项之前）。
 * @param entries 已按修改时间降序排列的缓存项数组。
 * @param mtimeMs 待插入图片文件的最后修改毫秒时间戳。
 * @returns 插入下标（`0 .. entries.length`）。
 */
function findRandomImageGalleryInsertIndex(
  entries: readonly Readonly<RandomImageGalleryCacheEntry>[],
  mtimeMs: number
): number {
  let low: number = 0;
  let high: number = entries.length;
  while (low < high) {
    const mid: number = (low + high) >>> 1;
    if (entries[mid]!.mtimeMs > mtimeMs) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 在 Mini App 图库缓存项数组中线性查找指定文件名的下标。
 * @param entries 按修改时间降序排列的缓存项数组。
 * @param fileName 目标文件名。
 * @returns 命中项的下标；不存在时返回 `-1`。
 */
function findRandomImageGalleryEntryIndex(
  entries: readonly Readonly<RandomImageGalleryCacheEntry>[],
  fileName: string
): number {
  for (let index: number = 0; index < entries.length; index++) {
    if (entries[index]!.fileName === fileName) return index;
  }
  return -1;
}

/**
 * 列目录之后、读文件之前被删除、改名或换成目录的候选错误判定。
 * @param error 读取候选图片文件时抛出的异常。
 * @returns 错误码属于 ENOENT、ENOTDIR 或 EISDIR 时返回 true，否则返回 false。
 */
export function isVanishedImageError(error: unknown): boolean {
  return isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "EISDIR");
}

/**
 * 目录项里算作图库图片的文件名：扩展名命中 RANDOM_IMAGE_EXTENSIONS 的非隐藏普通文件
 * （符号链接、子目录与收图写到一半的点号临时文件都不算）。抽图与计数共用这一口径。
 * @param entries `readdir` 返回的目录项列表。
 * @returns 符合图库图片规则的文件名列表。
 */
export function randomImageNames(entries: readonly Dirent[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (RANDOM_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) names.push(entry.name);
  }
  return names;
}

/**
 * 将给定的文件名列表按字典序升序排序后写入当前图库目录缓存。
 * @param directory 图库目录绝对路径。
 * @param names 目录内有效图片文件名数组。
 * @returns 已写入 holder 的缓存对象。
 */
export function setRandomImageDirectoryCache(directory: string, names: string[]): RandomImageDirectoryCache {
  names.sort();
  const cache: RandomImageDirectoryCache = { directory, names };
  randomImageDirectoryCache.current = cache;
  return cache;
}

/**
 * 将给定的图库缓存项列表按修改时间从新到老（降序）排序后写入 Mini App 图库缓存。
 * @param directory 图库目录绝对路径。
 * @param entries 目录内有效图片缓存项数组。
 * @returns 已写入 holder 的 Mini App 图库缓存对象。
 */
export function setRandomImageGalleryCache(
  directory: string,
  entries: Readonly<RandomImageGalleryCacheEntry>[]
): RandomImageGalleryCache {
  entries.sort(compareRandomImageGalleryEntries);
  const cache: RandomImageGalleryCache = { directory, entries };
  randomImageGalleryCache.current = cache;
  return cache;
}

/**
 * 向已命中的字典序缓存与 Mini App 图库缓存按各自排序结构同步记录有效普通图片文件（新写入图片排在同修改时间已有项之前）；若探测到文件已消失或非普通文件则同步从两边缓存剔除。
 * @param directory 图库目录绝对路径。
 * @param fileName 新入库或已存在的图片文件名。
 */
export async function recordCachedRandomImage(directory: string, fileName: string): Promise<void> {
  if (
    randomImageDirectoryCache.current?.directory !== directory &&
    randomImageGalleryCache.current?.directory !== directory
  ) {
    return;
  }
  let stat: Stats;
  try {
    stat = await lstat(join(directory, fileName));
  } catch (error: unknown) {
    if (isVanishedImageError(error)) {
      removeCachedRandomImageName(directory, fileName);
      return;
    }
    throw error;
  }
  if (!stat.isFile()) {
    removeCachedRandomImageName(directory, fileName);
    return;
  }
  const directoryCache: RandomImageDirectoryCache | null = randomImageDirectoryCache.current;
  if (directoryCache?.directory === directory) {
    const index: number = findRandomImageNameIndex(directoryCache.names, fileName);
    if (directoryCache.names[index] !== fileName) directoryCache.names.splice(index, 0, fileName);
  }
  const galleryCache: RandomImageGalleryCache | null = randomImageGalleryCache.current;
  if (galleryCache?.directory === directory && findRandomImageGalleryEntryIndex(galleryCache.entries, fileName) === -1) {
    const insertIndex: number = findRandomImageGalleryInsertIndex(galleryCache.entries, stat.mtimeMs);
    galleryCache.entries.splice(insertIndex, 0, { fileName, mtimeMs: stat.mtimeMs });
  }
}

/**
 * 从已命中的字典序缓存与 Mini App 图库缓存中按各自结构同步移除指定文件名。
 * @param directory 图库目录绝对路径。
 * @param fileName 待移除的图片文件名。
 */
export function removeCachedRandomImageName(directory: string, fileName: string): void {
  const directoryCache: RandomImageDirectoryCache | null = randomImageDirectoryCache.current;
  if (directoryCache?.directory === directory) {
    const index: number = findRandomImageNameIndex(directoryCache.names, fileName);
    if (directoryCache.names[index] === fileName) directoryCache.names.splice(index, 1);
  }
  const galleryCache: RandomImageGalleryCache | null = randomImageGalleryCache.current;
  if (galleryCache?.directory === directory) {
    const galleryIndex: number = findRandomImageGalleryEntryIndex(galleryCache.entries, fileName);
    if (galleryIndex !== -1) galleryCache.entries.splice(galleryIndex, 1);
  }
}

/**
 * 若当前字典序缓存或 Mini App 图库缓存指向指定目录，则将其清空为 `null`。
 * @param directory 失效的图库目录绝对路径。
 */
export function clearCachedRandomImageDirectory(directory: string): void {
  if (randomImageDirectoryCache.current?.directory === directory) randomImageDirectoryCache.current = null;
  if (randomImageGalleryCache.current?.directory === directory) randomImageGalleryCache.current = null;
}

/**
 * 读取指定图库目录的字典序缓存；若当前目录尚未缓存则执行一次 `readdir` 填充缓存。
 * @param directory 专用图库目录的绝对路径。
 * @returns 当前目录按字典序升序排列的文件名缓存对象。
 */
export async function readOrLoadRandomImageCache(directory: string): Promise<RandomImageDirectoryCache> {
  const existing: RandomImageDirectoryCache | null = randomImageDirectoryCache.current;
  if (existing?.directory === directory) return existing;
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
  return setRandomImageDirectoryCache(directory, randomImageNames(entries));
}

/**
 * 读取指定图库目录的 Mini App 图库缓存（按修改时间从新到老降序）；若当前目录尚未缓存则执行 `readdir` + `lstat` 填充缓存（扫描期间消失或非普通文件的项自动跳过）。
 * @param directory 专用图库目录的绝对路径。
 * @returns 当前目录按修改时间降序排列的图库缓存对象。
 */
export async function readOrLoadRandomImageGalleryCache(directory: string): Promise<RandomImageGalleryCache> {
  const existing: RandomImageGalleryCache | null = randomImageGalleryCache.current;
  if (existing?.directory === directory) return existing;
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
  const galleryEntries: Readonly<RandomImageGalleryCacheEntry>[] = [];
  for (const fileName of randomImageNames(entries)) {
    try {
      const stat: Stats = await lstat(join(directory, fileName));
      if (stat.isFile()) galleryEntries.push({ fileName, mtimeMs: stat.mtimeMs });
    } catch (error: unknown) {
      if (!isVanishedImageError(error)) throw error;
    }
  }
  return setRandomImageGalleryCache(directory, galleryEntries);
}
