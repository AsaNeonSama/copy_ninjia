import { join } from "node:path";
import { readInstallScripts } from "./installSources";

/**
 * 对指定仓库根目录下的安装脚本入口与各 shell 模块执行 `bash -n` 语法检查。
 *
 * @param projectRoot 仓库根目录绝对路径
 * @returns 全部通过返回 0，任一脚本语法检查失败返回 1
 */
export async function checkInstallScriptSyntax(
  projectRoot: string = join(import.meta.dir, "..")
): Promise<number> {
  for (const script of await readInstallScripts(projectRoot)) {
    const result: Bun.SyncSubprocess<"inherit", "inherit"> = Bun.spawnSync({
      cmd: ["bash", "-n", script.path],
      cwd: projectRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      return 1;
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await checkInstallScriptSyntax();
}
