/**
 * `bun run test:fault-injection` 入口：在仓库根以 FAULT_INJECTION_TESTS 为清单执行 `bun test --isolate`，
 * 命令行额外参数排在清单之前原样透传，退出码取子进程的退出码。
 */
import { FAULT_INJECTION_TESTS } from "./conventions/faultInjectionSuite";

const child: Bun.Subprocess<"inherit", "inherit", "inherit"> = Bun.spawn(
  [Bun.argv[0]!, "test", "--isolate", ...Bun.argv.slice(2), ...FAULT_INJECTION_TESTS],
  { cwd: `${import.meta.dir}/..`, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
);
process.exitCode = await child.exited;
