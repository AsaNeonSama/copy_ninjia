/** 全量基准分区共用的隔离数据根、播种与子进程按轮编排。 */

import { join } from "node:path";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../../../packages/consts/environment";
import { spawnJsonChild } from "./child";
import {
  PROJECT_ROOT,
  createRuntimeRoot,
  removeMockPath,
} from "./mockRoot";
import { measureDirectoryFootprint } from "./processIo";
import type { SpawnChildOptions } from "./child";
import type { DirectoryFootprint } from "./processIo";
import type { ProcessIoDelta } from "./types";

export interface SectionContext {
  readonly runRoot: string;
  readonly configRoot: string;
  readonly rounds: number;
  readonly onProgress: (message: string) => void;
  readonly recordIo: (io: ProcessIoDelta) => void;
  readonly recordOperations: (operations: number) => void;
  readonly recordFootprint: (footprint: DirectoryFootprint) => void;
  readonly dependencies?: SectionDependencies;
}

/** 父进程的全部外部动作；测试用可控实现验证聚合与失败清理。 */
export interface SectionDependencies {
  readonly spawnJsonChild: <TResult>(options: SpawnChildOptions) => Promise<TResult>;
  readonly createRuntimeRoot: (runRoot: string) => string;
  readonly measureDirectoryFootprint: (runtimeRoot: string) => DirectoryFootprint;
  readonly removeMockPath: (runtimeRoot: string) => void;
}

/** 按轮运行被测子进程的编排参数。 */
export interface RoundsOptions {
  /** 进度日志与报错信息中标识当前测量项的标签。 */
  readonly label: string;
  /** 每轮运行前对隔离数据根执行的播种模式。 */
  readonly seedMode: "cold-start" | "chain" | "none";
  /** 传给测量子进程的命令行参数表。 */
  readonly args: readonly string[];
  /** 追加到测量子进程的环境变量；各根目录变量始终以本轮隔离根为准。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 每轮测量子进程成功后收到其 stderr，按轮次顺序调用；播种子进程不经过它。 */
  readonly onStderr?: (stderr: string) => void;
}

const DEFAULT_SECTION_DEPENDENCIES: SectionDependencies = {
  spawnJsonChild,
  createRuntimeRoot,
  measureDirectoryFootprint,
  removeMockPath,
};

export const FULL_SUITE_ENTRY: string = join(
  PROJECT_ROOT,
  "scripts",
  "perf",
  "fullSuite.ts"
);
export const HOT_PATH_ENTRY: string = join(
  PROJECT_ROOT,
  "scripts",
  "perf",
  "hotPaths.ts"
);
export const JOIN_LOG_ENTRY: string = join(
  PROJECT_ROOT,
  "scripts",
  "perf",
  "joinLog.ts"
);

/**
 * 构造指向本轮隔离运行时数据根与配置根的环境变量表。
 * @param runtimeRoot 本轮独占的运行时数据根路径。
 * @param configRoot 本次运行共享的隔离配置根路径。
 * @returns 包含数据根与配置根环境变量的映射表。
 */
function childEnv(
  runtimeRoot: string,
  configRoot: string
): Readonly<Record<string, string>> {
  return {
    [RUNTIME_DATA_ROOT_ENV]: runtimeRoot,
    [CONFIG_ROOT_ENV]: configRoot,
  };
}

/**
 * 拒绝把不同 Bun/JSC 构建的轮次聚合成一份报告。
 * @param version 子进程报告的 Bun 版本号。
 * @param revision 子进程报告的 Bun 构建修订号。
 * @param label 当前测量项标签。
 */
export function assertSameRuntime(
  version: string,
  revision: string,
  label: string
): void {
  if (version !== Bun.version || revision !== Bun.revision) {
    throw new Error(
      `${label}: child ran Bun ${version} (${revision}), parent runs ` +
      `${Bun.version} (${Bun.revision}).`
    );
  }
}

/** 启动播种子进程初始化单轮运行时数据根的参数。 */
interface SeedRuntimeRootOptions {
  /** 分区外部动作依赖集合。 */
  readonly dependencies: SectionDependencies;
  /** 本轮独占的运行时数据根路径。 */
  readonly runtimeRoot: string;
  /** 本次运行共享的隔离配置根路径。 */
  readonly configRoot: string;
  /** 播种模式（满库冷启动或空库链路）。 */
  readonly mode: "cold-start" | "chain";
  /** 当前测量项标签。 */
  readonly label: string;
}

/**
 * 启动播种子进程将本轮运行时数据根初始化为指定模式的生产格式。
 * @param options 依赖集合、数据根路径、配置根路径、播种模式与诊断标签。
 */
async function seedRuntimeRoot({
  dependencies,
  runtimeRoot,
  configRoot,
  mode,
  label,
}: SeedRuntimeRootOptions): Promise<void> {
  await dependencies.spawnJsonChild<unknown>({
    args: [FULL_SUITE_ENTRY, "--child", "seed", mode],
    env: childEnv(runtimeRoot, configRoot),
    label: `${label} fixture`,
  });
}

/**
 * 每轮使用新数据根，记录删除前足迹，并在成功或失败后统一清理。
 * @param context 分区运行上下文。
 * @param options 测量项标签、播种模式、子进程参数与环境变量选项。
 * @returns 各轮子进程返回的读数列表。
 */
export async function runRounds<TRound>(
  context: SectionContext,
  { label, seedMode, args, env = {}, onStderr }: RoundsOptions
): Promise<readonly TRound[]> {
  const rounds: TRound[] = [];
  const dependencies: SectionDependencies =
    context.dependencies ?? DEFAULT_SECTION_DEPENDENCIES;
  for (let round: number = 0; round < context.rounds; round += 1) {
    const runtimeRoot: string = dependencies.createRuntimeRoot(context.runRoot);
    try {
      if (seedMode !== "none") {
        await seedRuntimeRoot({
          dependencies,
          runtimeRoot,
          configRoot: context.configRoot,
          mode: seedMode,
          label,
        });
      }
      context.onProgress(`${label} ${round + 1}/${context.rounds}`);
      rounds.push(await dependencies.spawnJsonChild<TRound>({
        args,
        env: { ...env, ...childEnv(runtimeRoot, context.configRoot) },
        label,
        onStderr,
      }));
    } finally {
      try {
        context.recordFootprint(dependencies.measureDirectoryFootprint(runtimeRoot));
      } finally {
        dependencies.removeMockPath(runtimeRoot);
      }
    }
  }
  return rounds;
}
