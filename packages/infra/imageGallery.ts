/**
 * 图库管理与随机图片：`/h_image` 与 Mini App 图库的目录准备、抽取、列表分页、删除与收图写盘。
 *
 * 启动时严格检查专用图库并同步加载字典序文件名缓存与按修改时间从新到老（降序）排列的图库缓存；
 * 运行时为 `/h_image`、cron 提供基于字典序缓存的抽图与计数，为 Mini App 图库提供基于修改时间降序缓存的列表分页，
 * 并在收图写盘（`/h_image add` 与 Mini App 上传）、删除图片、探测到文件消失或目录失效时按各自的排序结构同步维护两边的缓存。
 */

import { access, lstat, mkdir, readdir, rename } from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { extname, join } from "node:path";
import { randomImageDirectoryCache, randomImageGalleryCache } from "../cache/main/hImage";
import { ASSETS_CONFIG_PATH } from "../consts/paths";
import {
  RANDOM_IMAGE_CONTENT_NAME_PATTERN,
  RANDOM_IMAGE_EXTENSIONS,
  RANDOM_IMAGE_MAX_BYTES,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
  RANDOM_IMAGE_TEMP_PREFIX,
} from "../consts/imageGallery";
import { RANDOM_H_IMAGE_DIR_FIELD } from "../consts/ui/assets";
import { isErrno } from "../libs/errno";
import { InputValidationError } from "../libs/inputValidation";
import { pickRandom } from "../libs/random";
import { logger } from "./logger";
import { sniffImageFormat } from "./image";
import type {
  RandomImageDirectoryCache,
  RandomImageEntry,
  RandomImageGalleryCache,
  RandomImageGalleryCacheEntry,
  RandomImageLibrary,
  RandomImageMimeType,
  RandomImagePick,
  StoreRandomImageResult,
} from "../types/imageGallery";

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
 * 将给定的文件名列表按字典序升序排序后写入当前图库目录缓存。
 * @param directory 图库目录绝对路径。
 * @param names 目录内有效图片文件名数组。
 * @returns 已写入 holder 的缓存对象。
 */
function setRandomImageDirectoryCache(directory: string, names: string[]): RandomImageDirectoryCache {
  names.sort();
  const cache: RandomImageDirectoryCache = { directory, names };
  randomImageDirectoryCache.current = cache;
  return cache;
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
 * 将给定的图库缓存项列表按修改时间从新到老（降序）排序后写入 Mini App 图库缓存。
 * @param directory 图库目录绝对路径。
 * @param entries 目录内有效图片缓存项数组。
 * @returns 已写入 holder 的 Mini App 图库缓存对象。
 */
function setRandomImageGalleryCache(
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
async function recordCachedRandomImage(directory: string, fileName: string): Promise<void> {
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
    if (vanished(error)) {
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
function removeCachedRandomImageName(directory: string, fileName: string): void {
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
function clearCachedRandomImageDirectory(directory: string): void {
  if (randomImageDirectoryCache.current?.directory === directory) randomImageDirectoryCache.current = null;
  if (randomImageGalleryCache.current?.directory === directory) randomImageGalleryCache.current = null;
}

/**
 * 准备 `/h_image` 专用图库并校验内容摘要文件名、扩展名与条目类型（见 `docs/cn/04-invariants.md`）：
 * 允许目录根为符号链接，拒绝子目录、符号链接文件及临时文件；校验通过后同步填充字典序缓存与按修改时间降序排列的 Mini App 图库缓存。
 * @param directory 专用图库目录的绝对路径。
 */
export async function ensureRandomImageDirectory(directory: string): Promise<void> {
  const invalid: InputValidationError = new InputValidationError(
    ASSETS_CONFIG_PATH, RANDOM_H_IMAGE_DIR_FIELD, `an accessible existing or creatable directory (resolved to ${directory})`
  );
  try {
    await lstat(directory);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw invalid;
    try {
      await mkdir(directory, { recursive: true, mode: 0o755 });
    } catch (_error: unknown) {
      throw invalid;
    }
    logger.log(`Created the random image directory ${directory}.`);
  }
  let entries: Dirent[];
  try {
    if (!(await Bun.file(directory).stat()).isDirectory()) throw invalid;
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (_error: unknown) {
    throw invalid;
  }
  const names: string[] = [];
  const galleryEntries: Readonly<RandomImageGalleryCacheEntry>[] = [];
  for (const entry of entries) {
    const extension: string = extname(entry.name);
    const filePath: string = join(directory, entry.name);
    if (!entry.isFile() || !RANDOM_IMAGE_EXTENSIONS.has(extension.toLowerCase()) ||
      !RANDOM_IMAGE_CONTENT_NAME_PATTERN.test(entry.name.slice(0, -extension.length))) {
      throw new InputValidationError(filePath, RANDOM_H_IMAGE_DIR_FIELD,
        "a regular image named <64 lowercase SHA-256 hex characters>.jpg/.jpeg/.png/.webp");
    }
    let stat: Stats;
    try {
      stat = await lstat(filePath);
    } catch (_error: unknown) {
      throw invalid;
    }
    if (!stat.isFile()) {
      throw new InputValidationError(filePath, RANDOM_H_IMAGE_DIR_FIELD,
        "a regular image named <64 lowercase SHA-256 hex characters>.jpg/.jpeg/.png/.webp");
    }
    names.push(entry.name);
    galleryEntries.push({ fileName: entry.name, mtimeMs: stat.mtimeMs });
  }
  setRandomImageDirectoryCache(directory, names);
  setRandomImageGalleryCache(directory, galleryEntries);
}

/**
 * 目录项里算作图库图片的文件名：扩展名命中 RANDOM_IMAGE_EXTENSIONS 的非隐藏普通文件
 * （符号链接、子目录与收图写到一半的点号临时文件都不算）。抽图与计数共用这一口径。
 * @param entries `readdir` 返回的目录项列表。
 * @returns 符合图库图片规则的文件名列表。
 */
function randomImageNames(entries: readonly Dirent[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (RANDOM_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) names.push(entry.name);
  }
  return names;
}

/**
 * 读取指定图库目录的字典序缓存；若当前目录尚未缓存则执行一次 `readdir` 填充缓存。
 * @param directory 专用图库目录的绝对路径。
 * @returns 当前目录按字典序升序排列的文件名缓存对象。
 */
async function readOrLoadRandomImageCache(directory: string): Promise<RandomImageDirectoryCache> {
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
async function readOrLoadRandomImageGalleryCache(directory: string): Promise<RandomImageGalleryCache> {
  const existing: RandomImageGalleryCache | null = randomImageGalleryCache.current;
  if (existing?.directory === directory) return existing;
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
  const galleryEntries: Readonly<RandomImageGalleryCacheEntry>[] = [];
  for (const fileName of randomImageNames(entries)) {
    try {
      const stat: Stats = await lstat(join(directory, fileName));
      if (stat.isFile()) galleryEntries.push({ fileName, mtimeMs: stat.mtimeMs });
    } catch (error: unknown) {
      if (!vanished(error)) throw error;
    }
  }
  return setRandomImageGalleryCache(directory, galleryEntries);
}

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
 * 列目录之后、读文件之前被删除、改名或换成目录的候选。
 * @param error 读取候选图片文件时抛出的异常。
 * @returns 错误码属于 ENOENT、ENOTDIR 或 EISDIR 时返回 true，否则返回 false。
 */
function vanished(error: unknown): boolean {
  return isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "EISDIR");
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
      if (!vanished(error)) throw error;
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
    if (vanished(error)) {
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
    if (vanished(error)) {
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
    if (vanished(error)) {
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
