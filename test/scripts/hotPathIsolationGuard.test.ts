/**
 * 热路径测量入口的隔离闸：数据根不是 performance/ 下的运行时根时，hotPaths.ts 在加载任何场景模块之前
 * 退出，报错点名两个根目录环境变量与受支持的入口。
 */

import { expect, test } from "bun:test";
import { CONFIG_ROOT_ENV, RUNTIME_DATA_ROOT_ENV } from "../../packages/consts/environment";

test("隔离根之外直接运行 hotPaths.ts 时拒绝，且不加载场景模块", async (): Promise<void> => {
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [Bun.argv[0]!, `${import.meta.dir}/../../scripts/perf/hotPaths.ts`, "cooldown-hit"],
    { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const stdoutPromise: Promise<string> = child.stdout.text();
  const stderrPromise: Promise<string> = child.stderr.text();
  expect(await child.exited).not.toBe(0);
  const stderr: string = await stderrPromise;
  expect(await stdoutPromise).toBe("");
  expect(stderr).toContain(RUNTIME_DATA_ROOT_ENV);
  expect(stderr).toContain(CONFIG_ROOT_ENV);
  expect(stderr).toContain("bun run perf:hot-paths");
});
