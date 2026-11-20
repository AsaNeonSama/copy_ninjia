/**
 * 专用图库目录的只读预检与接管提交：将不改写磁盘/缓存的只读巡检与按需建目录及双缓存接管分离。
 */

import { access, lstat, readdir } from "node:fs/promises";
import { constants, mkdirSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { dirname, extname, join } from "node:path";
import { ASSETS_CONFIG_PATH } from "../../consts/paths";
import {
  RANDOM_IMAGE_CONTENT_NAME_PATTERN,
  RANDOM_IMAGE_EXTENSIONS,
} from "../../consts/imageGallery";
import { RANDOM_H_IMAGE_DIR_FIELD } from "../../consts/ui/assets";
import { isErrno } from "../../libs/errno";
import { InputValidationError } from "../../libs/inputValidation";
import { logger } from "../logger";
import {
  setRandomImageDirectoryCache,
  setRandomImageGalleryCache,
} from "./cache";
import type {
  RandomImageDirectoryInspection,
  RandomImageGalleryCacheEntry,
} from "../../types/imageGallery";

/**
 * 构造随机图库目录不可访问/不可创建的配置诊断异常（包含路径与字段路径）。
 * @param directory 解析后的图库目录绝对路径。
 * @returns 对应 `assets.json` 随机图库字段的 `InputValidationError`。
 */
function invalidRandomImageDirectoryError(directory: string): InputValidationError {
  return new InputValidationError(
    ASSETS_CONFIG_PATH,
    RANDOM_H_IMAGE_DIR_FIELD,
    `an accessible existing or creatable directory (resolved to ${directory})`
  );
}

/**
 * 在不创建目录、不改写任何主线程图库缓存的前提下，只读校验 `/h_image` 专用图库目录：
 * - 目录尚不存在（`ENOENT`）：逐级向上查找最近已存在祖先目录，确认其为可写入且可遍历目录（含只读模式位检查，确保 `root` 下 `/proc` 与 `0o555` 目录同样被拒）；
 * - 目录已存在（允许根目录为指向真实目录的符号链接）：校验可读写遍历与目录内每个条目的内容摘要文件名、扩展名与普通文件类型。
 * 供热重载只读阶段、Mini App 保存校验以及 `adoptRandomImageDirectory` 前置扫描共用。
 * @param directory 专用图库目录的绝对路径。
 * @returns 目录存在状态与已核验的条目清单。
 */
export async function inspectRandomImageDirectory(
  directory: string
): Promise<Readonly<RandomImageDirectoryInspection>> {
  const invalid: InputValidationError = invalidRandomImageDirectoryError(directory);
  try {
    await lstat(directory);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw invalid;
    let cursor: string = dirname(directory);
    for (;;) {
      try {
        const ancestorStat: Stats = await Bun.file(cursor).stat();
        if (!ancestorStat.isDirectory() || (ancestorStat.mode & 0o222) === 0) {
          throw invalid;
        }
        await access(cursor, constants.W_OK | constants.X_OK);
        return { directory, exists: false, names: [], galleryEntries: [] };
      } catch (ancestorError: unknown) {
        if (!isErrno(ancestorError, "ENOENT")) throw invalid;
        const parent: string = dirname(cursor);
        if (parent === cursor) throw invalid;
        cursor = parent;
      }
    }
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
    let fileStat: Stats;
    try {
      fileStat = await lstat(filePath);
    } catch (_error: unknown) {
      throw invalid;
    }
    if (!fileStat.isFile()) {
      throw new InputValidationError(filePath, RANDOM_H_IMAGE_DIR_FIELD,
        "a regular image named <64 lowercase SHA-256 hex characters>.jpg/.jpeg/.png/.webp");
    }
    names.push(entry.name);
    galleryEntries.push({ fileName: entry.name, mtimeMs: fileStat.mtimeMs });
  }
  return { directory, exists: true, names, galleryEntries };
}

/**
 * 根据 `inspectRandomImageDirectory` 产出的只读巡检结果，在真正接管目录时创建缺失目录，
 * 并同步写入主线程字典序文件名缓存与按修改时间降序排列的 Mini App 图库缓存（同步完成，不让出事件循环）。
 * @param directory 专用图库目录的绝对路径。
 * @param inspection 前置巡检得到的目录存在状态与条目清单。
 */
export function adoptRandomImageDirectory(
  directory: string,
  inspection: Readonly<RandomImageDirectoryInspection>
): void {
  if (!inspection.exists) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o755 });
    } catch (_error: unknown) {
      throw invalidRandomImageDirectoryError(directory);
    }
    logger.info("Created the random image directory.", { directory });
  }
  setRandomImageDirectoryCache(directory, [...inspection.names]);
  setRandomImageGalleryCache(directory, [...inspection.galleryEntries]);
}
