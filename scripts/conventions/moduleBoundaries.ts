import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { MINI_APP_FRONTEND_CONSTS_ROOT } from "./miniAppFrontend";
import { runtimeModuleReferences } from "./sourceAnalysis";
import { globalPropertyName } from "./staticAccess";

/**
 * 逐文件判定几条「谁能依赖谁」的硬边界：读取环境变量的唯一入口、
 * 常量目录与 `packages/states/` 的纯度、`infra` 不得向上依赖业务层，以及全量基准父进程与
 * 非夹具模块的 import 约束。`states/` 纯度与 `infra` 依赖方向见 docs/cn/04-invariants.md；判定细节以本文件
 * 各规则的常量与 JSDoc 为准。
 *
 * 各条规则都只看 AST，判定这一个文件写了什么 import；`states/` 纯度另按调用方给出的
 * 运行时模块闭包判定间接依赖。
 */

/** 逐文件边界规则的公共入参。 */
export interface ModuleBoundaryParams {
  /** 仓库根目录绝对路径。 */
  readonly projectRoot: string;
  /** 被检查文件的绝对路径。 */
  readonly path: string;
  /** 该文件唯一一次解析得到的 AST。 */
  readonly source: ts.SourceFile;
}

/**
 * 节点所在行号（1 起）。
 *
 * @param source 源文件 AST
 * @param position 字符偏移位置
 * @returns 1-based 行号
 */
function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

/** 允许读取 `process.env` / `Bun.env` 的边界文件，相对仓库根。 */
const ENVIRONMENT_BOUNDARY_FILES: readonly string[] = [
  "packages/consts/paths.ts",
  "packages/consts/environment.ts",
];

/**
 * `process.env` 与 `Bun.env` 的读取边界。
 *
 * 环境变量名集中在 consts/environment.ts，env 派生配置集中在 consts/paths.ts；
 * packages/ 与 index.ts 的其余文件读取即报错，scripts/ 与 test/ 不在判定范围内。
 * `Bun.env` 与 `process.env` 指向同一份环境，属性访问与具名直接解构
 * 使用相同的静态识别，类型位置不参与。
 *
 * @param params 逐文件模块边界检查入参
 * @returns 越界读取环境变量的问题列表
 */
export function collectEnvironmentAccessProblems({
  projectRoot,
  path,
  source,
}: ModuleBoundaryParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  if (ENVIRONMENT_BOUNDARY_FILES.includes(relativePath)) return [];
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    const ownerName: string | undefined = globalPropertyName(node, "process") === "env"
      ? "process"
      : globalPropertyName(node, "Bun") === "env" ? "Bun" : undefined;
    if (ownerName !== undefined) {
      problems.push(
        `${relativePath}:${lineOf(source, node.getStart(source))} reads ${ownerName}.env; ` +
        `only ${ENVIRONMENT_BOUNDARY_FILES.join(" and ")} may read the environment`
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/**
 * 常量目录（相对仓库根，带结尾斜杠）：`packages/consts/` 与 Mini App 前端自己的
 * `packages/mini-app-frontend/consts/`，后者见 scripts/conventions/miniAppFrontend.ts。
 */
export const CONSTS_ROOT_PREFIXES: readonly string[] = [
  "packages/consts/",
  MINI_APP_FRONTEND_CONSTS_ROOT,
];

/**
 * 常量目录运行期只依赖本目录：`packages/consts/` 对其余 `packages/` 模块只能 `import type`，npm 包与
 * `node:` 内置模块不在此列。全量基准 import 边界与 `states/` 纯度规则放行的 consts，因此不会间接带入
 * 其它 `packages/` 实现模块。前端常量目录同样只依赖自身，类型引用另受前端目录边界约束。
 *
 * @param params 逐文件模块边界检查入参
 * @returns 常量目录越界运行期依赖的问题列表
 */
export function collectConstsPurityProblems({
  projectRoot,
  path,
  source,
}: ModuleBoundaryParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  const ownRoot: string | undefined = CONSTS_ROOT_PREFIXES.find(
    (prefix: string): boolean => relativePath.startsWith(prefix)
  );
  if (ownRoot === undefined) return [];
  const problems: string[] = [];
  for (const reference of runtimeModuleReferences(source)) {
    if (!reference.specifier.startsWith(".")) continue;
    const target: string = relative(projectRoot, resolve(dirname(path), reference.specifier));
    if (target.startsWith(ownRoot)) continue;
    problems.push(
      `${relativePath}:${lineOf(source, reference.start)} imports ${target} at runtime; ` +
      `${ownRoot} may only depend on other consts modules in ${ownRoot} at runtime — use import type for anything else`
    );
  }
  return problems;
}

/**
 * `packages/states/` 只允许依赖纯模块。
 *
 * 状态机是「给定状态与事件算出 `{ next, effects }`」的纯函数。types 与 consts 是纯声明，
 * libs 是无副作用的工具，其余一律拒绝；libs 再往外引入的模块同样计入。
 */
const STATES_ALLOWED_PREFIXES: readonly string[] = [
  "packages/consts/",
  "packages/libs/",
  "packages/states/",
  "packages/types/",
];

/**
 * states 间接依赖里允许出现、但不再展开的模块，相对仓库根。
 *
 * 唯一条目：`packages/config/time.ts`，本线程的启动时区快照。libs/time.ts 的按日运算经它
 * 取时区；时区在线程启动时由 adoptTimeZone 接管一次，日历运算只在其上缓存 UTC 偏移区段，
 * 同一线程内结果只取决于入参。它背后的 holder（cache/perThread/time.ts）与配置路径不再计入。
 * 新增条目必须同时改这里与被豁免模块的头注。
 */
export const STATES_CLOSURE_OPAQUE_MODULES: readonly string[] = [
  "packages/config/time.ts",
];

/**
 * 判断相对路径是否属于 `packages/states/` 允许依赖的纯模块前缀。
 *
 * @param target 相对仓库根的目标模块路径
 * @returns 属于允许前缀时返回 true
 */
function isStatesDependencyAllowed(target: string): boolean {
  return STATES_ALLOWED_PREFIXES.some((prefix: string): boolean => target.startsWith(prefix));
}

/** collectStatesPurityProblems 的入参。 */
export interface StatesPurityParams extends ModuleBoundaryParams {
  /**
   * 该模块的运行时模块闭包与最短引入路径：ModuleGraphReader.boundedModuleClosure，以
   * STATES_CLOSURE_OPAQUE_MODULES 的绝对路径为不透明模块。
   */
  readonly closure: ReadonlyMap<string, readonly string[]>;
}

/**
 * 直接 import 按 AST 逐条判定（含解析不到 .ts 的相对路径），只放行 STATES_ALLOWED_PREFIXES；
 * 经直接依赖再往外引入的模块按闭包判定，另放行 STATES_CLOSURE_OPAQUE_MODULES。
 *
 * @param params 状态机模块纯度检查入参
 * @returns `packages/states/` 直接或间接越界依赖的问题列表
 */
export function collectStatesPurityProblems({
  projectRoot,
  path,
  source,
  closure,
}: StatesPurityParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  const problems: string[] = [];
  for (const reference of runtimeModuleReferences(source)) {
    if (!reference.specifier.startsWith(".")) continue;
    const target: string = relative(projectRoot, resolve(dirname(path), reference.specifier));
    if (isStatesDependencyAllowed(target)) continue;
    problems.push(
      `${relativePath}:${lineOf(source, reference.start)} imports ${target} at runtime; ` +
      "packages/states/ may only depend on consts, libs, types and other states modules"
    );
  }
  for (const [module, trail] of closure) {
    // 入口自身与直接依赖（引入路径不超过两步）已由上面的逐条判定覆盖。
    if (trail.length <= 2) continue;
    const target: string = relative(projectRoot, module);
    if (isStatesDependencyAllowed(target) || STATES_CLOSURE_OPAQUE_MODULES.includes(target)) continue;
    problems.push(
      `${relativePath} reaches ${target} at runtime (` +
      trail.map((step: string): string => relative(projectRoot, step)).join(" -> ") +
      "); packages/states/ may only depend on consts, libs, types and other states modules"
    );
  }
  return problems;
}

/**
 * `packages/infra/` 不得静态依赖业务层。
 *
 * infra 是命令、AI 与 Anti-Raid 共同依赖的底座；需要业务能力时由上层在组合点注入
 * （见 docs/cn/04-invariants.md 的 chat runtime teardown 一节）。
 */
const INFRA_FORBIDDEN_PREFIXES: readonly string[] = [
  "packages/aiChat/",
  "packages/antiRaid/",
  "packages/app/",
  "packages/auto/",
  "packages/commands/",
  "packages/copy/",
  "packages/cron/",
  "packages/translate/",
  "packages/workers/",
];

/**
 * 唯一豁免：`packages/workers/diskIO/diagnosticSink.ts`。
 *
 * 它是没有任何依赖的叶子，只包一层 `console.error`；主线程的 Disk I/O 宿主经它输出
 * 诊断而不经 logger。新增豁免必须同时改这里与被豁免模块的头注。
 */
const INFRA_LAYERING_EXEMPTIONS: readonly string[] = [
  "packages/workers/diskIO/diagnosticSink.ts",
];

/**
 * 核对 `packages/infra/` 模块未在运行期静态依赖业务层模块。
 *
 * @param params 逐文件模块边界检查入参
 * @returns `packages/infra/` 反向依赖业务层的问题列表
 */
export function collectInfraLayeringProblems({
  projectRoot,
  path,
  source,
}: ModuleBoundaryParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  const problems: string[] = [];
  for (const reference of runtimeModuleReferences(source)) {
    if (!reference.specifier.startsWith(".")) continue;
    const target: string = relative(projectRoot, resolve(dirname(path), reference.specifier));
    const forbidden: string | undefined = INFRA_FORBIDDEN_PREFIXES.find(
      (prefix: string): boolean => target.startsWith(prefix)
    );
    if (forbidden === undefined) continue;
    if (INFRA_LAYERING_EXEMPTIONS.includes(`${target}.ts`)) continue;
    problems.push(
      `${relativePath}:${lineOf(source, reference.start)} imports ${target} at runtime; ` +
      "packages/infra/ must not statically depend on business modules — inject the dependency instead"
    );
  }
  return problems;
}

/**
 * 全量基准的 import 边界。
 *
 * 父进程与非夹具模块只能 import `packages/consts/` 的常量与 `import type`；
 * `FULL_SUITE_FIXTURE_FILES` 列出的夹具模块在子进程里搭真实环境，调用生产入口，不受此限。
 */
const FULL_SUITE_FIXTURE_FILES: readonly string[] = [
  "scripts/perf/fullSuite/chain.ts",
  "scripts/perf/fullSuite/coldStart.ts",
  "scripts/perf/fullSuite/fixture.ts",
  "scripts/perf/fullSuite/seed.ts",
  "scripts/perf/fullSuite/storage.ts",
];

/**
 * 核对全量基准父进程与非夹具模块只运行期导入 `packages/consts/`。
 *
 * @param params 逐文件模块边界检查入参
 * @returns 全量基准越界导入实现模块的问题列表
 */
export function collectFullSuiteImportProblems({
  projectRoot,
  path,
  source,
}: ModuleBoundaryParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  const inScope: boolean = relativePath === "scripts/perf/fullSuite.ts" ||
    relativePath.startsWith("scripts/perf/fullSuite/");
  if (!inScope || FULL_SUITE_FIXTURE_FILES.includes(relativePath)) return [];
  const problems: string[] = [];
  for (const reference of runtimeModuleReferences(source)) {
    if (!reference.specifier.startsWith(".")) continue;
    const target: string = relative(projectRoot, resolve(dirname(path), reference.specifier));
    if (!target.startsWith("packages/") || target.startsWith("packages/consts/")) continue;
    problems.push(
      `${relativePath}:${lineOf(source, reference.start)} imports ${target} at runtime; ` +
      "the full-suite parent and non-fixture modules may only import packages/consts/ values or use import type"
    );
  }
  return problems;
}
