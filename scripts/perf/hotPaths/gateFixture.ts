/** 热路径门禁子进程的隔离配置与运行时数据根。 */

import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../../../packages/consts/environment";
import {
  createBenchmarkConfigRoot,
  createRunRoot,
  createRuntimeRoot,
  removeMockPath,
} from "../fullSuite/mockRoot";
import { perfChildEnvironment } from "../childEnvironment";

/** 一次热路径门禁共用的运行目录与严格配置副本。 */
export interface HotPathGateFixture {
  readonly runRoot: string;
  readonly configRoot: string;
}

/**
 * 建立门禁级隔离根；配置复制失败时同步清理已经创建的 run-*。
 *
 * @returns 包含运行目录与配置副本路径的夹具
 */
export async function createHotPathGateFixture(): Promise<HotPathGateFixture> {
  const runRoot: string = createRunRoot();
  try {
    return {
      runRoot,
      configRoot: await createBenchmarkConfigRoot(runRoot),
    };
  } catch (error: unknown) {
    removeMockPath(runRoot);
    throw error;
  }
}

/**
 * 为一个 profile 或 retained 子进程建立独占运行时数据根。
 *
 * @param fixture 热路径门禁隔离夹具
 * @returns 新建的运行时数据根目录路径
 */
export function createHotPathGateRuntimeRoot(
  fixture: HotPathGateFixture
): string {
  return createRuntimeRoot(fixture.runRoot);
}

/**
 * 子进程只读取隔离配置和数据根，其余环境按 `perfChildEnvironment` 继承父进程。
 *
 * @param fixture 热路径门禁隔离夹具
 * @param runtimeRoot 子进程独占的运行时数据根路径
 * @returns 传给子进程的环境变量只读字典
 */
export function hotPathGateChildEnvironment(
  fixture: HotPathGateFixture,
  runtimeRoot: string
): Readonly<Record<string, string | undefined>> {
  return perfChildEnvironment({
    [CONFIG_ROOT_ENV]: fixture.configRoot,
    [RUNTIME_DATA_ROOT_ENV]: runtimeRoot,
  });
}

/**
 * 清理整次门禁根及其中的严格配置副本。
 *
 * @param fixture 待清理的热路径门禁隔离夹具
 */
export function removeHotPathGateFixture(fixture: HotPathGateFixture): void {
  removeMockPath(fixture.runRoot);
}
