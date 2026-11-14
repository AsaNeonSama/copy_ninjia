/**
 * `bun run test:fault-injection` 入口：在仓库根以 FAULT_INJECTION_TESTS 为清单执行 `bun test --isolate`，
 * 命令行额外参数排在清单之前原样透传，退出码取子进程的退出码。
 */
import { FAULT_INJECTION_TESTS } from "./conventions/faultInjectionSuite";

/**
 * 组装故障注入测试子进程命令参数，确保 `--isolate` 与额外参数排在测试清单之前。
 *
 * @param extraArgs 透传给 `bun test` 的命令行额外参数
 * @returns 完整子进程命令行参数数组
 */
export function buildFaultInjectionCommand(extraArgs: readonly string[] = []): string[] {
  return [Bun.argv[0]!, "test", "--isolate", ...extraArgs, ...FAULT_INJECTION_TESTS];
}

/**
 * 启动隔离模式下的故障注入测试子进程并返回其退出码。
 *
 * @param extraArgs 透传给 `bun test` 的命令行额外参数
 * @returns 子进程退出码
 */
export async function runFaultInjectionSuite(
  extraArgs: readonly string[] = Bun.argv.slice(2)
): Promise<number> {
  const child: Bun.Subprocess<"inherit", "inherit", "inherit"> = Bun.spawn(
    buildFaultInjectionCommand(extraArgs),
    { cwd: `${import.meta.dir}/..`, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  );
  return await child.exited;
}

if (import.meta.main) {
  process.exitCode = await runFaultInjectionSuite();
}
