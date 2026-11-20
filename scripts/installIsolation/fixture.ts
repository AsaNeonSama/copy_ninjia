import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFixtureTree } from "../fixtures/copyTree";
import { runCapturedTerminalCommand } from "../fixtures/subprocess";
import type { CapturedCommandResult } from "../fixtures/subprocess";
import { readInstallScripts } from "../installSources";
import { installFixtureGuards } from "./fixtureGuards";

/** 读取 `package.json` 中 `packageManager` 锁定版本所需的最小结构。 */
interface PackageManifest {
  readonly packageManager: string;
}

const PROJECT_ROOT: string = join(import.meta.dir, "..", "..");
const MANIFEST: PackageManifest = await Bun.file(join(PROJECT_ROOT, "package.json")).json() as PackageManifest;
/** package.json 的 packageManager 锁定的 Bun 版本；替身 bun 的 `--version` 缺省报告它。 */
export const REQUIRED_BUN_VERSION: string = MANIFEST.packageManager.slice("bun@".length);
const CONFIG_EXAMPLE_ROOT: string = join(PROJECT_ROOT, "config_example");
const REAL_BUN_PATH: string = Bun.argv[0]!;
/** 替身 bun 解析数据根时直接加载的生产路径模块。 */
const PATHS_MODULE_PATH: string = join(PROJECT_ROOT, "packages", "consts", "paths.ts");

/** 安装器与运维脚本隔离验证环境的目录与日志路径夹具。 */
export interface InstallerFixture {
  readonly realRuntime: boolean;
  readonly root: string;
  readonly worktree: string;
  readonly configRoot: string;
  readonly backupRoot: string;
  readonly runtimeRoot: string;
  readonly binRoot: string;
  readonly callLog: string;
  readonly outboundLog: string;
}

/** 交互式安装脚本单步终端提示的匹配与应答定义。 */
export interface PromptReply {
  readonly prompt: string;
  readonly reply?: string;
  readonly close?: boolean;
  readonly optional?: boolean;
  readonly secret?: boolean;
}

/** 安装器或运维脚本子进程运行的退出码与合并输出。 */
export interface InstallerRunResult {
  readonly exitCode: number;
  readonly output: string;
}

const fixtureRoots: string[] = [];

/**
 * 向目标路径写入文本内容，并在指定权限位时执行 chmod。
 * @param path 目标文件路径。
 * @param content 文本内容。
 * @param mode 可选的文件权限位。
 */
export async function writeText(path: string, content: string, mode?: number): Promise<void> {
  await Bun.write(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

/**
 * 创建全新的安装器隔离测试夹具目录树及全部受控替身脚本。
 * @param realRuntime 是否拷贝真实应用源码以在安装末尾启动真实运行时。
 * @returns 已就绪的安装器隔离测试夹具。
 */
export async function createFixture(realRuntime: boolean = false): Promise<InstallerFixture> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-install-test-"));
  fixtureRoots.push(root);
  const fixture: InstallerFixture = {
    realRuntime,
    root,
    worktree: join(root, "repository"),
    configRoot: join(root, "repository", "config"),
    backupRoot: join(root, "backups"),
    runtimeRoot: join(root, "runtime"),
    binRoot: join(root, "bin"),
    callLog: join(root, "calls.log"),
    outboundLog: join(root, "outbound.log"),
  };
  mkdirSync(fixture.worktree, { recursive: true });
  mkdirSync(fixture.backupRoot, { mode: 0o700 });
  mkdirSync(fixture.runtimeRoot, { mode: 0o700 });
  mkdirSync(fixture.binRoot, { mode: 0o700 });
  mkdirSync(join(root, "home"), { mode: 0o700 });
  // 只在夹具副本替换系统路径，所有宿主都执行同一条 systemd 分支。
  const systemdRoot: string = join(root, "systemd");
  mkdirSync(systemdRoot);
  await writeText(join(systemdRoot, "copy-ninjia.service"), "[Service]\n");
  for (const script of await readInstallScripts(PROJECT_ROOT)) {
    const installer: string = script.source
      .replaceAll("/run/systemd/system", systemdRoot)
      .replace("/etc/systemd/system/${SERVICE_NAME}.service", `${systemdRoot}/\u0024{SERVICE_NAME}.service`);
    await writeText(join(fixture.worktree, script.path), installer);
  }
  await copyFixtureTree(CONFIG_EXAMPLE_ROOT, join(fixture.worktree, "config_example"));
  await Bun.write(join(fixture.worktree, "package.json"), Bun.file(join(PROJECT_ROOT, "package.json")));
  await writeText(join(fixture.worktree, "index.ts"), "");
  if (realRuntime) {
    for (const relativePath of ["packages", "index.ts", "tsconfig.json", "bun.lock", "scripts/install/runtime.ts"]) {
      await copyFixtureTree(join(PROJECT_ROOT, relativePath), join(fixture.worktree, relativePath));
    }
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fixture.worktree, "node_modules"));
    for (const preload of ["test/helpers/installedApplication.ts", "test/helpers/installedWorkerNetwork.ts"]) {
      await copyFixtureTree(join(PROJECT_ROOT, preload), join(fixture.worktree, preload));
    }
  }
  await writeText(fixture.callLog, "");
  await writeText(fixture.outboundLog, "");
  await installFixtureGuards({
    binRoot: fixture.binRoot,
    requiredBunVersion: REQUIRED_BUN_VERSION,
  });
  return fixture;
}

/**
 * 夹具默认环境叠加用例覆盖项；覆盖值为 undefined 的变量从环境中移除。
 * @param fixture 安装器隔离测试夹具。
 * @param extra 用例附加或移除（值为 undefined）的环境变量表。
 * @returns 合并后的子进程环境变量字典。
 */
function installerEnvironment(
  fixture: InstallerFixture,
  extra: Readonly<Record<string, string | undefined>> = {}
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    PATH: [fixture.binRoot, "/usr/bin", "/bin"].join(":"),
    HOME: join(fixture.root, "home"),
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: fixture.backupRoot,
    COPY_NINJIA_DATA_ROOT: fixture.runtimeRoot,
    REAL_BUN_PATH,
    FAKE_WORKTREE: fixture.worktree,
    FAKE_RUNTIME_ROOT: fixture.runtimeRoot,
    FAKE_BIN_ROOT: fixture.binRoot,
    FAKE_IDENTITY_DATABASE: join(fixture.runtimeRoot, "database", "storage.sqlite"),
    FAKE_CALL_LOG: fixture.callLog,
    FAKE_REAL_RUNTIME: fixture.realRuntime ? "1" : "0",
    FAKE_OUTBOUND_LOG: fixture.outboundLog,
    FAKE_PATHS_MODULE: PATHS_MODULE_PATH,
    FAKE_INSTALL_RUNTIME_MODULE: join(PROJECT_ROOT, "scripts/install/runtime.ts"),
  };
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
}

/**
 * 在伪终端中执行安装器脚本并按序喂入交互输入，核对提示词出现顺序与脱敏输出。
 * @param fixture 安装器隔离测试夹具。
 * @param prompts 预期的交互提示词与应答序列。
 * @param extraEnvironment 附加或覆盖的环境变量表。
 * @returns 安装器退出码与脱敏后的完整终端输出。
 */
export async function runInstaller(
  fixture: InstallerFixture,
  prompts: readonly PromptReply[],
  extraEnvironment: Readonly<Record<string, string | undefined>> = {}
): Promise<InstallerRunResult> {
  let input: string = "";
  for (const prompt of prompts) {
    if (prompt.close === true) break;
    input += `${prompt.reply ?? ""}\n`;
  }
  const result: CapturedCommandResult = await runCapturedTerminalCommand({
    cmd: ["/bin/bash", "-c", "umask 022; bash ./install.sh"],
    cwd: fixture.worktree,
    env: installerEnvironment(fixture, extraEnvironment),
    input,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const rawOutput: string = result.stdout + result.stderr;
  // 真实应用夹具已自行完成 SIGTERM 排空，下次安装从已停止状态开始。
  if (fixture.realRuntime) {
    rmSync(join(fixture.runtimeRoot, "service-started"), { force: true });
    rmSync(join(fixture.runtimeRoot, "service-observed"), { force: true });
  }
  let output: string = rawOutput;
  for (const prompt of prompts) {
    if (prompt.secret === true && prompt.reply !== undefined) {
      output = output.replaceAll(prompt.reply, "[secret]");
    }
  }
  for (const prompt of prompts) {
    if (prompt.optional === true || output.includes(prompt.prompt)) continue;
    let safeOutput: string = output;
    for (const secret of prompts) {
      if (secret.reply !== undefined && secret.reply.length > 0) {
        safeOutput = safeOutput.replaceAll(secret.reply, "[input]");
      }
    }
    throw new Error(`installer exited before prompt ${prompt.prompt}:\n${safeOutput}`);
  }
  return { exitCode: result.exitCode, output };
}

/**
 * 构造合法的最小 `bot.json` 文本。
 * @param token Telegram Bot Token 字符串。
 * @returns 格式化后的 JSON 文本（含末尾换行）。
 */
export function validTelegram(token: string = "123456789:existing_test_token"): string {
  return JSON.stringify({
    bot_token: token,
    super_admin_user_id: 123456789,
  }, null, 2) + "\n";
}

/**
 * 生成拒绝覆盖现有 systemd unit 的可选交互应答项。
 * @returns 针对 `覆盖它？` 提示词回答 `n` 的可选应答配置。
 */
export function systemdPrompt(): PromptReply {
  return { prompt: "覆盖它？", reply: "n", optional: true };
}

/**
 * 递归删除当前进程已创建的全部安装器隔离测试夹具临时目录。
 */
export function cleanupFixtures(): void {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}
