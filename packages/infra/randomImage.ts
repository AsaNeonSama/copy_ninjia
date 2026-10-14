/**
 * 随机图片：`/h_image` 的目录准备、抽取与收图写盘。
 *
 * 启动时严格检查专用图库；运行时为 /h_image 与 cron 提供抽图、计数和按内容摘要收图。
 * 不持有缓存，也不发送；目录路径由调用方传入（部署值见 config/assets.ts 的 getAssetConfig）。
 * 每次抽取都重新枚举目录，不缓存目录列表。
 */

import { access, lstat, mkdir, readdir, rename } from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { extname, join } from "node:path";
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
  RandomImageLibrary,
  RandomImageMimeType,
  RandomImagePick,
  StoreRandomImageResult,
} from "../types/randomImage";

/**
 * 准备 `/h_image` 专用图库并校验内容摘要文件名、扩展名与条目类型（见 `docs/cn/04-invariants.md`）：
 * 允许目录根为符号链接，拒绝子目录、符号链接文件及临时文件。
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
  for (const entry of entries) {
    const extension: string = extname(entry.name);
    if (!entry.isFile() || !RANDOM_IMAGE_EXTENSIONS.has(extension.toLowerCase()) ||
      !RANDOM_IMAGE_CONTENT_NAME_PATTERN.test(entry.name.slice(0, -extension.length))) {
      throw new InputValidationError(join(directory, entry.name), RANDOM_H_IMAGE_DIR_FIELD,
        "a regular image named <64 lowercase SHA-256 hex characters>.jpg/.jpeg/.png/.webp");
    }
  }
}

/**
 * 目录项里算作图库图片的文件名：扩展名命中 RANDOM_IMAGE_EXTENSIONS 的非隐藏普通文件
 * （符号链接、子目录与收图写到一半的点号临时文件都不算）。抽图与计数共用这一口径。
 */
function randomImageNames(entries: readonly Dirent[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (RANDOM_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) names.push(entry.name);
  }
  return names;
}

/** 列一次目录并统计有效图库图片张数；目录读取失败原样上抛。 */
export async function readRandomImageLibrary(directory: string): Promise<RandomImageLibrary> {
  return { size: randomImageNames(await readdir(directory, { withFileTypes: true })).length };
}

/** 列目录之后、读文件之前被删除、改名或换成目录的候选。 */
function vanished(error: unknown): boolean {
  return isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "EISDIR");
}

/**
 * 从目录非递归地均匀抽取一张不超过 `RANDOM_IMAGE_MAX_BYTES` 的图片并读取字节；
 * 抽中超限或已消失的文件时从剩余候选中剔除并继续抽取。
 */
export async function pickRandomImage(directory: string): Promise<RandomImagePick> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return { status: "missingDirectory" };
    throw error;
  }
  const candidates: string[] = randomImageNames(entries);
  let oversized: string | undefined;
  for (let fileName: string | undefined = pickRandom(candidates); fileName !== undefined; fileName = pickRandom(candidates)) {
    const path: string = join(directory, fileName);
    try {
      if ((await Bun.file(path).stat()).size > RANDOM_IMAGE_MAX_BYTES) {
        oversized = fileName;
      } else {
        const mimeType: RandomImageMimeType = RANDOM_IMAGE_EXTENSIONS.get(extname(fileName).toLowerCase())!;
        return { status: "ok", bytes: await Bun.file(path).bytes(), mimeType, fileName };
      }
    } catch (error: unknown) {
      if (!vanished(error)) throw error;
    }
    candidates.splice(candidates.indexOf(fileName), 1);
  }
  return oversized === undefined ? { status: "empty" } : { status: "tooLarge", fileName: oversized };
}

/** 路径此刻是不是目录（跟随符号链接）；不存在或读不到都按不是处理。 */
export async function isRandomImageDirectory(directory: string): Promise<boolean> {
  try {
    return (await Bun.file(directory).stat()).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 将图片按魔数嗅探格式与内容 SHA-256 命名写入图库：目标已存在时返回 `existing`；
 * 新增时先写同目录隐藏临时文件再原子改名，失败时清理临时文件并上抛。
 */
export async function storeRandomImage(
  directory: string,
  bytes: Uint8Array
): Promise<StoreRandomImageResult> {
  const extension: string | undefined = RANDOM_IMAGE_SAVE_EXTENSIONS.get(sniffImageFormat(bytes));
  if (extension === undefined) return { status: "unsupportedFormat" };
  const fileName: string = `${Bun.SHA256.hash(bytes, "hex")}${extension}`;
  const target: string = join(directory, fileName);
  if (await Bun.file(target).exists()) return { status: "existing", fileName };
  const temporary: string = join(directory, `${RANDOM_IMAGE_TEMP_PREFIX}${Bun.randomUUIDv7()}${extension}`);
  try {
    await Bun.write(temporary, bytes);
    await rename(temporary, target);
  } catch (error: unknown) {
    await Bun.file(temporary).delete().catch((): undefined => undefined);
    throw error;
  }
  return { status: "stored", fileName };
}
