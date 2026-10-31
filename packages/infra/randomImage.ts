/**
 * 随机图片：`/h_image` 的目录准备、抽取与收图写盘。
 *
 * 启动时严格检查专用图库并加载有效图片文件名缓存；运行时为 /h_image、cron 与 Mini App 图库提供基于缓存的抽图、计数、列表分页与按内容摘要收图，
 * 并在收图写盘（`/h_image add` 与 Mini App 上传）或删除图片时增量更新缓存。
 */

import { access, lstat, mkdir, readdir, rename } from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { extname, join } from "node:path";
import { randomImageDirectoryCache } from "../cache/main/hImage";
import { ASSETS_CONFIG_PATH } from "../consts/paths";
import {
  RANDOM_IMAGE_CONTENT_NAME_PATTERN,
  RANDOM_IMAGE_EXTENSIONS,
  RANDOM_IMAGE_MAX_BYTES,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
  RANDOM_IMAGE_TEMP_PREFIX,
} from "../consts/randomImage";
import { RANDOM_H_IMAGE_DIR_FIELD } from "../consts/ui/assets";
import { isErrno } from "../libs/errno";
import { InputValidationError } from "../libs/inputValidation";
import { pickRandom } from "../libs/random";
import { logger } from "./logger";
import { sniffImageFormat } from "./image";
import type {
  RandomImageDirectoryCache,
  RandomImageEntry,
  RandomImageLibrary,
  RandomImageMimeType,
  RandomImagePick,
  StoreRandomImageResult,
} from "../types/randomImage";

/**
 * 在按字典序升序排列的文件名数组中二分查找目标文件名的插入下标（lower bound）。
 * @param names 已按字典序升序排列的文件名数组。
 * @param target 目标文件名。
 * @returns 首个大于或等于 `target` 的下标（`0 .. names.length`）。
 */
function findRandomImageNameIndex(
  names: readonly string[],
  target: string
): number {
  let low: number = 0;
  let high: number = names.length;
  while (low < high) {
    const mid: number = (low + high) >>> 1;
    if (names[mid]! < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * 将给定的文件名列表按字典序升序排序后写入当前图库目录缓存。
 * @param directory 图库目录绝对路径。
 * @param names 目录内有效图片文件名数组。
 * @returns 已写入 holder 的缓存对象。
 */
function setRandomImageDirectoryCache(
  directory: string,
  names: string[]
): RandomImageDirectoryCache {
  names.sort();
  const cache: RandomImageDirectoryCache = {
    directory,
    names,
  };
  randomImageDirectoryCache.current = cache;
  return cache;
}

/**
 * 向已命中的图库目录缓存按字典序二分插入一个新入库的文件名。
 * @param directory 图库目录绝对路径。
 * @param fileName 新增的图片文件名。
 */
function addCachedRandomImageName(directory: string, fileName: string): void {
  const cache: RandomImageDirectoryCache | null = randomImageDirectoryCache.current;
  if (cache?.directory !== directory) return;
  const index: number = findRandomImageNameIndex(cache.names, fileName);
  if (cache.names[index] === fileName) return;
  cache.names.splice(index, 0, fileName);
}

/**
 * 从已命中的图库目录缓存中按字典序二分查找并移除指定文件名。
 * @param directory 图库目录绝对路径。
 * @param fileName 待移除的图片文件名。
 */
function removeCachedRandomImageName(directory: string, fileName: string): void {
  const cache: RandomImageDirectoryCache | null = randomImageDirectoryCache.current;
  if (cache?.directory !== directory) return;
  const index: number = findRandomImageNameIndex(cache.names, fileName);
  if (cache.names[index] === fileName) {
    cache.names.splice(index, 1);
  }
}

/**
 * 准备 `/h_image` 专用图库并校验内容摘要文件名、扩展名与条目类型（见 `docs/cn/04-invariants.md`）：
 * 允许目录根为符号链接，拒绝子目录、符号链接文件及临时文件；校验通过后将文件名列表加载到内存缓存。
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
    } catch {
      throw invalid;
    }
    logger.log(`Created the random image directory ${directory}.`);
  }
  let entries: Dirent[];
  try {
    if (!(await Bun.file(directory).stat()).isDirectory()) throw invalid;
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw invalid;
  }
  const names: string[] = [];
  for (const entry of entries) {
    const extension: string = extname(entry.name);
    if (!entry.isFile() || !RANDOM_IMAGE_EXTENSIONS.has(extension.toLowerCase()) ||
      !RANDOM_IMAGE_CONTENT_NAME_PATTERN.test(entry.name.slice(0, -extension.length))) {
      throw new InputValidationError(join(directory, entry.name), RANDOM_H_IMAGE_DIR_FIELD,
        "a regular image named <64 lowercase SHA-256 hex characters>.jpg/.jpeg/.png/.webp");
    }
    names.push(entry.name);
  }
  setRandomImageDirectoryCache(directory, names);
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
 * 读取指定图库目录的缓存；若当前目录尚未缓存则执行一次 `readdir` 填充缓存。
 * @param directory 专用图库目录的绝对路径。
 * @returns 当前目录的文件名缓存对象。
 */
async function readOrLoadRandomImageCache(
  directory: string
): Promise<RandomImageDirectoryCache> {
  const existing: RandomImageDirectoryCache | null = randomImageDirectoryCache.current;
  if (existing?.directory === directory) return existing;
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
  return setRandomImageDirectoryCache(directory, randomImageNames(entries));
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
 * 抽中已消失的文件时同步从缓存剔除，抽中超限文件时从本次剩余候选中剔除并继续抽取。
 * @param directory 专用图库目录的绝对路径。
 * @returns 抽取结果（成功读取图片字节，或目录缺失、为空、全部超限）。
 */
export async function pickRandomImage(directory: string): Promise<RandomImagePick> {
  let cache: RandomImageDirectoryCache;
  try {
    cache = await readOrLoadRandomImageCache(directory);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return { status: "missingDirectory" };
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
  if (randomImageDirectoryCache.current?.directory === directory) {
    randomImageDirectoryCache.current = null;
  }
  return false;
}

/**
 * 返回图库目录内已缓存的全部有效普通图片文件名列表（不重复排序）；目录不存在或非目录时返回 `null`。
 * @param directory 专用图库目录的绝对路径。
 * @returns 有效图片文件名只读数组；目录不存在或非目录时返回 `null`。
 */
export async function listRandomImageNames(
  directory: string
): Promise<readonly string[] | null> {
  if (!await isRandomImageDirectory(directory)) return null;
  try {
    const cache: RandomImageDirectoryCache = await readOrLoadRandomImageCache(directory);
    return cache.names;
  } catch (error: unknown) {
    if (vanished(error)) return null;
    throw error;
  }
}

/**
 * 核对图库目录内指定文件名的普通图片文件（不跟随文件级符号链接）并返回其路径与元数据。
 * @param directory 专用图库目录的绝对路径。
 * @param fileName 已通过文件名形态校验的图片文件名。
 * @returns 有效普通图片文件的元数据；目录或文件不存在、为符号链接或扩展名不支持时返回 `null`。
 */
export async function statRandomImageFile(
  directory: string,
  fileName: string
): Promise<Readonly<RandomImageEntry> | null> {
  if (fileName.startsWith(".")) return null;
  const mimeType: RandomImageMimeType | undefined = RANDOM_IMAGE_EXTENSIONS.get(
    extname(fileName).toLowerCase()
  );
  if (mimeType === undefined) return null;
  const filePath: string = join(directory, fileName);
  try {
    const stat: Stats = await lstat(filePath);
    if (!stat.isFile()) return null;
    return {
      fileName,
      filePath,
      mimeType,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error: unknown) {
    if (vanished(error)) return null;
    throw error;
  }
}

/**
 * 安全删除图库目录内指定文件名的普通图片文件（不跟随文件级符号链接），并在删除成功后同步从文件名缓存移除。
 * @param directory 专用图库目录的绝对路径。
 * @param fileName 已通过文件名形态校验的图片文件名。
 * @returns 删除成功时返回 `true`；文件不存在、非普通图片文件或已消失时返回 `false`。
 */
export async function deleteRandomImageFile(
  directory: string,
  fileName: string
): Promise<boolean> {
  const entry: Readonly<RandomImageEntry> | null = await statRandomImageFile(
    directory,
    fileName
  );
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
 * 将图片按魔数嗅探格式与内容 SHA-256 命名写入图库并同步更新内存缓存：目标已存在时返回 `existing`；
 * 新增时先写同目录隐藏临时文件再原子改名，失败时清理临时文件并上抛。
 * @param directory 专用图库目录的绝对路径。
 * @param bytes 待存入的图片原始字节。
 * @returns 存储结果（已新增、已存在同名摘要文件或格式不支持）。
 */
export async function storeRandomImage(
  directory: string,
  bytes: Uint8Array
): Promise<StoreRandomImageResult> {
  const extension: string | undefined = RANDOM_IMAGE_SAVE_EXTENSIONS.get(sniffImageFormat(bytes));
  if (extension === undefined) return { status: "unsupportedFormat" };
  const fileName: string = `${Bun.SHA256.hash(bytes, "hex")}${extension}`;
  const target: string = join(directory, fileName);
  if (await Bun.file(target).exists()) {
    addCachedRandomImageName(directory, fileName);
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
  addCachedRandomImageName(directory, fileName);
  return { status: "stored", fileName };
}
