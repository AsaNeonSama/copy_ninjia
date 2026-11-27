/** 发布子命令只由显式 CLI 调用；测试注入替身，不访问 GitHub 或修改分支。 */
import { decodeUtf8 } from "../utf8";
import {
  RELEASE_BUNDLED_PATHS,
  RELEASE_INSTALL_SCRIPT_GLOB,
} from "../../packages/consts/release";

/** 外部发布命令同步执行后的退出码与标准输出。 */
export interface CommandResult {
  /** 子进程退出码，被信号终止时为 null。 */
  readonly exitCode: number | null;
  /** 子进程标准输出解码后的 UTF-8 文本。 */
  readonly stdout: string;
}

/** 接收参数数组并同步返回退出码与标准输出的外部命令执行函数。 */
export type ReleaseCommand = (arguments_: readonly string[]) => CommandResult;

/**
 * 固定工作目录，参数按 argv 传递，不经过 shell 展开。
 * @param cwd 子进程工作目录。
 * @returns 绑定了工作目录的同步命令执行器。
 */
export function createReleaseCommand(cwd: string): ReleaseCommand {
  return (arguments_: readonly string[]): CommandResult => {
    const result: Bun.SyncSubprocess<"pipe", "inherit"> = Bun.spawnSync({
      cmd: [...arguments_], cwd, stdout: "pipe", stderr: "inherit",
    });
    return { exitCode: result.exitCode, stdout: decodeUtf8(result.stdout) };
  };
}

/**
 * 同步执行外部发布命令：退出码非 0 时立即抛错，退出码为 0 时返回去除首尾空白的标准输出。
 * @param command 外部命令执行器。
 * @param arguments_ 命令行参数数组。
 * @returns 退出码为 0 时去除首尾空白的标准输出。
 */
export function checked(command: ReleaseCommand, arguments_: readonly string[]): string {
  const result: CommandResult = command(arguments_);
  if (result.exitCode !== 0) throw new Error(`Release command failed: ${arguments_.slice(0, 3).join(" ")}`);
  return result.stdout.trim();
}

/** 查询发行包白名单受跟踪源码文件的 `git ls-files` 固定参数列表。 */
const TRACKED_BUNDLED_SOURCE_FILES_ARGS: readonly string[] = [
  "git",
  "ls-files",
  "-z",
  "--",
  ...RELEASE_BUNDLED_PATHS,
  `:(glob)${RELEASE_INSTALL_SCRIPT_GLOB}`,
];

/**
 * 将 `git ls-files -z` 输出的空字符分隔路径流解析为非空相对路径列表。
 * @param stdout `git ls-files -z` 的标准输出文本。
 * @returns 非空相对路径只读数组。
 */
function parseNullDelimitedPaths(stdout: string): readonly string[] {
  return stdout
    .split("\0")
    .filter((entry: string): boolean => entry.length > 0);
}

/**
 * 尝试列出 Git 索引中属于发行包白名单（`RELEASE_BUNDLED_PATHS` 与 `RELEASE_INSTALL_SCRIPT_GLOB`）的受跟踪相对文件路径；
 * 当工作目录不在对应 Git 仓库内、命令返回非零退出码或索引中无匹配文件时返回 `null`。
 * @param command 外部命令执行器。
 * @returns 非空受跟踪相对路径列表；非对应 Git 工作树或查询失败时返回 `null`。
 */
export function tryListTrackedBundledSourceFiles(
  command: ReleaseCommand
): readonly string[] | null {
  const result: CommandResult = command(TRACKED_BUNDLED_SOURCE_FILES_ARGS);
  if (result.exitCode !== 0) return null;
  const files: readonly string[] = parseNullDelimitedPaths(result.stdout);
  return files.length > 0 ? files : null;
}

/**
 * 严格列出 Git 索引中属于发行包白名单（`RELEASE_BUNDLED_PATHS` 与 `RELEASE_INSTALL_SCRIPT_GLOB`）的受跟踪相对文件路径；
 * 命令失败或索引中无匹配文件时立即抛错，供发行构建与资产校验共用单一来源。
 * @param command 外部命令执行器。
 * @returns 非空受跟踪相对路径列表。
 */
export function listTrackedBundledSourceFiles(
  command: ReleaseCommand
): readonly string[] {
  const files: readonly string[] = parseNullDelimitedPaths(
    checked(command, TRACKED_BUNDLED_SOURCE_FILES_ARGS)
  );
  if (files.length === 0) {
    throw new Error("No tracked bundled source files found in Git index.");
  }
  return files;
}

/**
 * 只为干净 Git 工作树记录谱系；本地开发包和无 Git 源码包不具备发布谱系。
 * @param command 外部命令执行器。
 * @returns 工作树干净时返回 HEAD tree 的 40 位十六进制哈希，否则返回 null。
 */
export function readBuildSourceTree(command: ReleaseCommand): string | null {
  const status: CommandResult = command(["git", "status", "--porcelain", "--untracked-files=all"]);
  if (status.exitCode !== 0 || status.stdout.trim() !== "") return null;
  const tree: CommandResult = command(["git", "rev-parse", "HEAD^{tree}"]);
  return tree.exitCode === 0 && /^[a-f0-9]{40}$/.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
}

/**
 * 发布前后都核对 master、annotated tag 及其远端对象；本函数不创建或推送引用。
 * @param command 外部命令执行器。
 * @param version 待核对的发布版本号。
 */
export function verifyReleaseReferences(command: ReleaseCommand, version: string): void {
  if (checked(command, ["git", "branch", "--show-current"]) !== "master") throw new Error("Publish requires master.");
  const origin: string = checked(command, ["git", "remote", "get-url", "origin"]);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)AsaNeonSama\/copy_ninjia(?:\.git)?$/.test(origin)) {
    throw new Error("origin must be AsaNeonSama/copy_ninjia on github.com.");
  }
  const head: string = checked(command, ["git", "rev-parse", "HEAD"]);
  const tag: string = `refs/tags/${version}`;
  if (checked(command, ["git", "cat-file", "-t", tag]) !== "tag" ||
    checked(command, ["git", "rev-parse", `${tag}^{commit}`]) !== head) {
    throw new Error("The annotated release tag must point to master HEAD.");
  }
  const tagObject: string = checked(command, ["git", "rev-parse", tag]);
  const remote: string = checked(command, ["git", "ls-remote", "origin", "refs/heads/master", tag, `${tag}^{}`]);
  const references: Map<string, string> = new Map(remote.split("\n").map((line: string): [string, string] => {
    const fields: string[] = line.split(/\s+/);
    return [fields[1] ?? "", fields[0] ?? ""];
  }));
  if (references.get("refs/heads/master") !== head || references.get(tag) !== tagObject || references.get(`${tag}^{}`) !== head) {
    throw new Error("Push master and its annotated tag separately before publishing; remote references must match.");
  }
}
