/**
 * `bun run perf:hot-paths -- <场景> [--profile]` 入口：建立 `performance/` 下的隔离数据根与配置副本，
 * 按 `HOT_PATH_PROFILE_REPEATS` 轮各起一个独立进程运行 hotPaths.ts，每轮结束删除该轮数据根，
 * 全部结束后删除整次隔离根。
 */

import { join } from "node:path";
import { HOT_PATH_PROFILE_REPEATS } from "../../packages/consts/performance";
import {
  createHotPathGateFixture,
  createHotPathGateRuntimeRoot,
  hotPathGateChildEnvironment,
  removeHotPathGateFixture,
} from "./hotPaths/gateFixture";
import type { HotPathGateFixture } from "./hotPaths/gateFixture";
import { removeMockPath } from "./fullSuite/mockRoot";

const fixture: HotPathGateFixture = await createHotPathGateFixture();
try {
  for (let round: number = 0; round < HOT_PATH_PROFILE_REPEATS; round++) {
    const runtimeRoot: string = createHotPathGateRuntimeRoot(fixture);
    try {
      const child: Bun.Subprocess<"ignore", "inherit", "inherit"> = Bun.spawn(
        [Bun.argv[0]!, join(import.meta.dir, "hotPaths.ts"), ...Bun.argv.slice(2)],
        {
          env: hotPathGateChildEnvironment(fixture, runtimeRoot),
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }
      );
      const code: number = await child.exited;
      if (code !== 0) throw new Error(`Hot-path measurement round ${round + 1} exited with ${code}.`);
    } finally {
      removeMockPath(runtimeRoot);
    }
  }
} finally {
  removeHotPathGateFixture(fixture);
}
