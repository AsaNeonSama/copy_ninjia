/** `migrate:ad-pack-blacklists` 冷迁移入口：将 schema v13 库与旧 4 键 `ad_detect.json` 非破坏性迁移至 schema v14 与 2 键配置。 */
import { chmodSync } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseAdDetectConfig } from "../packages/config/adDetectConfig";
import { DYNAMIC_CONFIG_DIR_NAME } from "../packages/consts/configLayout";
import { DATABASE_DIR_NAME } from "../packages/consts/dataRootLayout";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../packages/consts/identityStorage";
import { closeStorageDatabase, openStorageDatabase } from "../packages/database/interact/connection";
import { atomicWriteText, syncDirectory } from "../packages/libs/atomicFile";
import { isErrno } from "../packages/libs/errno";
import { InputValidationError, invalidInput, readJsonInput } from "../packages/libs/inputValidation";
import type { StorageDatabase } from "../packages/types/storageDatabase";
import { parseLegacyAdDetectConfig } from "./migrations/adPackBlacklists/adDetectConfig";
import type { LegacyAdDetectConfigMigrationData } from "./migrations/adPackBlacklists/adDetectConfig";
import {
  AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION,
  applyAdPackBlacklistsDatabaseMigration,
  inspectAdPackBlacklistsSourceDatabase,
} from "./migrations/adPackBlacklists/database";
import type { AdPackBlacklistsDatabaseCounts } from "./migrations/adPackBlacklists/database";
import { parseSourceConfigOutputRoots } from "./migrations/cli";
import {
  migrationPathContains,
  readMigrationFileRecords,
  readMigrationFileRecordWithMtime,
} from "./migrations/files";
import type {
  MigrationFileRecord,
  MigrationFileRecordWithMtime,
} from "./migrations/files";

/** 源备份中参与冷迁移的 SQLite 主库及可选旁路文件相对路径。 */
const SOURCE_DATABASE_FILES: readonly string[] = [
  `${DATABASE_DIR_NAME}/storage.sqlite`,
  `${DATABASE_DIR_NAME}/storage.sqlite-wal`,
  `${DATABASE_DIR_NAME}/storage.sqlite-shm`,
];

/** SQLite 产物相对输出根目录的路径。 */
const OUTPUT_DATABASE_RELATIVE_PATH: string = `${DATABASE_DIR_NAME}/storage.sqlite`;

/** 配置根内可选 `ad_detect.json` 的相对路径。 */
const CONFIG_AD_DETECT_RELATIVE_PATH: string = `${DYNAMIC_CONFIG_DIR_NAME}/ad_detect.json`;

/** 输出根目录内清理后 `ad_detect.json` 的相对路径（同时作为 `sourceFiles` 里的规范路径名）。 */
const OUTPUT_AD_DETECT_RELATIVE_PATH: string = `config/${CONFIG_AD_DETECT_RELATIVE_PATH}`;

/** 暂存目录仅当前账号可进入，部署权限由运维按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;

/** 暂存数据库副本与校验清单只允许当前账号读写。 */
export const STAGING_FILE_MODE: number = 0o600;

/** `ready.json` 与 `incomplete.json` 的 JSON 缩进空格数。 */
const JSON_INDENT: number = 2;

/** `prepareAdPackBlacklistsMigration` 执行广告包黑名单冷迁移的路径选项。 */
export interface AdPackBlacklistsMigrationOptions {
  /** 停机备份数据根目录路径（必须包含 `database/storage.sqlite`）。 */
  readonly sourceRoot: string;
  /** 停机备份配置根目录路径；省略时默认取 `<sourceRoot>/config`。 */
  readonly configRoot?: string;
  /** 迁移产物输出的新建目录路径。 */
  readonly outputRoot: string;
}

/** `migrate:ad-pack-blacklists` 冷迁移完成后的汇总结果与校验清单。 */
export interface AdPackBlacklistsMigrationResult extends AdPackBlacklistsDatabaseCounts {
  /** 源数据库 schema 版本（13）。 */
  readonly sourceSchema: number;
  /** 产物数据库 schema 版本（14）。 */
  readonly targetSchema: number;
  /** 源数据库绑定的规范化 IANA 时区名称。 */
  readonly timeZone: string;
  /** 源备份中是否存在 `ad_detect.json` 并生成了 2 键配置产物。 */
  readonly adDetectConfigMigrated: boolean;
  /** 停机备份数据根目录的真实绝对路径。 */
  readonly sourceRoot: string;
  /** 停机备份配置根目录的解析绝对路径。 */
  readonly configRoot: string;
  /** 迁移产物输出目录的绝对路径。 */
  readonly outputRoot: string;
  /** 参与迁移的源文件相对路径、SHA-256 与权限清单。 */
  readonly sourceFiles: readonly MigrationFileRecord[];
  /** 输出目录生成文件的相对路径、SHA-256 与权限清单。 */
  readonly outputFiles: readonly MigrationFileRecord[];
}

/** 单次源快照读取结果：除公开清单外还保留每个源文件的 `mtimeMs` 用于事后不可变复核。 */
interface SourceSnapshot {
  /** SQLite 主库及存在的 WAL/SHM 旁路文件清单。 */
  readonly databaseFiles: readonly MigrationFileRecord[];
  /** 可选源 `ad_detect.json` 的规范化清单项；配置不存在时为 null。 */
  readonly adDetectFile: MigrationFileRecord | null;
  /** 源 `ad_detect.json` 的绝对路径；配置不存在时为 null。 */
  readonly adDetectAbsolutePath: string | null;
  /** 供 `incomplete.json` / `ready.json` 记录的完整源文件清单。 */
  readonly sourceFiles: readonly MigrationFileRecord[];
  /** 每个源文件对应的 `mtimeMs` 序列（顺序与 `sourceFiles` 一致），用于核验源备份未受触碰。 */
  readonly mtimesMs: readonly number[];
}

/** 源路径与配置根解析结果。 */
interface ResolvedMigrationRoots {
  /** 规范化后的源数据备份根绝对路径。 */
  readonly source: string;
  /** 已存在配置根的规范化绝对路径；缺省 `<source>/config` 不存在时为 null。 */
  readonly existingConfig: string | null;
  /** 写入 `ready.json` 的配置根绝对路径。 */
  readonly configRootPath: string;
  /** 规范化后的新建输出目录绝对路径。 */
  readonly output: string;
}

/**
 * 校验并规范化 `--source-root`、可选 `--config-root` 与 `--output-root`：
 * - 显式传入的 `--config-root` 必须为非软链接的已有目录；
 * - 省略 `--config-root` 时默认检查 `<source>/config`（允许不存在，但若存在不得为软链接或非目录）；
 * - 拒绝 `--output-root` 与 `--source-root` 或 `--config-root` 存在任何包含或重叠关系。
 *
 * @param options 迁移路径选项。
 * @returns 规范化后的源数据根、配置根与输出目录路径。
 */
async function resolveMigrationRoots({
  sourceRoot,
  configRoot,
  outputRoot,
}: AdPackBlacklistsMigrationOptions): Promise<ResolvedMigrationRoots> {
  const source: string = await realpath(sourceRoot);
  const resolvedOutput: string = resolve(outputRoot);
  const output: string = join(await realpath(dirname(resolvedOutput)), basename(resolvedOutput));
  if (migrationPathContains(source, output) || migrationPathContains(output, source)) {
    return invalidInput(output, "$path", "a new directory outside the source backup");
  }
  if (configRoot !== undefined) {
    const rawConfig: string = resolve(configRoot);
    const rawStats: Stats = await lstat(rawConfig);
    if (!rawStats.isDirectory() || rawStats.isSymbolicLink()) {
      return invalidInput(rawConfig, "$type", "a directory without symbolic links");
    }
    const resolvedConfig: string = await realpath(rawConfig);
    if (migrationPathContains(resolvedConfig, output) || migrationPathContains(output, resolvedConfig)) {
      return invalidInput(output, "$path", "a new directory outside the source and config backups");
    }
    return { source, existingConfig: resolvedConfig, configRootPath: resolvedConfig, output };
  }
  const defaultConfig: string = join(source, "config");
  let existingConfig: string | null = null;
  try {
    const stats: Stats = await lstat(defaultConfig);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return invalidInput(defaultConfig, "$type", "a directory without symbolic links");
    }
    existingConfig = defaultConfig;
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return { source, existingConfig, configRootPath: defaultConfig, output };
}

/**
 * 采集源备份中 `database/storage.sqlite{,-wal,-shm}` 与可选 `<configRoot>/dynamic/ad_detect.json`
 * 的完整清单与 `mtimeMs` 快照；任何目录或文件为符号链接或非期望类型时立即拒绝。
 *
 * @param source 源数据备份根绝对路径。
 * @param existingConfig 已存在的配置根绝对路径；缺省 `<source>/config` 不存在时为 null。
 * @returns 源文件清单、路径与 `mtimeMs` 快照。
 */
async function readSourceSnapshot(
  source: string,
  existingConfig: string | null
): Promise<SourceSnapshot> {
  const databaseDir: string = join(source, DATABASE_DIR_NAME);
  const databaseStats: Stats = await lstat(databaseDir);
  if (!databaseStats.isDirectory() || databaseStats.isSymbolicLink()) {
    return invalidInput(databaseDir, "$type", "a directory without symbolic links");
  }
  const databaseFiles: MigrationFileRecord[] = [];
  const mtimesMs: number[] = [];
  for (const relativePath of SOURCE_DATABASE_FILES) {
    try {
      const { record, mtimeMs }: MigrationFileRecordWithMtime =
        await readMigrationFileRecordWithMtime(source, relativePath);
      databaseFiles.push(record);
      mtimesMs.push(mtimeMs);
    } catch (error: unknown) {
      if (!(relativePath.endsWith("-wal") || relativePath.endsWith("-shm")) || !isErrno(error, "ENOENT")) {
        throw error;
      }
    }
  }

  let adDetectFile: MigrationFileRecord | null = null;
  let adDetectAbsolutePath: string | null = null;
  const effectiveConfigRoot: string = existingConfig ?? join(source, "config");
  let configDirExists: boolean = existingConfig !== null;
  if (!configDirExists) {
    try {
      const stats: Stats = await lstat(effectiveConfigRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return invalidInput(effectiveConfigRoot, "$type", "a directory without symbolic links");
      }
      configDirExists = true;
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  if (configDirExists) {
    const dynamicDir: string = join(effectiveConfigRoot, DYNAMIC_CONFIG_DIR_NAME);
    let dynamicDirExists: boolean = false;
    try {
      const dynamicStats: Stats = await lstat(dynamicDir);
      if (!dynamicStats.isDirectory() || dynamicStats.isSymbolicLink()) {
        return invalidInput(dynamicDir, "$type", "a directory without symbolic links");
      }
      dynamicDirExists = true;
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (dynamicDirExists) {
      try {
        const { record, mtimeMs }: MigrationFileRecordWithMtime =
          await readMigrationFileRecordWithMtime(
            effectiveConfigRoot,
            CONFIG_AD_DETECT_RELATIVE_PATH
          );
        adDetectFile = { ...record, path: OUTPUT_AD_DETECT_RELATIVE_PATH };
        adDetectAbsolutePath = join(effectiveConfigRoot, CONFIG_AD_DETECT_RELATIVE_PATH);
        mtimesMs.push(mtimeMs);
      } catch (error: unknown) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
  }
  const sourceFiles: readonly MigrationFileRecord[] = adDetectFile === null
    ? databaseFiles
    : [...databaseFiles, adDetectFile];
  return { databaseFiles, adDetectFile, adDetectAbsolutePath, sourceFiles, mtimesMs };
}

/**
 * 清理产物目录中可能残留的 SQLite WAL/SHM 旁路文件；文件不存在视为已清理。
 *
 * @param path 待删除的旁路文件绝对路径。
 */
async function removeOptionalSidecar(path: string): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
}

/**
 * 将停机备份中的 schema v13 SQLite 库与可选 4 键 `ad_detect.json` 非破坏性迁移至独立产物目录：
 * 1. 核对输出目录位于源数据与配置备份之外且尚未存在，先落盘 `incomplete.json` 记录源快照；
 * 2. 逐字节复制源库（及可选 WAL/SHM）至输出目录并核对 SHA-256，绝不直接对源备份打开 SQLite 连接；
 * 3. 在副本上校验 v13 schema、迁移谱系、完整性、JSONB 与绑定时区，严格解析可选 4 键 `ad_detect.json`；
 * 4. 执行 Drizzle 迁移升至 v14、写入 `ad_pack_blacklists`、按源库时区跑完 `validateStorageDatabase`
 *    并执行 `PRAGMA wal_checkpoint(TRUNCATE)`，关闭连接后清除输出 WAL/SHM 并同步目录；
 * 5. 若源存在 `ad_detect.json`，按原权限原子写出清理后的 2 键配置并用生产 `parseAdDetectConfig` 回读校验；
 * 6. 复核源备份内容、哈希、权限与 `mtimeMs` 全程未变后写出 `ready.json` 并删除 `incomplete.json`。
 *
 * @param options 停机备份数据根、可选配置根与新建输出目录选项。
 * @returns 冷迁移汇总统计与源/产物文件清单。
 */
export async function prepareAdPackBlacklistsMigration(
  options: AdPackBlacklistsMigrationOptions
): Promise<AdPackBlacklistsMigrationResult> {
  const { source, existingConfig, configRootPath, output }: ResolvedMigrationRoots =
    await resolveMigrationRoots(options);
  const initialSnapshot: SourceSnapshot = await readSourceSnapshot(source, existingConfig);
  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await mkdir(join(output, DATABASE_DIR_NAME), { mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(
    join(output, "incomplete.json"),
    JSON.stringify({
      sourceSchema: AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION,
      sourceFiles: initialSnapshot.sourceFiles,
    }, null, JSON_INDENT),
    STAGING_FILE_MODE
  );

  for (const record of initialSnapshot.databaseFiles) {
    const target: string = join(output, record.path);
    await Bun.write(target, Bun.file(join(source, record.path)), { mode: STAGING_FILE_MODE });
    chmodSync(target, STAGING_FILE_MODE);
    const [copied]: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, [record.path]);
    if (copied?.sha256 !== record.sha256) {
      return invalidInput(target, "$sha256", "an exact copy of the source file");
    }
  }

  const outputDatabasePath: string = join(output, OUTPUT_DATABASE_RELATIVE_PATH);
  const database: StorageDatabase = openStorageDatabase({ path: outputDatabasePath });
  let dbTimeZone: string;
  let counts: AdPackBlacklistsDatabaseCounts;
  let parsedAdDetect: LegacyAdDetectConfigMigrationData | null = null;
  try {
    dbTimeZone = inspectAdPackBlacklistsSourceDatabase(database, outputDatabasePath);
    if (initialSnapshot.adDetectAbsolutePath !== null) {
      parsedAdDetect = parseLegacyAdDetectConfig(
        await readJsonInput(initialSnapshot.adDetectAbsolutePath),
        initialSnapshot.adDetectAbsolutePath
      );
    }
    counts = applyAdPackBlacklistsDatabaseMigration({
      database,
      source: outputDatabasePath,
      timeZone: dbTimeZone,
      stickerBlackList: parsedAdDetect?.stickerBlackList ?? [],
      emojiBlackList: parsedAdDetect?.emojiBlackList ?? [],
    });
  } finally {
    closeStorageDatabase(database);
  }
  await removeOptionalSidecar(`${outputDatabasePath}-wal`);
  await removeOptionalSidecar(`${outputDatabasePath}-shm`);
  await syncDirectory(outputDatabasePath);

  const outputPaths: string[] = [OUTPUT_DATABASE_RELATIVE_PATH];
  if (parsedAdDetect !== null && initialSnapshot.adDetectFile !== null) {
    const outputDynamicDir: string = join(output, "config", DYNAMIC_CONFIG_DIR_NAME);
    await mkdir(outputDynamicDir, { recursive: true, mode: STAGING_DIRECTORY_MODE });
    const outputAdDetectPath: string = join(output, OUTPUT_AD_DETECT_RELATIVE_PATH);
    const preservedMode: number = initialSnapshot.adDetectFile.mode & 0o777;
    await atomicWriteText(outputAdDetectPath, parsedAdDetect.cleanedJson, preservedMode);
    parseAdDetectConfig(await readJsonInput(outputAdDetectPath), outputAdDetectPath);
    await syncDirectory(outputDynamicDir);
    outputPaths.push(OUTPUT_AD_DETECT_RELATIVE_PATH);
  }

  const finalSnapshot: SourceSnapshot = await readSourceSnapshot(source, existingConfig);
  if (
    JSON.stringify(finalSnapshot.sourceFiles) !== JSON.stringify(initialSnapshot.sourceFiles) ||
    JSON.stringify(finalSnapshot.mtimesMs) !== JSON.stringify(initialSnapshot.mtimesMs)
  ) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including metadata and SQLite sidecars");
  }

  const outputFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, outputPaths);
  const result: AdPackBlacklistsMigrationResult = {
    sourceSchema: AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION,
    targetSchema: IDENTITY_DATABASE_SCHEMA_VERSION,
    timeZone: dbTimeZone,
    adDetectConfigMigrated: parsedAdDetect !== null,
    ...counts,
    sourceRoot: source,
    configRoot: configRootPath,
    outputRoot: output,
    sourceFiles: initialSnapshot.sourceFiles,
    outputFiles,
  };
  const incompletePath: string = join(output, "incomplete.json");
  await atomicWriteText(
    join(output, "ready.json"),
    `${JSON.stringify(result, null, JSON_INDENT)}\n`,
    STAGING_FILE_MODE
  );
  await Bun.file(incompletePath).delete();
  await syncDirectory(incompletePath);
  return result;
}

/**
 * `migrate:ad-pack-blacklists` 冷迁移 CLI 执行入口：支持 `--help` 说明输出、正常迁移落盘与错误退出码映射。
 *
 * @param args 命令行参数列表（不含可执行文件与脚本路径）。
 * @returns CLI 退出码（成功或 `--help` 为 `0`，失败为 `1`）。
 */
export async function runAdPackBlacklistsMigrationCli(
  args: readonly string[] = Bun.argv.slice(2)
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "bun run migrate:ad-pack-blacklists --source-root <cold-backup> [--config-root <config-backup>] --output-root <new-directory>\n" +
      "Stop the service and verify inactive before taking an external backup of database/ (including WAL/SHM) and config/dynamic/ad_detect.json with ownership, modes and SHA-256.\n" +
      `Only schema v${AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION} is accepted. If config/dynamic/ad_detect.json exists, it must be the legacy 4-key format; sticker_black_list and emoji_black_list are moved into ad_pack_blacklists (schema v${IDENTITY_DATABASE_SCHEMA_VERSION}) and a cleaned 2-key ad_detect.json is written.\n` +
      "If --config-root is omitted, <source-root>/config is inspected; if ad_detect.json is absent, the database is migrated with empty ad_pack_blacklists and no ad_detect.json is created.\n" +
      "The source remains unchanged. Only ready.json marks validated output; after interruption rerun into a new output directory.\n" +
      "Verify output hashes, then manually replace database/storage.sqlite (remove stale deployment WAL/SHM only after preserving the backup) and config/dynamic/ad_detect.json (if generated) while stopped.\n" +
      "Restore original ownership/modes from sourceFiles; ensure the service can write SQLite and its directory.\n" +
      "Validate configuration and state before startup; retain the backup until service stability is confirmed."
    );
    return 0;
  }
  try {
    const result: AdPackBlacklistsMigrationResult = await prepareAdPackBlacklistsMigration(
      parseSourceConfigOutputRoots(args)
    );
    console.log(
      `Ad pack blacklists migration prepared: ${result.outputRoot}/ready.json. Manual replacement while stopped is required.`
    );
    return 0;
  } catch (error: unknown) {
    console.error(
      error instanceof InputValidationError
        ? error.message
        : "Ad pack blacklists migration failed; source backup and incomplete output are retained. No deployment files were replaced."
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runAdPackBlacklistsMigrationCli();
}
