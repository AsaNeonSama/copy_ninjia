import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import type { StatsFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../packages/consts/configLayout";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../packages/consts/environment";

/**
 * 测试进程的路径注入，先于任何会求值 consts/paths 的生产模块完成。
 *
 * 单独成文件，不写在 preload.ts 顶部：ESM 里 import 一律先于同文件的语句求值，
 * preload.ts 静态 import 任何生产模块都会让文件里的赋值晚一步，
 * CONFIG_ROOT 会指向开发机上的真实部署目录。
 *
 * 本文件整段同步完成：它是 preload.ts 的第一个静态 import，带顶层 await 的模块
 * 不会在同级后续 import 求值之前结束。preload.ts 自己的顶层 await 没有这个问题：
 * Bun 会等那一层续体跑完再开始跑测试文件。
 */

/** `os.tmpdir()` 读取的环境变量名；preload 的 afterAll 按它还原。 */
export const TMPDIR_ENV: string = "TMPDIR";
/** Linux tmpfs 的 statfs 文件系统类型魔数。 */
const TMPFS_MAGIC: number = 0x01021994;
/** 内存文件系统临时目录的候选位置。 */
const TMPFS_CANDIDATE_DIR: string = "/dev/shm";
/** 选用内存文件系统临时目录所需的最小可用字节数。 */
const TMPFS_MIN_AVAILABLE_BYTES: number = 512 * 1_024 * 1_024;

/** 进程原有的两个根目录与 TMPDIR 设置；preload 的 afterAll 负责还原。 */
export const PREVIOUS_DATA_ROOT: string | undefined = process.env[RUNTIME_DATA_ROOT_ENV];
export const PREVIOUS_CONFIG_ROOT: string | undefined = process.env[CONFIG_ROOT_ENV];
export const PREVIOUS_TMPDIR: string | undefined = process.env[TMPDIR_ENV];

/**
 * 测试临时目录的父目录：TMPFS_CANDIDATE_DIR 是 tmpfs 且可用空间不少于 TMPFS_MIN_AVAILABLE_BYTES 时
 * 取它，否则取进程原有的 `os.tmpdir()`。
 * @returns 测试数据根与测试 TMPDIR 的父目录。
 */
function testTempParentDir(): string {
  if (!existsSync(TMPFS_CANDIDATE_DIR)) return tmpdir();
  const stats: StatsFs = statfsSync(TMPFS_CANDIDATE_DIR);
  return stats.type === TMPFS_MAGIC && stats.bavail * stats.bsize >= TMPFS_MIN_AVAILABLE_BYTES
    ? TMPFS_CANDIDATE_DIR
    : tmpdir();
}

const TEST_TEMP_PARENT_DIR: string = testTempParentDir();

/** 测试进程独占的数据根；模块加载时创建的临时目录放在其下，由 preload 的全局 afterAll 整棵删除。 */
export const TEST_DATA_ROOT: string = mkdtempSync(join(TEST_TEMP_PARENT_DIR, "copy-ninjia-test-data-"));

/** 测试进程的 `os.tmpdir()`：用例经 tmpdir() 自建的临时目录都在其下，由 preload 的全局 afterAll 整棵删除。 */
export const TEST_TMPDIR: string = mkdtempSync(join(TEST_TEMP_PARENT_DIR, "copy-ninjia-test-tmp-"));

/** 本次测试进程独占的部署配置根；示例占位凭据只在这份副本里替换。 */
export const TEST_CONFIG_ROOT: string = join(TEST_DATA_ROOT, "config");

const CONFIG_EXAMPLE_ROOT: string = join(import.meta.dir, "..", "config_example");
cpSync(CONFIG_EXAMPLE_ROOT, TEST_CONFIG_ROOT, { recursive: true });
const TEST_STATIC_CONFIG_DIR: string = join(TEST_CONFIG_ROOT, STATIC_CONFIG_DIR_NAME);
const TEST_DYNAMIC_CONFIG_DIR: string = join(TEST_CONFIG_ROOT, DYNAMIC_CONFIG_DIR_NAME);
// 翻译凭据示例的占位私钥必然被严格解析拒绝；副本与安装器一样不带它，翻译可用性
// 由 preload 与各用例自行设定。
rmSync(join(TEST_STATIC_CONFIG_DIR, "g-auth.json"));
// 定时任务示例只示意用法：会话 id、地址与本地路径都是假的。副本换成空任务表，
// 需要任务的用例自行写入。
writeFileSync(join(TEST_DYNAMIC_CONFIG_DIR, "cron.json"), "[]\n");
const TEST_AGENT_CONFIG_PATH: string = join(TEST_DYNAMIC_CONFIG_DIR, "agent.json");
const TEST_AGENT_CONFIG: string = readFileSync(TEST_AGENT_CONFIG_PATH, "utf8").replace(
  /replace-with-([a-z]+)-api-key/g,
  "test-only-$1-api-key"
);
writeFileSync(TEST_AGENT_CONFIG_PATH, TEST_AGENT_CONFIG, { mode: 0o600 });
const TEST_BOT_CONFIG_PATH: string = join(TEST_STATIC_CONFIG_DIR, "bot.json");
const TEST_BOT_CONFIG: string = readFileSync(TEST_BOT_CONFIG_PATH, "utf8")
  .replace(
    "replace-with-telegram-bot-token",
    "123456789:test-only-telegram-bot-token"
  )
  .replace(
    "replace-with-mini-app-password",
    "test-only-mini-app-password-908172"
  );
writeFileSync(TEST_BOT_CONFIG_PATH, TEST_BOT_CONFIG, { mode: 0o600 });

// 在任何生产模块 import 之前将 database/、memory/、logs/ 与 bot.lock 定向到隔离数据根。
process.env[RUNTIME_DATA_ROOT_ENV] = TEST_DATA_ROOT;
// 部署 config/ 不受版本控制；测试和测试 Worker 统一读取独占临时副本，不读也不改开发机上的真实部署配置。
process.env[CONFIG_ROOT_ENV] = TEST_CONFIG_ROOT;
// 用例与被测代码经 os.tmpdir() 创建的临时文件落在测试独占目录（与数据根同在 TEST_TEMP_PARENT_DIR 下）。
process.env[TMPDIR_ENV] = TEST_TMPDIR;
