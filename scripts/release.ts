/** 发布 CLI：构建与验证不访问线上部署；publish 只操作已推送 tag 的 GitHub Release。 */
import { join, resolve } from "node:path";
import { checked, createReleaseCommand, readBuildSourceTree } from "./release/command";
import type { ReleaseCommand } from "./release/command";
import { verifyReleaseAssets } from "./release/assets";
import { RELEASE_VERSION_PATTERN } from "../packages/consts/release";
import type { ReleaseAsset } from "./release/assets";
import { publishRelease } from "./release/github";

/** `runReleaseCli` 的命令行输入与外部依赖注入选项。 */
export interface ReleaseCliOptions {
  /** CLI 参数列表（不含可执行路径与脚本路径，默认读取 `Bun.argv.slice(2)`）。 */
  readonly args?: readonly string[];
  /** 仓库根目录绝对路径（默认当前仓库根）。 */
  readonly projectRoot?: string;
  /** 构造发布命令执行器的工厂函数。 */
  readonly createCommand?: (projectRoot: string) => ReleaseCommand;
  /** 读取当前已提交构建树哈希的函数（脏工作区返回 `null`）。 */
  readonly readSourceTree?: (command: ReleaseCommand) => string | null;
  /** 核对发行包产物与校验和的函数。 */
  readonly verifyAssets?: typeof verifyReleaseAssets;
  /** 创建或核对 GitHub Release 的函数。 */
  readonly publish?: typeof publishRelease;
  /** 输出标准文本行的方法（默认 `console.log`）。 */
  readonly log?: (message: string) => void;
}

/**
 * 解析发布子命令参数并执行 check / build / verify / publish 流程。
 *
 * @param params 命令行参数与可注入依赖配置
 */
export async function runReleaseCli({
  args = Bun.argv.slice(2),
  projectRoot = join(import.meta.dir, ".."),
  createCommand = createReleaseCommand,
  readSourceTree = readBuildSourceTree,
  verifyAssets = verifyReleaseAssets,
  publish = publishRelease,
  log = console.log,
}: ReleaseCliOptions = {}): Promise<void> {
  const arguments_: readonly string[] = args.filter((argument: string): boolean => argument !== "--");
  const action: string | undefined = arguments_[0];
  if (arguments_.includes("--help")) {
    log("Usage: bun run release:check -- --version MAJOR.MINOR.PATCH\n" +
      "       bun run release:build -- --version MAJOR.MINOR.PATCH\n" +
      "       bun run release:verify -- --version MAJOR.MINOR.PATCH --platforms linux-x64[,linux-arm64,...] [--directory dist]\n" +
      "       bun run release:publish -- --version MAJOR.MINOR.PATCH --platforms linux-x64[,linux-arm64,...] --notes-file PATH [--directory dist]");
    return;
  }
  if (action !== "check" && action !== "build" && action !== "verify" && action !== "publish") {
    throw new Error("Expected check, build, verify or publish; use --help.");
  }
  const options: Map<string, string> = new Map<string, string>();
  const allowed: readonly string[] = action === "check" || action === "build" ? ["--version"]
    : action === "verify" ? ["--version", "--platforms", "--directory"] : ["--version", "--platforms", "--directory", "--notes-file"];
  for (let index: number = 1; index < arguments_.length; index += 2) {
    const name: string = arguments_[index]!;
    const value: string | undefined = arguments_[index + 1];
    if (!allowed.includes(name) || options.has(name) || value === undefined || value.startsWith("--")) {
      throw new Error("Invalid or repeated release option; use --help.");
    }
    options.set(name, value);
  }
  const version: string = options.get("--version") ?? "";
  if (!RELEASE_VERSION_PATTERN.test(version)) throw new Error("--version must be MAJOR.MINOR.PATCH without a v prefix.");
  const command: ReleaseCommand = createCommand(projectRoot);
  if (action === "check") {
    log(checked(command, [Bun.argv[0]!, "install", "--frozen-lockfile"]));
    for (const script of ["check", "check:coverage", "test:fault-injection"]) {
      log(checked(command, [Bun.argv[0]!, "run", script]));
    }
    log(checked(command, [Bun.argv[0]!, join(projectRoot, "scripts/build.ts"), "--version", version]));
    return;
  }
  const sourceTree: string | null = readSourceTree(command);
  if (sourceTree === null) throw new Error("Release commands require a clean, committed Git worktree.");
  if (action === "build") {
    if (checked(command, ["git", "branch", "--show-current"]) !== "dev") throw new Error("Release builds must run on dev.");
    log(checked(command, [Bun.argv[0]!, join(projectRoot, "scripts/build.ts"), "--version", version]));
    return;
  }
  const platforms: readonly string[] = (options.get("--platforms") ?? "").split(",");
  const assets: readonly ReleaseAsset[] = await verifyAssets({
    directory: resolve(projectRoot, options.get("--directory") ?? "dist"), version, platforms, sourceTree, command,
  });
  if (action === "verify") {
    log(`Verified ${assets.length} release assets for ${version} (${sourceTree}).`);
    return;
  }
  const notes: string | undefined = options.get("--notes-file");
  if (notes === undefined) throw new Error("publish requires --notes-file.");
  const url: string = await publish({ version, notesPath: resolve(projectRoot, notes), assets, command });
  log(`Release and downloaded assets confirmed: ${url}\nCheck git diff dev master --quiet before aligning dev.`);
}

if (import.meta.main) {
  await runReleaseCli();
}
