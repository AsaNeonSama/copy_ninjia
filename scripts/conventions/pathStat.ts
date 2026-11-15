import type { Stats } from "node:fs";
import { isErrno } from "../../packages/libs/errno";

/**
 * 读取路径的 `stat()` 元数据；路径不存在或上级分量非目录时返回 `null`。
 *
 * @param path 待核对的文件系统路径
 * @returns 路径存在时返回 `Stats`，`ENOENT` 或 `ENOTDIR` 时返回 `null`
 */
export async function statOptionalPath(path: string): Promise<Stats | null> {
  try {
    return await Bun.file(path).stat();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
    throw error;
  }
}

/**
 * 判定路径（普通文件、目录或其它文件系统项）是否存在。
 *
 * @param path 待核对的文件系统路径
 * @returns 路径存在时返回 true，`ENOENT` 或 `ENOTDIR` 时返回 false
 */
export async function pathExists(path: string): Promise<boolean> {
  return (await statOptionalPath(path)) !== null;
}
