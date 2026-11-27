/** `migrate:ad-pack-blacklists` 冷迁移脚本的正常迁移、可选配置缺省、格式/谱系/符号链接/重叠拒绝、源不可变与 CLI 入口测试。 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { parseAdDetectConfig } from "../../packages/config/adDetectConfig";
import { adoptTimeZone, getTimeZone } from "../../packages/config/time";
import { DYNAMIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import {
  AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES,
  IDENTITY_DATABASE_SCHEMA_VERSION,
  STORAGE_MIGRATION_LINEAGE,
} from "../../packages/consts/identityStorage";
import { IDENTITY_DATABASE_MIGRATIONS_DIR } from "../../packages/consts/paths";
import { readStoredAdPackBlacklists } from "../../packages/database/interact/adPackBlacklist";
import { closeStorageDatabase, openStorageDatabase } from "../../packages/database/interact/connection";
import { validateStorageDatabase } from "../../packages/database/interact/validation";
import { InputValidationError } from "../../packages/libs/inputValidation";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import {
  STAGING_FILE_MODE,
  prepareAdPackBlacklistsMigration,
  runAdPackBlacklistsMigrationCli,
} from "../../scripts/migrateAdPackBlacklists";
import type { AdPackBlacklistsMigrationResult } from "../../scripts/migrateAdPackBlacklists";
import { AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION } from "../../scripts/migrations/adPackBlacklists/database";
import { runCapturedCommand } from "../../scripts/fixtures/subprocess";
import type { CapturedCommandResult } from "../../scripts/fixtures/subprocess";
import { TEST_DATA_ROOT } from "../preloadEnv";

/** `createSchemaV13Source` 构造 v13 测试源库的参数。 */
interface SeedV13DatabaseOptions {
  /** 源备份数据根目录。 */
  readonly targetSource: string;
  /** 写入 `storage_metadata['time-zone']` 的时区；传 null 表示刻意省略该行。 */
  readonly timeZone?: string | null;
  /** 为 true 时写入未 checkpoint 的 WAL/SHM 三件套。 */
  readonly withUncheckpointedWal?: boolean;
}

/** 源目录全部文件的字节内容与 `mtimeMs` 快照。 */
interface FileSnapshotEntry {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mode: number;
  readonly mtimeMs: number;
}

let root: string;
let source: string;
let configDir: string;
let v13MigrationsDir: string;

/** 在临时根下准备不含末条 `0012_ad_pack_blacklists` 的 v13 迁移 SQL 目录。 */
async function createV13MigrationsDir(targetDir: string): Promise<void> {
  const journal: { readonly entries: readonly { readonly tag: string; readonly when: number }[] } =
    await Bun.file(join(IDENTITY_DATABASE_MIGRATIONS_DIR, "meta/_journal.json")).json() as {
      readonly entries: readonly { readonly tag: string; readonly when: number }[];
    };
  const v13Entries: readonly { readonly tag: string; readonly when: number }[] = journal.entries.slice(0, -1);
  mkdirSync(join(targetDir, "meta"), { recursive: true });
  await Bun.write(join(targetDir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: v13Entries }));
  for (const entry of v13Entries) {
    await Bun.write(
      join(targetDir, `${entry.tag}.sql`),
      Bun.file(join(IDENTITY_DATABASE_MIGRATIONS_DIR, `${entry.tag}.sql`))
    );
  }
}

/** 在指定源备份目录下写入非空 schema v13 数据库（可选携带未 checkpoint 的 WAL/SHM）。 */
async function seedV13Database({
  targetSource,
  timeZone = "America/New_York",
  withUncheckpointedWal = false,
}: SeedV13DatabaseOptions): Promise<string> {
  mkdirSync(join(targetSource, "database"), { recursive: true });
  const livePath: string = join(root, `live-${crypto.randomUUID()}.sqlite`);
  const client: Database = new Database(livePath, { create: true });
  try {
    migrate(drizzle(client), { migrationsFolder: v13MigrationsDir });
    if (withUncheckpointedWal) {
      client.run("PRAGMA journal_mode = WAL");
      client.run("PRAGMA wal_autocheckpoint = 0");
    }
    client.run("INSERT INTO storage_metadata VALUES ('schema-version', jsonb(?))", [
      JSON.stringify({ version: AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION }),
    ]);
    if (timeZone !== null) {
      client.run("INSERT INTO storage_metadata VALUES ('time-zone', jsonb(?))", [
        JSON.stringify({ timeZone }),
      ]);
    }
    client.run("INSERT INTO chat_qa VALUES (-1001, '旧问题', jsonb('{\"a\":\"保留答案\"}'))");
    if (withUncheckpointedWal) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const filePath: string = `${livePath}${suffix}`;
        if (await Bun.file(filePath).exists()) {
          await Bun.write(join(targetSource, `database/storage.sqlite${suffix}`), Bun.file(filePath));
        }
      }
    }
  } finally {
    client.close(true);
  }
  const dbPath: string = join(targetSource, "database/storage.sqlite");
  if (!withUncheckpointedWal) {
    await Bun.write(dbPath, Bun.file(livePath));
  }
  return dbPath;
}

/** 采集指定目录集合下全部普通文件的字节、权限与 `mtimeMs` 快照。 */
async function snapshotTree(directories: readonly string[]): Promise<ReadonlyMap<string, FileSnapshotEntry>> {
  const entries = new Map<string, FileSnapshotEntry>();
  for (const directory of directories) {
    if (!(await Bun.file(directory).exists()) && lstatSync(directory, { throwIfNoEntry: false }) === undefined) continue;
    for await (const name of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true, dot: true })) {
      const fullPath: string = join(directory, name);
      const stats = lstatSync(fullPath);
      if (!stats.isFile()) continue;
      entries.set(fullPath, {
        bytes: await Bun.file(fullPath).bytes(),
        mode: stats.mode & 0o7777,
        mtimeMs: stats.mtimeMs,
      });
    }
  }
  return entries;
}

/** 构造合法的旧版 4 键 `ad_detect.json` 内容。 */
function legacyAdDetectFixture(
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return {
    punishment: { mute: { permanent: false, duration: "12h" } },
    samples: ["广告样本一", "广告样本二"],
    sticker_black_list: [" StickerPack_1 ", "StickerPack_2"],
    emoji_black_list: ["EmojiPack_1", " StickerPack_1 "],
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "ad-pack-blacklists-migration-"));
  source = join(root, "source");
  configDir = join(source, "config");
  v13MigrationsDir = join(root, "v13-migrations");
  mkdirSync(join(configDir, DYNAMIC_CONFIG_DIR_NAME), { recursive: true });
  await createV13MigrationsDir(v13MigrationsDir);
  await seedV13Database({ targetSource: source });
  await Bun.write(
    join(configDir, DYNAMIC_CONFIG_DIR_NAME, "ad_detect.json"),
    `${JSON.stringify(legacyAdDetectFixture(), null, 2)}\n`
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("完整 v13（含未 checkpoint WAL）与 4 键 ad_detect.json 迁移至 v14 与 2 键配置，保留时区、权限并保持源不可变", async () => {
  const walSource: string = join(root, "wal-source");
  const separateConfig: string = join(root, "separate-config");
  mkdirSync(join(separateConfig, DYNAMIC_CONFIG_DIR_NAME), { recursive: true });
  await seedV13Database({ targetSource: walSource, timeZone: "America/New_York", withUncheckpointedWal: true });
  const adDetectPath: string = join(separateConfig, DYNAMIC_CONFIG_DIR_NAME, "ad_detect.json");
  await Bun.write(adDetectPath, `${JSON.stringify(legacyAdDetectFixture(), null, 2)}\n`);
  chmodSync(adDetectPath, 0o640);
  // 验证源库只读备份权限（0440）也可安全复制到暂存区并完成迁移。
  chmodSync(join(walSource, "database/storage.sqlite"), 0o440);
  const before: ReadonlyMap<string, FileSnapshotEntry> = await snapshotTree([walSource, separateConfig]);

  const output: string = join(root, "output");
  const result: AdPackBlacklistsMigrationResult = await prepareAdPackBlacklistsMigration({
    sourceRoot: walSource,
    configRoot: separateConfig,
    outputRoot: output,
  });

  expect(result).toMatchObject({
    sourceSchema: AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION,
    targetSchema: IDENTITY_DATABASE_SCHEMA_VERSION,
    timeZone: "America/New_York",
    adDetectConfigMigrated: true,
    migratedStickerPacks: 2,
    migratedEmojiPacks: 2,
  });
  expect(result.outputFiles.map((file: { readonly path: string }): string => file.path)).toEqual([
    "database/storage.sqlite",
    "config/dynamic/ad_detect.json",
  ]);
  expect(result.outputFiles[0]?.mode).toBe(STAGING_FILE_MODE);
  expect(result.outputFiles[1]?.mode).toBe(0o640);

  const outputAdDetectPath: string = join(output, "config/dynamic/ad_detect.json");
  const outputAdDetectText: string = await Bun.file(outputAdDetectPath).text();
  expect(outputAdDetectText.endsWith("\n")).toBeTrue();
  const outputAdDetectJson: unknown = JSON.parse(outputAdDetectText);
  expect(outputAdDetectJson).toEqual({
    punishment: { mute: { permanent: false, duration: "12h" } },
    samples: ["广告样本一", "广告样本二"],
  });
  expect(parseAdDetectConfig(outputAdDetectJson, outputAdDetectPath).samples).toEqual(["广告样本一", "广告样本二"]);

  expect(await Bun.file(join(output, "database/storage.sqlite-wal")).exists()).toBeFalse();
  expect(await Bun.file(join(output, "database/storage.sqlite-shm")).exists()).toBeFalse();
  expect(await Bun.file(join(output, "ready.json")).json()).toEqual(result);
  expect(await Bun.file(join(output, "incomplete.json")).exists()).toBeFalse();

  const previousTimeZone: string = getTimeZone();
  let migratedDb: StorageDatabase | undefined;
  try {
    adoptTimeZone("America/New_York");
    const migratedDbPath: string = join(output, "database/storage.sqlite");
    migratedDb = openStorageDatabase({ path: migratedDbPath, readonly: true });
    const inspection = validateStorageDatabase(migratedDb, migratedDbPath);
    expect(inspection.hydration.adPackBlacklistCounts).toEqual({ sticker: 2, emoji: 2 });
    const storedBlacklists = readStoredAdPackBlacklists(migratedDb);
    expect(storedBlacklists.filter((row): boolean => row.kind === "sticker").map((row): string => row.pack))
      .toEqual(["StickerPack_1", "StickerPack_2"]);
    expect(storedBlacklists.filter((row): boolean => row.kind === "emoji").map((row): string => row.pack))
      .toEqual(["EmojiPack_1", "StickerPack_1"]);
    expect(inspection.hydration.chatQa.get(-1001)?.get("旧问题")).toBe("保留答案");
  } finally {
    if (migratedDb !== undefined) closeStorageDatabase(migratedDb);
    adoptTimeZone(previousTimeZone);
  }
  expect(await snapshotTree([walSource, separateConfig])).toEqual(before);
});

test("默认 --config-root 指向 <source-root>/config，且缺失 ad_detect.json 时仅迁移数据库不伪造配置文件", async () => {
  const defaultOutput: string = join(root, "default-cfg-out");
  const withDefaultConfig: AdPackBlacklistsMigrationResult = await prepareAdPackBlacklistsMigration({
    sourceRoot: source,
    outputRoot: defaultOutput,
  });
  expect(withDefaultConfig.adDetectConfigMigrated).toBeTrue();
  expect(withDefaultConfig.migratedStickerPacks).toBe(2);
  expect(withDefaultConfig.migratedEmojiPacks).toBe(2);

  // 删除整个 config/ 目录后迁移：不创建 ad_detect.json，表为空。
  await rm(configDir, { recursive: true });
  const noConfigOutput: string = join(root, "no-config-out");
  const withoutConfig: AdPackBlacklistsMigrationResult = await prepareAdPackBlacklistsMigration({
    sourceRoot: source,
    outputRoot: noConfigOutput,
  });
  expect(withoutConfig).toMatchObject({
    sourceSchema: AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION,
    targetSchema: IDENTITY_DATABASE_SCHEMA_VERSION,
    adDetectConfigMigrated: false,
    migratedStickerPacks: 0,
    migratedEmojiPacks: 0,
  });
  expect(withoutConfig.outputFiles.map((file: { readonly path: string }): string => file.path)).toEqual([
    "database/storage.sqlite",
  ]);
  expect(await Bun.file(join(noConfigOutput, "config/dynamic/ad_detect.json")).exists()).toBeFalse();

  // 显式 --config-root 存在但缺少 dynamic/ad_detect.json 时同样允许，不伪造配置。
  const emptyCfg: string = join(root, "empty-cfg");
  mkdirSync(emptyCfg);
  const explicitEmptyOut: string = join(root, "explicit-empty-out");
  const explicitResult: AdPackBlacklistsMigrationResult = await prepareAdPackBlacklistsMigration({
    sourceRoot: source,
    configRoot: emptyCfg,
    outputRoot: explicitEmptyOut,
  });
  expect(explicitResult.adDetectConfigMigrated).toBeFalse();
  expect(await Bun.file(join(explicitEmptyOut, "config/dynamic/ad_detect.json")).exists()).toBeFalse();
});

test("超出 768 内存缓存容量的大规模贴纸与表情黑名单可完整迁移至 SQLite，不再受硬上限拦截", async () => {
  const largeCount: number = AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES + 32;
  const manyPacks: readonly string[] = Array.from(
    { length: largeCount },
    (_: unknown, index: number): string => `Pack_${index}`
  );
  const adDetectPath: string = join(configDir, DYNAMIC_CONFIG_DIR_NAME, "ad_detect.json");
  await Bun.write(adDetectPath, JSON.stringify(legacyAdDetectFixture({
    sticker_black_list: manyPacks,
    emoji_black_list: manyPacks,
  })));
  const outputDir: string = join(root, "large-migration");
  const okResult: AdPackBlacklistsMigrationResult = await prepareAdPackBlacklistsMigration({
    sourceRoot: source,
    outputRoot: outputDir,
  });
  expect(okResult.migratedStickerPacks).toBe(largeCount);
  expect(okResult.migratedEmojiPacks).toBe(largeCount);
  expect(await Bun.file(join(outputDir, "ready.json")).exists()).toBeTrue();
});

test("已迁移产物（v14 库）、v13 配 2 键配置、未知谱系与缺失时区均被拒绝且保留源不变", async () => {
  const first: AdPackBlacklistsMigrationResult = await prepareAdPackBlacklistsMigration({
    sourceRoot: source,
    outputRoot: join(root, "first"),
  });
  await expect(prepareAdPackBlacklistsMigration({
    sourceRoot: first.outputRoot,
    outputRoot: join(root, "second"),
  })).rejects.toThrow(`schema version ${AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION} from the preceding migration`);
  expect(await Bun.file(join(root, "second/ready.json")).exists()).toBeFalse();

  // v13 库搭配已迁移的 2 键 ad_detect.json 必须拒绝。
  const adDetectPath: string = join(configDir, DYNAMIC_CONFIG_DIR_NAME, "ad_detect.json");
  await Bun.write(adDetectPath, JSON.stringify({
    punishment: { kick: { block: false } },
    samples: ["样本"],
  }));
  await expect(prepareAdPackBlacklistsMigration({
    sourceRoot: source,
    outputRoot: join(root, "two-key-reject"),
  })).rejects.toThrow("sticker_black_list: string[], emoji_black_list: string[]");

  // 篡改 __drizzle_migrations 谱系哈希时拒绝。
  await rm(adDetectPath);
  const badLineageSource: string = join(root, "bad-lineage");
  const badLineageDb: string = await seedV13Database({ targetSource: badLineageSource });
  const client: Database = new Database(badLineageDb);
  try {
    client.run("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?", [
      "0".repeat(64),
      STORAGE_MIGRATION_LINEAGE[0]!.createdAt,
    ]);
  } finally {
    client.close(true);
  }
  await expect(prepareAdPackBlacklistsMigration({
    sourceRoot: badLineageSource,
    outputRoot: join(root, "bad-lineage-out"),
  })).rejects.toThrow(`__drizzle_migrations must be the exact schema v${AD_PACK_BLACKLISTS_SOURCE_SCHEMA_VERSION} lineage.`);

  // 缺失 time-zone 元数据时拒绝。
  const noTzSource: string = join(root, "no-tz");
  await seedV13Database({ targetSource: noTzSource, timeZone: null });
  await expect(prepareAdPackBlacklistsMigration({
    sourceRoot: noTzSource,
    outputRoot: join(root, "no-tz-out"),
  })).rejects.toThrow("storage_metadata.time-zone must be present.");
});

test.each([
  ["未知字段", JSON.stringify({ ...legacyAdDetectFixture(), extra: true }), "exactly { punishment: object"],
  ["非法贴纸包名", JSON.stringify(legacyAdDetectFixture({ sticker_black_list: ["bad-pack!"] })), "$.sticker_black_list[0] must be a valid Telegram sticker pack short name."],
  ["trim 后重复表情包", JSON.stringify(legacyAdDetectFixture({ emoji_black_list: [" SamePack ", "SamePack"] })), "$.emoji_black_list[1] must be unique."],
  ["非法 punishment", JSON.stringify(legacyAdDetectFixture({ punishment: { mute: { permanent: true }, kick: { block: false } } })), "$.punishment must be an object with exactly one of mute or kick."],
  ["空广告样本", JSON.stringify(legacyAdDetectFixture({ samples: ["   "] })), "$.samples[0] must be a non-empty string."],
  ["损坏 JSON", "{invalid", "$ must be a readable valid JSON document."],
])("非法旧版 ad_detect.json（%s）被拒绝且不生成 ready.json", async (_label: string, content: string, message: string) => {
  const adDetectPath: string = join(configDir, DYNAMIC_CONFIG_DIR_NAME, "ad_detect.json");
  await Bun.write(adDetectPath, content);
  const before: ReadonlyMap<string, FileSnapshotEntry> = await snapshotTree([source]);
  const output: string = join(root, `invalid-${crypto.randomUUID()}`);
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: source, outputRoot: output })).rejects.toThrow(message);
  expect(await Bun.file(join(output, "ready.json")).exists()).toBeFalse();
  expect(await snapshotTree([source])).toEqual(before);
});

test("符号链接、非普通文件、缺失显式 --config-root 与重叠 --output-root 均被拒绝", async () => {
  const separateConfig: string = join(root, "cfg-overlap");
  mkdirSync(join(separateConfig, DYNAMIC_CONFIG_DIR_NAME), { recursive: true });
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: source, outputRoot: join(source, "out") }))
    .rejects.toThrow("a new directory outside the source backup");
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: join(source, "database"), outputRoot: source }))
    .rejects.toThrow("a new directory outside the source backup");
  await expect(prepareAdPackBlacklistsMigration({
    sourceRoot: source, configRoot: separateConfig, outputRoot: join(separateConfig, "out"),
  })).rejects.toThrow("a new directory outside the source and config backups");
  await expect(prepareAdPackBlacklistsMigration({
    sourceRoot: source, configRoot: join(root, "nonexistent-config"), outputRoot: join(root, "missing-cfg-out"),
  })).rejects.toThrow("ENOENT");

  // ad_detect.json 为符号链接时拒绝。
  const linkedFile: string = join(root, "real-ad-detect.json");
  await Bun.write(linkedFile, JSON.stringify(legacyAdDetectFixture()));
  const dynamicDir: string = join(configDir, DYNAMIC_CONFIG_DIR_NAME);
  const adDetectPath: string = join(dynamicDir, "ad_detect.json");
  await rm(adDetectPath);
  symlinkSync(linkedFile, adDetectPath);
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: source, outputRoot: join(root, "symlink-cfg-out") }))
    .rejects.toThrow("a regular file without symbolic links");

  // ad_detect.json 为目录（非普通文件）时拒绝，非 ENOENT 错误不被吞掉。
  await rm(adDetectPath);
  mkdirSync(adDetectPath);
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: source, outputRoot: join(root, "dir-ad-detect-out") }))
    .rejects.toThrow("a regular file without symbolic links");

  // config/dynamic/ 目录为符号链接时拒绝，非 ENOENT 错误不被吞掉。
  const realDynamicDir: string = join(root, "real-dynamic-dir");
  mkdirSync(realDynamicDir);
  await Bun.write(join(realDynamicDir, "ad_detect.json"), JSON.stringify(legacyAdDetectFixture()));
  await rm(dynamicDir, { recursive: true });
  symlinkSync(realDynamicDir, dynamicDir);
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: source, outputRoot: join(root, "symlink-dynamic-out") }))
    .rejects.toThrow("a directory without symbolic links");

  // database/storage.sqlite-wal 为符号链接时拒绝。
  await rm(dynamicDir);
  const dummyWal: string = join(root, "dummy-wal");
  await Bun.write(dummyWal, "x");
  symlinkSync(dummyWal, join(source, "database/storage.sqlite-wal"));
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: source, outputRoot: join(root, "symlink-wal-out") }))
    .rejects.toThrow("a regular file without symbolic links");

  // database/ 目录为符号链接时拒绝。
  const symlinkDbSource: string = join(root, "symlink-db-source");
  mkdirSync(symlinkDbSource);
  symlinkSync(join(source, "database"), join(symlinkDbSource, "database"));
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: symlinkDbSource, outputRoot: join(root, "symlink-db-out") }))
    .rejects.toThrow("a directory without symbolic links");
});

test("不覆盖既有输出，中断保留 incomplete.json 后在新目录重跑成功，且拦截迁移途中源备份篡改", async () => {
  const interrupted: string = join(root, "interrupted");
  mkdirSync(interrupted);
  await Bun.write(join(interrupted, "incomplete.json"), "preserve");
  await expect(prepareAdPackBlacklistsMigration({ sourceRoot: source, outputRoot: interrupted }))
    .rejects.toThrow("EEXIST");
  expect(await Bun.file(join(interrupted, "incomplete.json")).text()).toBe("preserve");

  // 模拟迁移途中源文件权限被修改：拒绝写出 ready.json 并保留 incomplete.json。
  const adDetectPath: string = join(configDir, DYNAMIC_CONFIG_DIR_NAME, "ad_detect.json");
  chmodSync(adDetectPath, 0o644);
  const originalParse: typeof JSON.parse = JSON.parse;
  let tampered: boolean = false;
  const parseSpy = spyOn(JSON, "parse").mockImplementation((text: string, reviver?: unknown): unknown => {
    const parsed: unknown = originalParse(text, reviver as never);
    if (!tampered && typeof parsed === "object" && parsed !== null && "sticker_black_list" in parsed) {
      tampered = true;
      chmodSync(adDetectPath, 0o600);
    }
    return parsed;
  });
  const tamperedOut: string = join(root, "tampered-out");
  try {
    await expect(prepareAdPackBlacklistsMigration({ sourceRoot: source, outputRoot: tamperedOut }))
      .rejects.toThrow(InputValidationError);
  } finally {
    parseSpy.mockRestore();
  }
  expect(await Bun.file(join(tamperedOut, "ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(tamperedOut, "incomplete.json")).exists()).toBeTrue();

  // 中断后指向全新 outputRoot 重跑成功。
  const retry: AdPackBlacklistsMigrationResult = await prepareAdPackBlacklistsMigration({
    sourceRoot: source,
    outputRoot: join(root, "retry-out"),
  });
  expect(retry.migratedStickerPacks).toBe(2);
  expect(retry.migratedEmojiPacks).toBe(2);
});

test("CLI 入口覆盖 --help、正常迁移、InputValidationError 与通用系统错误退出码", async () => {
  const logSpy = spyOn(console, "log").mockImplementation((): void => {});
  const errorSpy = spyOn(console, "error").mockImplementation((): void => {});
  try {
    expect(await runAdPackBlacklistsMigrationCli(["--help"])).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toContain(
      "bun run migrate:ad-pack-blacklists --source-root <cold-backup> [--config-root <config-backup>] --output-root <new-directory>"
    );

    logSpy.mockClear();
    const cliOutput: string = join(root, "cli-out");
    expect(await runAdPackBlacklistsMigrationCli([
      "--source-root", source, "--config-root", configDir, "--output-root", cliOutput,
    ])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      `Ad pack blacklists migration prepared: ${cliOutput}/ready.json. Manual replacement while stopped is required.`
    );
    expect(await Bun.file(join(cliOutput, "ready.json")).exists()).toBeTrue();

    expect(await runAdPackBlacklistsMigrationCli([])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("arguments: $ must be both required path options.");

    errorSpy.mockClear();
    expect(await runAdPackBlacklistsMigrationCli([
      "--source-root", source, "--output-root", cliOutput,
    ])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Ad pack blacklists migration failed; source backup and incomplete output are retained. No deployment files were replaced."
    );
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  const helpRun: CapturedCommandResult = await runCapturedCommand({
    cmd: [Bun.argv[0]!, join(import.meta.dir, "../../scripts/migrateAdPackBlacklists.ts"), "--help"],
    cwd: root,
  });
  expect(helpRun.exitCode).toBe(0);
  expect(helpRun.stdout).toContain("bun run migrate:ad-pack-blacklists");
});
