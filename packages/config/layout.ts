/**
 * 部署配置目录布局的白名单检查；安装器、启动总闸与热重载共用，只列出目录项，不读取文件内容。
 *
 * 配置根顶层只允许 static/ 与 dynamic/：static/ 下只允许修改后须重启的 bot.json、g-auth.json，
 * dynamic/ 下只允许热重载即时生效的六份部署文件（见 config/reload.ts）。其余任何条目（含未迁移旧入口、
 * 放错子目录的部署文件、隐藏文件、交换文件、备份、子目录与悬空链接）一律按致命错误拒绝。
 */

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { LEGACY_AD_SAMPLES_CONFIG_NAME } from "../consts/antiRaid/adDetect";
import { LEGACY_BOT_CONFIG_NAME } from "../consts/bot";
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
  STICKERS_CONFIG_PATH,
} from "../consts/paths";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../consts/configLayout";
import { isErrno } from "../libs/errno";
import { InputValidationError, invalidInput, isMissingLeaf } from "../libs/inputValidation";

/** 部署配置白名单的目录层级标识。 */
type ConfigLayoutLevel = "root" | "static" | "dynamic";

/** 单层配置目录的白名单规则。 */
interface ConfigLayoutRule {
  /** 当前检查的目录层级。 */
  readonly level: ConfigLayoutLevel;
  /** 允许出现的目录项基名列表。 */
  readonly allowedNames: readonly string[];
  /** 用于诊断文案的允许名单拼接文本。 */
  readonly allowedList: string;
}

const ROOT_ALLOWED_NAMES: readonly string[] = [STATIC_CONFIG_DIR_NAME, DYNAMIC_CONFIG_DIR_NAME];
const STATIC_ALLOWED_NAMES: readonly string[] = [BOT_CONFIG_PATH, GOOGLE_AUTH_FILE_PATH].map(
  (path: string): string => basename(path)
);
const DYNAMIC_ALLOWED_NAMES: readonly string[] = [
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  AD_DETECT_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
  CRON_CONFIG_PATH,
].map((path: string): string => basename(path));

const ROOT_LAYOUT_RULE: ConfigLayoutRule = {
  level: "root",
  allowedNames: ROOT_ALLOWED_NAMES,
  allowedList: ROOT_ALLOWED_NAMES.join(", "),
};
const STATIC_LAYOUT_RULE: ConfigLayoutRule = {
  level: "static",
  allowedNames: STATIC_ALLOWED_NAMES,
  allowedList: STATIC_ALLOWED_NAMES.join(", "),
};
const DYNAMIC_LAYOUT_RULE: ConfigLayoutRule = {
  level: "dynamic",
  allowedNames: DYNAMIC_ALLOWED_NAMES,
  allowedList: DYNAMIC_ALLOWED_NAMES.join(", "),
};

const BOT_CONFIG_NAME: string = basename(BOT_CONFIG_PATH);
const AD_DETECT_CONFIG_NAME: string = basename(AD_DETECT_CONFIG_PATH);

/**
 * 查询已知部署配置文件基名对应的合法所属子目录名。
 * @param name 目录项基名。
 * @returns 已知部署文件的所属子目录名；未知文件名返回 `undefined`。
 */
function ownerDirectoryForConfigFile(name: string): string | undefined {
  if (STATIC_ALLOWED_NAMES.includes(name)) return STATIC_CONFIG_DIR_NAME;
  if (DYNAMIC_ALLOWED_NAMES.includes(name)) return DYNAMIC_CONFIG_DIR_NAME;
  return undefined;
}

/**
 * 构造非白名单目录项的期望形态描述。
 * @param rule 当前目录层级的白名单规则。
 * @param directoryLabel 诊断文案中展示的目录名。
 * @param name 非白名单目录项名称。
 * @returns 传给 `InputValidationError` 的期望形态英文描述。
 */
function expectedEntryShape(
  rule: ConfigLayoutRule,
  directoryLabel: string,
  name: string
): string {
  if (rule.level === "root" && name === LEGACY_BOT_CONFIG_NAME) {
    return `absent after explicit cold migration to ${BOT_CONFIG_NAME}`;
  }
  if (rule.level === "dynamic" && name === LEGACY_AD_SAMPLES_CONFIG_NAME) {
    return `absent after manual migration to ${AD_DETECT_CONFIG_NAME}`;
  }
  const ownerDirectory: string | undefined = ownerDirectoryForConfigFile(name);
  if (ownerDirectory !== undefined) {
    return `absent; ${name} belongs in ${ownerDirectory}/`;
  }
  return `absent (only ${rule.allowedList} are allowed in ${directoryLabel}/)`;
}

/** 目录项列出结果：成功返回已排序基名列表，失败返回期望形态描述。 */
type DirectoryNamesResult =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly expected: string };

/**
 * 按字典序列出目录项名称；叶子路径本身不存在（`ENOENT` 且非悬空链接）视为空，
 * 非目录（`ENOTDIR`）或悬空链接按 `"an existing directory"` 拒绝，其余读取失败按 `"a readable directory"` 拒绝。
 * @param directory 待列出的目录路径。
 * @returns 已排序名称列表或期望形态失败结果。
 */
async function listSortedDirectoryNames(directory: string): Promise<DirectoryNamesResult> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      if (await isMissingLeaf(directory)) return { ok: true, names: [] };
      return { ok: false, expected: "an existing directory" };
    }
    if (isErrno(error, "ENOTDIR")) {
      return { ok: false, expected: "an existing directory" };
    }
    return { ok: false, expected: "a readable directory" };
  }
  names.sort();
  return { ok: true, names };
}

/**
 * 核对单层配置目录的白名单；目录自身为非目录/悬空链接或遇到第一个非白名单条目即抛出安全校验错误。
 * @param directory 待检查的目录路径。
 * @param directoryLabel 诊断文案中展示的目录名。
 * @param rule 当前层级的白名单规则。
 */
async function assertDirectoryWhitelist(
  directory: string,
  directoryLabel: string,
  rule: ConfigLayoutRule
): Promise<void> {
  const listed: DirectoryNamesResult = await listSortedDirectoryNames(directory);
  if (!listed.ok) return invalidInput(directory, "$", listed.expected);
  for (const name of listed.names) {
    if (rule.allowedNames.includes(name)) continue;
    return invalidInput(join(directory, name), "$", expectedEntryShape(rule, directoryLabel, name));
  }
}

/**
 * 按三层白名单核对配置根、`static/` 与 `dynamic/` 下的目录项，按层级与名称排序拒绝第一个非白名单条目。
 * 配置根或子目录本身不存在时视为空（普通文件或悬空链接仍拒绝）；安装器在建立子目录与示例文件之前调用。
 * @param root 部署配置根目录路径。
 */
export async function assertNoMisplacedConfigFiles(root: string): Promise<void> {
  const rootLabel: string = basename(root) || root;
  await assertDirectoryWhitelist(root, rootLabel, ROOT_LAYOUT_RULE);
  await assertDirectoryWhitelist(join(root, STATIC_CONFIG_DIR_NAME), STATIC_CONFIG_DIR_NAME, STATIC_LAYOUT_RULE);
  await assertDirectoryWhitelist(join(root, DYNAMIC_CONFIG_DIR_NAME), DYNAMIC_CONFIG_DIR_NAME, DYNAMIC_LAYOUT_RULE);
}

/**
 * 扫描 `dynamic/` 内部的非白名单目录项，返回与启动总闸同一期望形态的拒绝诊断列表，不抛出异常。
 * 目录真正暂缺（`ENOENT` 且非悬空链接）返回空列表；目录路径被非目录或悬空链接占用返回 `"an existing directory"` 诊断，
 * 其余目录读取失败返回单条 `"a readable directory"` 诊断。
 * @param directory 动态配置目录路径，默认为 `DYNAMIC_CONFIG_DIR`。
 * @returns 按目录项名称排序的英文拒绝诊断列表。
 */
export async function readDynamicConfigLayoutRejections(
  directory: string = DYNAMIC_CONFIG_DIR
): Promise<readonly string[]> {
  const listed: DirectoryNamesResult = await listSortedDirectoryNames(directory);
  if (!listed.ok) {
    return [new InputValidationError(directory, "$", listed.expected).message];
  }
  const rejections: string[] = [];
  for (const name of listed.names) {
    if (DYNAMIC_LAYOUT_RULE.allowedNames.includes(name)) continue;
    const expected: string = expectedEntryShape(DYNAMIC_LAYOUT_RULE, DYNAMIC_CONFIG_DIR_NAME, name);
    rejections.push(new InputValidationError(join(directory, name), "$", expected).message);
  }
  return rejections;
}

/**
 * 启动总闸的布局检查：先核对三层目录白名单，再要求 dynamic/ 是已存在的目录（可为空），
 * 热重载监听才有目录可挂。在读取 bot.json 之前调用。
 */
export async function assertDeploymentConfigLayout(): Promise<void> {
  await assertNoMisplacedConfigFiles(CONFIG_ROOT);
  try {
    if ((await Bun.file(DYNAMIC_CONFIG_DIR).stat()).isDirectory()) return;
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) return invalidInput(DYNAMIC_CONFIG_DIR, "$", "an accessible directory");
  }
  return invalidInput(DYNAMIC_CONFIG_DIR, "$", "an existing directory");
}
