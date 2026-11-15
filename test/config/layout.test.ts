import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { TEST_DATA_ROOT } from "../preloadEnv";
import {
  assertDeploymentConfigLayout,
  assertNoMisplacedConfigFiles,
  readDynamicConfigLayoutRejections,
} from "../../packages/config/layout";
import { LEGACY_AD_SAMPLES_CONFIG_NAME } from "../../packages/consts/antiRaid/adDetect";
import { LEGACY_BOT_CONFIG_NAME } from "../../packages/consts/bot";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import {
  AD_DETECT_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  BOT_CONFIG_PATH,
  CONFIG_ROOT,
  CRON_CONFIG_PATH,
  DYNAMIC_CONFIG_DIR,
  GOOGLE_AUTH_FILE_PATH,
  MOOD_CONFIG_PATH,
  STATIC_CONFIG_DIR,
  STICKERS_CONFIG_PATH,
} from "../../packages/consts/paths";

let root: string;
beforeEach(() => { root = mkdtempSync(join(TEST_DATA_ROOT, "config-layout-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const STATIC_PATHS: readonly string[] = [BOT_CONFIG_PATH, GOOGLE_AUTH_FILE_PATH];
const DYNAMIC_PATHS: readonly string[] = [
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  AD_DETECT_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
  CRON_CONFIG_PATH,
];
const STATIC_NAMES: readonly string[] = STATIC_PATHS.map((path: string): string => basename(path));
const DYNAMIC_NAMES: readonly string[] = DYNAMIC_PATHS.map((path: string): string => basename(path));
const ROOT_NAMES: readonly string[] = [STATIC_CONFIG_DIR_NAME, DYNAMIC_CONFIG_DIR_NAME];

type EntryKind = "file" | "directory" | "dangling" | "hidden";

async function createUnexpectedEntry(directory: string, kind: EntryKind): Promise<string> {
  mkdirSync(directory, { recursive: true });
  const name: string = kind === "hidden" ? ".unexpected.swp" : `unexpected-${kind}`;
  const target: string = join(directory, name);
  if (kind === "file" || kind === "hidden") await Bun.write(target, "secret not read");
  else if (kind === "directory") mkdirSync(target);
  else symlinkSync(join(root, "missing-symlink-target"), target);
  return target;
}

test("部署路径常量按生效方式落在 static/ 与 dynamic/ 下", () => {
  expect(STATIC_CONFIG_DIR).toBe(join(CONFIG_ROOT, STATIC_CONFIG_DIR_NAME));
  expect(DYNAMIC_CONFIG_DIR).toBe(join(CONFIG_ROOT, DYNAMIC_CONFIG_DIR_NAME));
  for (const path of STATIC_PATHS) expect(join(STATIC_CONFIG_DIR, basename(path))).toBe(path);
  for (const path of DYNAMIC_PATHS) expect(join(DYNAMIC_CONFIG_DIR, basename(path))).toBe(path);
});

test("完整合法布局与缺少子目录（安装前）均通过", async () => {
  await expect(assertNoMisplacedConfigFiles(join(root, "absent"))).resolves.toBeUndefined();
  await expect(assertNoMisplacedConfigFiles(root)).resolves.toBeUndefined();
  mkdirSync(join(root, STATIC_CONFIG_DIR_NAME));
  await expect(assertNoMisplacedConfigFiles(root)).resolves.toBeUndefined();
  for (const path of [...STATIC_PATHS, ...DYNAMIC_PATHS]) {
    const target: string = join(root, relative(CONFIG_ROOT, path));
    mkdirSync(join(target, ".."), { recursive: true });
    await Bun.write(target, "{}");
  }
  await expect(assertNoMisplacedConfigFiles(root)).resolves.toBeUndefined();
});

test.each([...STATIC_PATHS, ...DYNAMIC_PATHS])("%s 平铺在配置根顶层即拒绝，报出归属子目录", async (path: string) => {
  const name: string = basename(path);
  const directory: string = STATIC_PATHS.includes(path) ? STATIC_CONFIG_DIR_NAME : DYNAMIC_CONFIG_DIR_NAME;
  const misplaced: string = join(root, name);
  await Bun.write(misplaced, "secret not read");
  await expect(assertNoMisplacedConfigFiles(root))
    .rejects.toThrow(`${misplaced}: $ must be absent; ${name} belongs in ${directory}/.`);
});

test.each([...STATIC_PATHS, ...DYNAMIC_PATHS])("%s 放进另一子目录即拒绝，报出归属子目录", async (path: string) => {
  const name: string = basename(path);
  const isStatic: boolean = STATIC_PATHS.includes(path);
  const directory: string = isStatic ? STATIC_CONFIG_DIR_NAME : DYNAMIC_CONFIG_DIR_NAME;
  const otherDirectory: string = isStatic ? DYNAMIC_CONFIG_DIR_NAME : STATIC_CONFIG_DIR_NAME;
  const misplaced: string = join(root, otherDirectory, name);
  mkdirSync(join(root, otherDirectory));
  await Bun.write(misplaced, "{}");
  await expect(assertNoMisplacedConfigFiles(root))
    .rejects.toThrow(`${misplaced}: $ must be absent; ${name} belongs in ${directory}/.`);
});

test.each(["file", "dangling", "directory"])("配置根顶层的旧 Bot 入口为 %s 时拒绝", async (kind: string) => {
  const legacy: string = join(root, LEGACY_BOT_CONFIG_NAME);
  if (kind === "file") await Bun.write(legacy, "secret not read");
  else if (kind === "directory") mkdirSync(legacy);
  else symlinkSync(join(root, "absent"), legacy);
  await expect(assertNoMisplacedConfigFiles(root))
    .rejects.toThrow(`${legacy}: $ must be absent after explicit cold migration to ${basename(BOT_CONFIG_PATH)}.`);
});

test.each(["file", "dangling", "directory"])("dynamic/ 下的旧广告样本配置为 %s 时拒绝并提示手工迁移", async (kind: string) => {
  const dynamicDir: string = join(root, DYNAMIC_CONFIG_DIR_NAME);
  mkdirSync(dynamicDir);
  const legacy: string = join(dynamicDir, LEGACY_AD_SAMPLES_CONFIG_NAME);
  if (kind === "file") await Bun.write(legacy, "secret not read");
  else if (kind === "directory") mkdirSync(legacy);
  else symlinkSync(join(root, "absent"), legacy);
  await expect(assertNoMisplacedConfigFiles(root))
    .rejects.toThrow(`${legacy}: $ must be absent after manual migration to ${basename(AD_DETECT_CONFIG_PATH)}.`);
});

test.each([
  ["root", "file"],
  ["root", "directory"],
  ["root", "dangling"],
  ["root", "hidden"],
  [STATIC_CONFIG_DIR_NAME, "file"],
  [STATIC_CONFIG_DIR_NAME, "directory"],
  [STATIC_CONFIG_DIR_NAME, "dangling"],
  [STATIC_CONFIG_DIR_NAME, "hidden"],
  [DYNAMIC_CONFIG_DIR_NAME, "file"],
  [DYNAMIC_CONFIG_DIR_NAME, "directory"],
  [DYNAMIC_CONFIG_DIR_NAME, "dangling"],
  [DYNAMIC_CONFIG_DIR_NAME, "hidden"],
] as const)("层级 %s 出现非白名单条目（%s）时拒绝，报错只含路径与允许名单", async (
  level: "root" | typeof STATIC_CONFIG_DIR_NAME | typeof DYNAMIC_CONFIG_DIR_NAME,
  kind: EntryKind
) => {
  const targetDir: string = level === "root" ? root : join(root, level);
  const entryPath: string = await createUnexpectedEntry(targetDir, kind);
  const allowedList: string = level === "root"
    ? ROOT_NAMES.join(", ")
    : level === STATIC_CONFIG_DIR_NAME
      ? STATIC_NAMES.join(", ")
      : DYNAMIC_NAMES.join(", ");
  const dirLabel: string = level === "root" ? basename(root) : level;
  let caught: unknown;
  try {
    await assertNoMisplacedConfigFiles(root);
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(
    `${entryPath}: $ must be absent (only ${allowedList} are allowed in ${dirLabel}/).`
  );
  expect((caught as Error).message).not.toContain("secret not read");
});

test("多个非法条目时按层级与名称排序报出第一个", async () => {
  const dynamicDir: string = join(root, DYNAMIC_CONFIG_DIR_NAME);
  mkdirSync(dynamicDir);
  await Bun.write(join(dynamicDir, "z-extra.json"), "1");
  const firstInDynamic: string = join(dynamicDir, "a-extra.json");
  await Bun.write(firstInDynamic, "2");
  await expect(assertNoMisplacedConfigFiles(root)).rejects.toThrow(
    `${firstInDynamic}: $ must be absent (only ${DYNAMIC_NAMES.join(", ")} are allowed in ${DYNAMIC_CONFIG_DIR_NAME}/).`
  );

  const firstInRoot: string = join(root, "b-root-extra");
  await Bun.write(join(root, "z-root-extra"), "3");
  await Bun.write(firstInRoot, "4");
  await expect(assertNoMisplacedConfigFiles(root)).rejects.toThrow(
    `${firstInRoot}: $ must be absent (only ${ROOT_NAMES.join(", ")} are allowed in ${basename(root)}/).`
  );
});

test("配置目录本身被普通文件或悬空链接占用时按 an existing directory 拒绝，符号链接环按 a readable directory 拒绝", async () => {
  const fileRoot: string = join(root, "file-as-root");
  await Bun.write(fileRoot, "not a directory");
  await expect(assertNoMisplacedConfigFiles(fileRoot)).rejects.toThrow(`${fileRoot}: $ must be an existing directory.`);
  await expect(readDynamicConfigLayoutRejections(fileRoot)).resolves.toEqual([
    `${fileRoot}: $ must be an existing directory.`,
  ]);

  const danglingRoot: string = join(root, "dangling-root");
  symlinkSync(join(root, "missing-dir-target"), danglingRoot);
  await expect(assertNoMisplacedConfigFiles(danglingRoot)).rejects.toThrow(
    `${danglingRoot}: $ must be an existing directory.`
  );
  await expect(readDynamicConfigLayoutRejections(danglingRoot)).resolves.toEqual([
    `${danglingRoot}: $ must be an existing directory.`,
  ]);

  for (const subdirName of [STATIC_CONFIG_DIR_NAME, DYNAMIC_CONFIG_DIR_NAME] as const) {
    const subRoot: string = join(root, `sub-${subdirName}`);
    mkdirSync(subRoot);
    const subPath: string = join(subRoot, subdirName);
    await Bun.write(subPath, "not a directory");
    await expect(assertNoMisplacedConfigFiles(subRoot)).rejects.toThrow(`${subPath}: $ must be an existing directory.`);
    rmSync(subPath, { force: true });
    symlinkSync(join(root, "missing-subdir-target"), subPath);
    await expect(assertNoMisplacedConfigFiles(subRoot)).rejects.toThrow(`${subPath}: $ must be an existing directory.`);
  }

  const loopDir: string = join(root, "loop");
  symlinkSync(loopDir, loopDir);
  await expect(assertNoMisplacedConfigFiles(loopDir)).rejects.toThrow(`${loopDir}: $ must be a readable directory.`);
  await expect(readDynamicConfigLayoutRejections(loopDir)).resolves.toEqual([
    `${loopDir}: $ must be a readable directory.`,
  ]);
  await expect(readDynamicConfigLayoutRejections(join(root, "absent-dynamic"))).resolves.toEqual([]);
});

test("启动布局检查要求 dynamic/ 是已存在的目录", async () => {
  await expect(assertDeploymentConfigLayout()).resolves.toBeUndefined();
  const movedParent: string = mkdtempSync(join(tmpdir(), "config-dynamic-moved-"));
  const moved: string = join(movedParent, DYNAMIC_CONFIG_DIR_NAME);
  await rename(DYNAMIC_CONFIG_DIR, moved);
  try {
    await expect(assertDeploymentConfigLayout()).rejects.toThrow(`${DYNAMIC_CONFIG_DIR}: $ must be an existing directory`);
    await Bun.write(DYNAMIC_CONFIG_DIR, "not a directory");
    await expect(assertDeploymentConfigLayout()).rejects.toThrow(`${DYNAMIC_CONFIG_DIR}: $ must be an existing directory`);
  } finally {
    rmSync(DYNAMIC_CONFIG_DIR, { force: true });
    await rename(moved, DYNAMIC_CONFIG_DIR);
    rmSync(movedParent, { recursive: true, force: true });
  }
});
