import { CANDIDATE_OWNER_PID_PATTERN } from "../../consts/storage";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DYNAMIC_ALLOWED_NAMES, STATIC_ALLOWED_NAMES } from "../../config/layout";
import {
  DYNAMIC_CONFIG_DIR,
  GLOBAL_STATE_FILE_PATH,
  LOCK_FILE_PATH,
  MINI_APP_TOTP_FILE_PATH,
  STATIC_CONFIG_DIR,
  TMP_FILE_SUFFIX,
} from "../../consts/paths";
import { parseAtomicTempFileName } from "../../libs/atomicFile";
import { isErrno } from "../../libs/errno";
import { logger } from "../logger";
import { isRecordedLockOwnerInactive, readLinuxProcessIdentity } from "./instanceLock";
import type { ParsedAtomicTempFileName } from "../../types/storage";

/** 孤儿临时文件清扫选项。 */
export interface StorageCleanupOptions {
  /** 全局状态文件路径。 */
  stateFilePath?: string;
  /** Mini App TOTP 持久化文件路径。 */
  totpFilePath?: string;
  /** 单实例锁文件路径。 */
  lockFilePath?: string;
  /** 静态部署配置目录路径（仅清扫已死 PID 且前缀命中静态白名单的原子写临时文件）。 */
  configStaticDir?: string;
  /** 动态部署配置目录路径（仅清扫已死 PID 且前缀命中动态白名单的原子写临时文件）。 */
  configDynamicDir?: string;
  /** 读取目录条目列表的注入函数。 */
  readDirectory?: (path: string) => Promise<string[]>;
  /** 删除单个文件的注入函数。 */
  removeFile?: (path: string) => Promise<void>;
  /** 判定锁辅助文件属主是否已不活跃的注入函数。 */
  isInactiveLockOwner?: (path: string) => Promise<boolean>;
  /** 按 PID 判定配置临时文件写入进程是否已不存在的注入函数（只对非本进程 PID 调用）；返回 `true` 才允许清扫。 */
  isProcessPidDead?: (pid: number) => Promise<boolean>;
}

/**
 * 按 guard candidate 文件名里的 PID 判定属主是否已死：只有 /proc 下查不到这个
 * PID 才返回 true；PID 仍存在（包括被别的进程复用）返回 false。
 * candidate 不是已发布的 guard，cleanupOrphanedTempFiles 不扫 `<lock>.guard`。
 *
 * @param path 候选文件完整路径。
 * @returns 属主 PID 在 `/proc` 下已不存在时返回 `true`。
 */
async function hasDeadCandidateFilenameOwner(path: string): Promise<boolean> {
  const named: RegExpExecArray | null = CANDIDATE_OWNER_PID_PATTERN.exec(basename(path));
  if (!named) return false;
  const pid: number = Number(named[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  return await readLinuxProcessIdentity(pid) === null;
}

/**
 * 判定当前格式锁辅助文件的属主是否已不在运行；空 candidate 文件退回按文件名中的 PID 判定。
 *
 * @param path 锁辅助文件完整路径。
 * @returns 确认属主已不在运行时返回 `true`。
 */
async function hasInactiveCurrentFormatOwner(path: string): Promise<boolean> {
  const content: string = await Bun.file(path).text();
  const inactive: boolean | undefined = await isRecordedLockOwnerInactive(content);
  if (inactive !== undefined) return inactive;
  // 内容为空的 candidate（先 `open(..., "wx")` 建空文件、再写身份行，见
  // instanceLock.ts 的 acquirePidFileLock）按文件名里的 PID 判定属主。
  // 非空却认不出的内容不走这条路，按人工修复处理。
  if (content.trim().length > 0) return false;
  return await hasDeadCandidateFilenameOwner(path);
}

/** 一个待清扫目录：分别记录运行时固定目标前缀、锁文件名与可选配置白名单集合。 */
interface CleanupDirectory {
  readonly directory: string;
  readonly atomicTempPrefixes: readonly string[];
  readonly lockFileName: string | null;
  readonly configAllowedNames: ReadonlySet<string> | null;
}

/** 构造待清扫目录列表时的单次归并入参。 */
interface CleanupDirectoryInput {
  readonly directory: string;
  readonly atomicTempPrefix?: string;
  readonly lockFileName?: string;
  readonly configAllowedNames?: readonly string[];
}

/**
 * 将一个目录规则合并到待清扫目录表中，同目录条目合并而不重复扫描。
 *
 * @param directories 已归并目录表。
 * @param input 待合并目录项的规则片段。
 */
function mergeCleanupDirectory(
  directories: CleanupDirectory[],
  input: CleanupDirectoryInput
): void {
  const index: number = directories.findIndex(
    (entry: CleanupDirectory): boolean => entry.directory === input.directory
  );
  const existing: CleanupDirectory | undefined = directories[index];
  if (existing === undefined) {
    directories.push({
      directory: input.directory,
      atomicTempPrefixes: input.atomicTempPrefix === undefined ? [] : [input.atomicTempPrefix],
      lockFileName: input.lockFileName ?? null,
      configAllowedNames: input.configAllowedNames === undefined ? null : new Set<string>(input.configAllowedNames),
    });
    return;
  }
  const mergedAllowed: Set<string> | null = existing.configAllowedNames === null && input.configAllowedNames === undefined
    ? null
    : new Set<string>([...(existing.configAllowedNames ?? []), ...(input.configAllowedNames ?? [])]);
  directories[index] = {
    directory: existing.directory,
    atomicTempPrefixes: input.atomicTempPrefix === undefined
      ? existing.atomicTempPrefixes
      : [...existing.atomicTempPrefixes, input.atomicTempPrefix],
    lockFileName: existing.lockFileName ?? input.lockFileName ?? null,
    configAllowedNames: mergedAllowed,
  };
}

/** `cleanupDirectories` 归并待清扫目录表时的输入参数。 */
interface CleanupDirectoriesOptions {
  /** 经原子写发布的目标文件路径列表。 */
  readonly atomicTargetPaths: readonly string[];
  /** 单实例锁文件路径。 */
  readonly lockFilePath: string;
  /** 静态部署配置目录路径。 */
  readonly configStaticDir: string;
  /** 动态部署配置目录路径。 */
  readonly configDynamicDir: string;
}

/**
 * 按目录归并原子写目标文件、单实例锁文件与 `config/{static,dynamic}` 目录；同目录条目合并到同一项。
 *
 * @param options 待归并的路径集合参数。
 * @returns 去重归并后的待清扫目录描述列表。
 */
function cleanupDirectories({
  atomicTargetPaths,
  lockFilePath,
  configStaticDir,
  configDynamicDir,
}: CleanupDirectoriesOptions): readonly CleanupDirectory[] {
  const directories: CleanupDirectory[] = [];
  mergeCleanupDirectory(directories, {
    directory: dirname(lockFilePath),
    atomicTempPrefix: `.${basename(lockFilePath)}.`,
    lockFileName: basename(lockFilePath),
  });
  for (const targetPath of atomicTargetPaths) {
    mergeCleanupDirectory(directories, {
      directory: dirname(targetPath),
      atomicTempPrefix: `.${basename(targetPath)}.`,
    });
  }
  mergeCleanupDirectory(directories, {
    directory: configStaticDir,
    configAllowedNames: STATIC_ALLOWED_NAMES,
  });
  mergeCleanupDirectory(directories, {
    directory: configDynamicDir,
    configAllowedNames: DYNAMIC_ALLOWED_NAMES,
  });
  return directories;
}

/**
 * 持锁后清扫全局状态文件（`memory/global/`）、Mini App TOTP 文件（`memory/mini-app-totp/`）、
 * `bot.lock`（数据根）以及 `config/{static,dynamic}/` 内已死进程的原子写孤儿临时文件，与锁的孤儿辅助文件。
 * 配置目录下只删严格匹配 `atomicFile.ts` 临时格式、前缀属于白名单且属主 PID 已不存在或等于本进程 PID 的条目
 * （清扫在启动序列中先于本进程任何配置写入执行，与本进程同 PID 的临时文件只可能来自 PID 被复用前的上一个进程）；
 * 目录或删除遇到 `EACCES`/`EROFS` 等错误时记错误日志后继续，由随后的布局校验按原规则拒绝。目录尚不存在时跳过。
 *
 * @param options 清扫路径与文件系统依赖注入选项。
 */
export async function cleanupOrphanedTempFiles({
  stateFilePath = GLOBAL_STATE_FILE_PATH,
  totpFilePath = MINI_APP_TOTP_FILE_PATH,
  lockFilePath = LOCK_FILE_PATH,
  configStaticDir = STATIC_CONFIG_DIR,
  configDynamicDir = DYNAMIC_CONFIG_DIR,
  readDirectory = readdir,
  removeFile = (path: string): Promise<void> => Bun.file(path).delete(),
  isInactiveLockOwner = hasInactiveCurrentFormatOwner,
  isProcessPidDead = async (pid: number): Promise<boolean> => await readLinuxProcessIdentity(pid) === null,
}: StorageCleanupOptions = {}): Promise<void> {
  const targets: readonly CleanupDirectory[] = cleanupDirectories({
    atomicTargetPaths: [stateFilePath, totpFilePath],
    lockFilePath,
    configStaticDir,
    configDynamicDir,
  });
  for (const target of targets) {
    let entries: string[];
    try {
      entries = await readDirectory(target.directory);
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) {
        logger.error("Failed to scan directory for orphaned temp files:", { directory: target.directory }, error);
      }
      continue;
    }
    const lockFileName: string | null = target.lockFileName;
    const guardCandidatePattern: RegExp | null = lockFileName === null ? null : new RegExp(
      `^${lockFileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.guard\\.candidate\\.[1-9]\\d*\\.` +
      "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    );
    for (const entry of entries) {
      const isRuntimeAtomicTemp: boolean = entry.endsWith(TMP_FILE_SUFFIX) &&
        target.atomicTempPrefixes.some((prefix: string): boolean => entry.startsWith(prefix));
      const isGuardOrphan: boolean = lockFileName !== null &&
        (entry === `${lockFileName}.guard.recovery` || guardCandidatePattern?.test(entry) === true);
      const parsedConfigTemp: Readonly<ParsedAtomicTempFileName> | null =
        target.configAllowedNames === null ? null : parseAtomicTempFileName(entry);
      const isConfigTempCandidate: boolean = parsedConfigTemp !== null &&
        target.configAllowedNames?.has(parsedConfigTemp.targetFileName) === true;
      if (!isRuntimeAtomicTemp && !isGuardOrphan && !isConfigTempCandidate) continue;
      const path: string = join(target.directory, entry);
      try {
        if (isGuardOrphan && !await isInactiveLockOwner(path)) {
          logger.error(
            "Refusing to remove lock helper whose owner is still active or unknown.",
            { directory: target.directory, entry }
          );
          continue;
        }
        if (
          isConfigTempCandidate &&
          parsedConfigTemp !== null &&
          parsedConfigTemp.pid !== process.pid &&
          !(await isProcessPidDead(parsedConfigTemp.pid))
        ) {
          continue;
        }
        await removeFile(path);
      } catch (error: unknown) {
        if (!isErrno(error, "ENOENT")) {
          logger.error("Failed to remove orphaned temp file:", { directory: target.directory, entry }, error);
        }
      }
    }
  }
}
