import { link, lstat, mkdir, open, rename } from "node:fs/promises";
import {
  RUNTIME_DATA_ROOT_MAX_MODE,
  RUNTIME_SENSITIVE_DIRECTORY_NAMES,
} from "../../consts/storage";
import { DATABASE_DIR_NAME } from "../../consts/dataRootLayout";
import { IDENTITY_DATABASE_DIRECTORY_MODE } from "../../consts/identityStorage";
import { isErrno } from "../../libs/errno";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Stats } from "node:fs";
import { toError } from "../../libs/errorMessage";

export interface DataRootProbeDependencies {
  mkdir: typeof mkdir;
  lstat: typeof lstat;
  open: typeof open;
  link: typeof link;
  rename: typeof rename;
  unlink: (path: string) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: DataRootProbeDependencies = {
  mkdir,
  lstat,
  open,
  link,
  rename,
  unlink: (path: string): Promise<void> => Bun.file(path).delete(),
};

/** 运行时数据根目录预检选项。 */
export interface PrepareRuntimeDataRootOptions {
  /** 文件系统探针依赖覆盖项。 */
  dependencies?: Partial<DataRootProbeDependencies>;
  /** 是否强制校验目录私有权限与属主。 */
  enforcePrivatePermissions?: boolean;
  /** 允许的部署协作组 GID 列表。 */
  expectedGroupGids?: readonly number[];
  /** 期望的运行时属主 UID。 */
  expectedOwnerUid?: number;
}

/** 私有目录权限与属主校验选项。 */
interface AssertPrivateDirectoryOptions {
  /** 是否允许部署协作组具备可写权限。 */
  readonly allowCollaborativeGroup: boolean;
  /** 当前进程所属的允许协作组 GID 列表。 */
  readonly expectedGroupGids: readonly number[];
  /** 期望的目录属主 UID。 */
  readonly expectedOwnerUid: number;
  /** 允许的最大 Unix 权限位掩码。 */
  readonly maximumMode: number;
}

/**
 * 将 Unix 权限位格式化为固定 4 位八进制字符串。
 *
 * @param mode 原始权限数值。
 * @returns 形如 `0700` 的八进制权限字符串。
 */
function formatUnixMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

/**
 * 校验目录为真实目录且属主、协作组及权限掩码符合私有数据目录约束。
 *
 * @param path 目录路径。
 * @param stats 目录的 `lstat` 统计信息。
 * @param options 属主、协作组与权限上限校验选项。
 */
function assertPrivateDirectory(
  path: string,
  stats: Stats,
  {
    allowCollaborativeGroup,
    expectedGroupGids,
    expectedOwnerUid,
    maximumMode,
  }: AssertPrivateDirectoryOptions
): void {
  if (stats.isSymbolicLink()) {
    throw new Error(`${path} is a symbolic link; runtime data directories must be real directories`);
  }
  if (!stats.isDirectory()) throw new Error(`${path} exists but is not a directory`);
  const mode: number = stats.mode & 0o777;
  const hasWritableCollaborativeGroup: boolean =
    allowCollaborativeGroup &&
    expectedGroupGids.includes(stats.gid) &&
    (mode & 0o070) === 0o070;
  if (stats.uid !== expectedOwnerUid && !hasWritableCollaborativeGroup) {
    throw new Error(
      `${path} is owned by uid ${stats.uid}, expected runtime uid ${expectedOwnerUid}; ` +
      (allowCollaborativeGroup
        ? "stop all instances and correct the owner or writable deployment group"
        : "stop all instances and correct the owner")
    );
  }
  if ((mode & ~maximumMode) !== 0) {
    throw new Error(
      `${path} mode ${formatUnixMode(mode)} is broader than ${formatUnixMode(maximumMode)}; ` +
      `stop all instances and run chmod ${formatUnixMode(maximumMode)} -- ${JSON.stringify(path)}`
    );
  }
}

/**
 * 在实例锁和任何联网/Worker 初始化之前验证数据根真正支持本仓库依赖的
 * durability 原语：可创建/写入、同目录 hard link、原子 rename 与目录 fsync。
 * 权限校验规则见 docs/cn/04-invariants.md；已有目录只校验、不自动 chmod。
 *
 * @param dataRoot 运行时数据根目录路径。
 * @param options 探针依赖与权限校验选项。
 */
export async function prepareRuntimeDataRoot(
  dataRoot: string,
  options: PrepareRuntimeDataRootOptions = {}
): Promise<void> {
  const {
    dependencies = {},
    enforcePrivatePermissions = true,
    // 发行平台均为 Linux，POSIX 进程恒提供 getgroups/getuid。
    expectedGroupGids = process.getgroups!(),
    expectedOwnerUid = process.getuid!(),
  }: PrepareRuntimeDataRootOptions = options;
  const root: string = resolve(dataRoot);
  const fs: DataRootProbeDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const nonce: string = `${process.pid}.${crypto.randomUUID()}`;
  const sourcePath: string = join(root, `.copy-ninjia-preflight.${nonce}`);
  const linkPath: string = `${sourcePath}.link`;
  const renamedPath: string = `${sourcePath}.renamed`;
  let sourceHandle: FileHandle | null = null;
  let directoryHandle: FileHandle | null = null;

  try {
    await fs.mkdir(root, { recursive: true, mode: RUNTIME_DATA_ROOT_MAX_MODE });
    const rootStat: Stats = await fs.lstat(root);
    if (rootStat.isSymbolicLink()) {
      throw new Error("path is a symbolic link; runtime data roots must be real directories");
    }
    if (!rootStat.isDirectory()) throw new Error("path exists but is not a directory");
    if (enforcePrivatePermissions) {
      assertPrivateDirectory(root, rootStat, {
        allowCollaborativeGroup: false,
        expectedGroupGids,
        expectedOwnerUid,
        maximumMode: RUNTIME_DATA_ROOT_MAX_MODE,
      });
    }
    for (const directoryName of RUNTIME_SENSITIVE_DIRECTORY_NAMES) {
      const directoryPath: string = join(root, directoryName);
      const isIdentityDatabaseDirectory: boolean = directoryName === DATABASE_DIR_NAME;
      // 建目录与校验目录用同一个上限：`database/` 与其余目录各有自己的 mode 上限常量。
      const maximumMode: number = isIdentityDatabaseDirectory
        ? IDENTITY_DATABASE_DIRECTORY_MODE & 0o777
        : RUNTIME_DATA_ROOT_MAX_MODE;
      let directoryStat: Stats;
      try {
        directoryStat = await fs.lstat(directoryPath);
      } catch (error: unknown) {
        if (!isErrno(error, "ENOENT")) throw error;
        if (!enforcePrivatePermissions) continue;
        await fs.mkdir(directoryPath, { recursive: true, mode: maximumMode });
        directoryStat = await fs.lstat(directoryPath);
      }
      if (enforcePrivatePermissions) {
        assertPrivateDirectory(directoryPath, directoryStat, {
          allowCollaborativeGroup: isIdentityDatabaseDirectory,
          expectedGroupGids,
          expectedOwnerUid,
          maximumMode,
        });
      } else if (directoryStat.isSymbolicLink()) {
        throw new Error(`${directoryPath} is a symbolic link; runtime data directories must be real directories`);
      } else if (!directoryStat.isDirectory()) {
        throw new Error(`${directoryPath} exists but is not a directory`);
      }
    }

    sourceHandle = await fs.open(sourcePath, "wx", 0o600);
    await Bun.write(Bun.file(sourceHandle.fd), "copy-ninjia data root preflight\n");
    await sourceHandle.sync();
    await sourceHandle.close();
    sourceHandle = null;

    await fs.link(sourcePath, linkPath);
    await fs.rename(linkPath, renamedPath);
    directoryHandle = await fs.open(root, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = null;
  } catch (error: unknown) {
    const reason: Error = toError(error);
    throw new Error(
      `Runtime data root preflight failed for ${root}: ${reason.message}. ` +
      "Ensure it is a writable directory on a filesystem that supports hard links, atomic rename, and directory fsync.",
      { cause: error }
    );
  } finally {
    await sourceHandle?.close().catch((): undefined => undefined);
    await directoryHandle?.close().catch((): undefined => undefined);
    await fs.unlink(linkPath).catch((): undefined => undefined);
    await fs.unlink(renamedPath).catch((): undefined => undefined);
    await fs.unlink(sourcePath).catch((): undefined => undefined);
  }
}
