/**
 * 热路径测量子进程的隔离闸。hotPaths.ts 把它作为第一条 import，先于场景模块求值：
 * 运行时数据根必须是 `performance/` 下本轮独占的运行时根，配置根必须位于 `performance/` 之内；
 * 不满足时抛错退出，场景模块不会加载、不会读取部署配置。
 *
 * 合法的启动方是 `bun run perf:hot-paths`（isolatedHotPath.ts）、热路径门禁、全量基准与专项复核，
 * 它们都经 fullSuite/mockRoot.ts 建根并设置这两个环境变量。
 */

import { CONFIG_ROOT_ENV, RUNTIME_DATA_ROOT_ENV } from "../../../packages/consts/environment";
import { isBenchmarkRuntimeRoot, isInsidePerformanceMockRoot } from "../fullSuite/mockRoot";

const runtimeRoot: string | undefined = process.env[RUNTIME_DATA_ROOT_ENV];
const configRoot: string | undefined = process.env[CONFIG_ROOT_ENV];
if (
  runtimeRoot === undefined ||
  !isBenchmarkRuntimeRoot(runtimeRoot) ||
  configRoot === undefined ||
  !isInsidePerformanceMockRoot(configRoot)
) {
  throw new Error(
    `scripts/perf/hotPaths.ts requires ${RUNTIME_DATA_ROOT_ENV} and ${CONFIG_ROOT_ENV} inside performance/; ` +
    "run it through bun run perf:hot-paths."
  );
}
