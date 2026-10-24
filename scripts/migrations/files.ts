import { fileSha256 } from "../fileSha256";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Stats } from "node:fs";
import { invalidInput } from "../../packages/libs/inputValidation";

/** 冷迁移清单里的一项：相对路径、哈希与权限元数据，不记录文件内容。 */
export interface MigrationFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/**
 * 读取 root 下一个普通文件的清单项；符号链接与非普通文件一律拒绝。
 * @param root 根目录路径。
 * @param path 相对文件路径。
 * @returns 文件的相对路径、SHA-256 哈希与权限元数据记录。
 */
async function readMigrationFileRecord(root: string, path: string): Promise<MigrationFileRecord> {
  const fullPath: string = join(root, path);
  const stats: Stats = await lstat(fullPath);
  if (!stats.isFile()) return invalidInput(fullPath, "$type", "a regular file without symbolic links");
  return {
    path,
    sha256: await fileSha256(fullPath),
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    gid: stats.gid,
  };
}

/**
 * 按顺序读取 root 下的清单项；缺失、悬空链接、类型不符与读取失败一律拒绝。
 * @param root 根目录路径。
 * @param paths 相对文件路径列表。
 * @returns 按输入顺序排列的迁移文件清单记录列表。
 */
export async function readMigrationFileRecords(
  root: string,
  paths: readonly string[]
): Promise<readonly MigrationFileRecord[]> {
  const records: MigrationFileRecord[] = [];
  for (const path of paths) records.push(await readMigrationFileRecord(root, path));
  return records;
}

/**
 * 解析后的祖先关系：child 等于 parent 或位于其下时为 true。
 * @param parent 父目录路径。
 * @param child 待检查的子路径。
 * @returns child 等于 parent 或位于其内部时返回 true。
 */
export function migrationPathContains(parent: string, child: string): boolean {
  const path: string = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}
