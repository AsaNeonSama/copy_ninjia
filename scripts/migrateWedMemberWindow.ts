import { readdirSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import { STATE_MANAGED_CHAT_LIMIT } from "../packages/consts/storage";
import { WED_MEMBER_LIMIT } from "../packages/consts/wed";
import { atomicWriteText } from "../packages/libs/atomicFile";
import { InputValidationError, invalidInput, readJsonInput } from "../packages/libs/inputValidation";
import { parseWedMemberFile, parseWedMemberFileName, serializeWedMemberEntries } from "../packages/libs/wedMemberFile";
import { parseSourceOutputRoots } from "./migrations/cli";
import { migrationPathContains, readMigrationFileRecords } from "./migrations/files";
import type { MigrationFileRecord } from "./migrations/files";
import { parseWedMemberSourceFile, windowWedMemberEntries } from "./migrations/wedMemberWindow/members";

/** 停机备份与产物中 /wed 成员文件所在的相对目录。 */
const WED_DIRECTORY: string = "memory/wed";
/** 暂存目录仅当前账号可进入，部署权限由运维按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;
/** 产物与校验清单只允许当前账号读写。 */
export const STAGING_FILE_MODE: number = 0o600;
/** ready.json 与 incomplete.json 的 JSON 缩进。 */
const JSON_INDENT: number = 2;

export interface WedMemberWindowMigrationOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
}

export interface WedMemberWindowMigrationResult {
  /** 写入全部成员的同一进入时间（Unix 毫秒），取自迁移开始时刻。 */
  readonly enteredAt: number;
  readonly chatCount: number;
  readonly keptMembers: number;
  /** 超出 WED_MEMBER_LIMIT、从各群最早一端丢弃的成员数。 */
  readonly truncatedMembers: number;
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly sourceFiles: readonly MigrationFileRecord[];
  readonly outputFiles: readonly MigrationFileRecord[];
}

/**
 * 源目录里参与迁移的文件相对路径，按名字排序：只取 `.json`，名字必须是规范的 `<负安全整数 chatId>.json`，
 * 群数不超过 STATE_MANAGED_CHAT_LIMIT；其余目录项（未提交的 *.tmp）不参与迁移，与源版本启动口径一致。
 */
async function sourceMemberPaths(source: string): Promise<readonly string[]> {
  const directory: string = join(source, WED_DIRECTORY);
  const stats: Stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return invalidInput(directory, "$type", "a directory without symbolic links");
  const paths: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    parseWedMemberFileName(name, join(directory, name));
    paths.push(join(WED_DIRECTORY, name));
  }
  if (paths.length > STATE_MANAGED_CHAT_LIMIT) return invalidInput(directory, "$", `at most ${STATE_MANAGED_CHAT_LIMIT} group files`);
  return paths;
}

/**
 * 从 17.2.1 格式（成员 ID 数组）的停机备份生成 `{ id, enteredAt }` 滑窗产物：每群只保留最后
 * WED_MEMBER_LIMIT 个 ID，顺序不变，进入时间统一记为迁移开始时刻。不改源文件，不覆盖既有目录，
 * 不执行服务操作；每份产物按生产启动口径回读校验，ready.json 只在全部校验及源哈希复核后产生，
 * 中断后保留目录，换新 outputRoot 重跑。部署方停服期间按清单手工替换 memory/wed/ 下的文件。
 */
export async function prepareWedMemberWindowMigration({ sourceRoot, outputRoot }: WedMemberWindowMigrationOptions): Promise<WedMemberWindowMigrationResult> {
  const source: string = await realpath(sourceRoot);
  const output: string = join(await realpath(dirname(resolve(outputRoot))), basename(resolve(outputRoot)));
  if (migrationPathContains(source, output) || migrationPathContains(output, source)) {
    return invalidInput(output, "$path", "a new directory outside the source backup");
  }
  const paths: readonly string[] = await sourceMemberPaths(source);
  const sourceFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(source, paths);
  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await mkdir(join(output, WED_DIRECTORY), { recursive: true, mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ sourceFiles }, null, JSON_INDENT), STAGING_FILE_MODE);
  const enteredAt: number = Date.now();
  let keptMembers: number = 0;
  let truncatedMembers: number = 0;
  for (const path of paths) {
    const ids: readonly number[] = parseWedMemberSourceFile(await readJsonInput(join(source, path)), join(source, path));
    const target: string = join(output, path);
    await atomicWriteText(target, serializeWedMemberEntries(windowWedMemberEntries(ids, enteredAt)), STAGING_FILE_MODE);
    const kept: number = parseWedMemberFile(await readJsonInput(target), target).size;
    keptMembers += kept;
    truncatedMembers += ids.length - kept;
  }
  if (JSON.stringify(await readMigrationFileRecords(source, await sourceMemberPaths(source))) !== JSON.stringify(sourceFiles)) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including metadata");
  }
  const outputFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, paths);
  const result: WedMemberWindowMigrationResult = {
    enteredAt, chatCount: paths.length, keptMembers, truncatedMembers,
    sourceRoot: source, outputRoot: output, sourceFiles, outputFiles,
  };
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, JSON_INDENT)}\n`, STAGING_FILE_MODE);
  await Bun.file(join(output, "incomplete.json")).delete();
  return result;
}

if (import.meta.main) {
  if (Bun.argv.slice(2).length === 1 && Bun.argv[2] === "--help") {
    console.log("bun run migrate:wed-member-window --source-root <cold-backup> --output-root <new-directory>\n" +
      "Stop the service and verify inactive before taking an external backup of memory/wed/ with ownership, modes and SHA-256.\n" +
      "Only the 17.2.1 format (arrays of member IDs) is accepted; deployments behind 17.2.1 must first upgrade to 17.2.1 and complete its migrations.\n" +
      `Each chat keeps its last ${WED_MEMBER_LIMIT} member IDs in order; every entry is written as { id, enteredAt } with the migration start time.\n` +
      "The source remains unchanged. Only ready.json marks validated output; after interruption rerun into a new output directory.\n" +
      "Verify output hashes, then manually replace memory/wed/<chatId>.json while stopped.\n" +
      "Restore original ownership/modes from sourceFiles; ensure the service can write memory/wed/ and its files.\n" +
      "Validate configuration and state before startup; retain the backup until service stability is confirmed.");
  } else {
    try {
      const result: WedMemberWindowMigrationResult = await prepareWedMemberWindowMigration(parseSourceOutputRoots(Bun.argv.slice(2)));
      console.log(`Wed member window migration prepared: ${result.outputRoot}/ready.json. Manual replacement while stopped is required.`);
    } catch (error: unknown) {
      console.error(error instanceof InputValidationError
        ? error.message
        : "Wed member window migration failed; source backup and incomplete output are retained. No deployment files were replaced.");
      process.exitCode = 1;
    }
  }
}
