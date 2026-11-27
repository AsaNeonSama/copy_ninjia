import { fileSha256 } from "../fileSha256";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Stats } from "node:fs";
import { invalidInput } from "../../packages/libs/inputValidation";

/** 冷迁移文件清单项：记录相对路径、SHA-256 哈希与权限属主元数据，不含文件正文。 */
export interface MigrationFileRecord {
  /** 相对备份根或产物根的文件路径。 */
  readonly path: string;
  /** 文件内容的 64 位小写十六进制 SHA-256 摘要。 */
  readonly sha256: string;
  /** 文件权限位（`mode & 0o7777`）。 */
  readonly mode: number;
  /** 文件属主 UID。 */
  readonly uid: number;
  /** 文件属组 GID。 */
  readonly gid: number;
}

/** 冷迁移单文件清单项及其单次 `lstat` 观测到的毫秒修改时间。 */
export interface MigrationFileRecordWithMtime {
  /** 写入迁移清单的标准化文件记录。 */
  readonly record: MigrationFileRecord;
  /** 本次 `lstat` 观测到的文件修改时间（毫秒），仅用于迁移前后不可变性复核。 */
  readonly mtimeMs: number;
}

/**
 * 通过单次 `lstat` 读取 root 下一个普通文件的清单项与 `mtimeMs`；符号链接与非普通文件一律拒绝。
 * @param root 根目录路径。
 * @param path 相对文件路径。
 * @returns 文件清单记录与 `mtimeMs`。
 */
export async function readMigrationFileRecordWithMtime(
  root: string,
  path: string
): Promise<MigrationFileRecordWithMtime> {
  const fullPath: string = join(root, path);
  const stats: Stats = await lstat(fullPath);
  if (!stats.isFile()) return invalidInput(fullPath, "$type", "a regular file without symbolic links");
  return {
    record: {
      path,
      sha256: await fileSha256(fullPath),
      mode: stats.mode & 0o7777,
      uid: stats.uid,
      gid: stats.gid,
    },
    mtimeMs: stats.mtimeMs,
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
  for (const path of paths) records.push((await readMigrationFileRecordWithMtime(root, path)).record);
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
