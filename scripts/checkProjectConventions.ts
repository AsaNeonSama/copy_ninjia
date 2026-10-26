import type { Stats } from "node:fs";
import { extname, join } from "node:path";
import type ts from "typescript";
import { createModuleGraphReader } from "./conventions/moduleGraph";
import type { ModuleGraphReader } from "./conventions/moduleGraph";
import { createTypeCheckProgram, parseSourceFile, sourceFilesUnder } from "./conventions/sourceAnalysis";
import {
  collectCacheJsDocProblems,
  collectConstantProblems,
  collectConstantLocationProblems,
  collectDeclarationProblems,
  collectFunctionJsDocProblems,
  collectModuleCacheProblems,
  collectIteratorHeadProblems,
  collectObjectFreezeProblems,
} from "./conventions/sourceRules";
import type { SourceFileRuleParams } from "./conventions/sourceRules";
import { collectColdMigrationProblems } from "./conventions/coldMigrations";
import { collectConstExhaustiveListProblems, PARTIAL_LITERAL_TABLES } from "./conventions/constExhaustiveLists";
import { collectConstImmutabilityAssertionProblems } from "./conventions/constImmutability";
import { exportedConstDeclarations } from "./conventions/constsProgram";
import type { ExportedConstDeclaration } from "./conventions/constsProgram";
import { collectCoverageMetricProblems } from "./conventions/coverageMetrics";
import { collectFaultInjectionSuiteProblems } from "./conventions/faultInjectionSuite";
import { collectFileLengthProblems } from "./conventions/fileLength";
import { collectInstallModuleProblems } from "./conventions/installModules";
import {
  collectUndeclaredDependencyProblems,
  readDeclaredPackages,
} from "./conventions/manifestDependencies";
import { collectPerformanceRecordProblems } from "./conventions/performanceRecord";
import { collectRuntimeCalibrationProblems } from "./perf/hotPaths/gateRuntime";
import {
  CACHE_OWNER_BY_PREFIX,
  CACHE_OWNER_EXEMPTIONS,
  collectCacheOwnerHeaderProblems,
  collectCacheOwnershipProblems,
  collectStaleCacheExemptionProblems,
  collectWorkerTelegramClosureProblems,
  THREAD_ENTRY_PATHS,
} from "./conventions/cacheOwnership";
import { collectWorkerTimerProblems } from "./conventions/workerTimers";
import { collectCommentReferenceProblems } from "./conventions/commentReferences";
import {
  collectMarkdownModuleListProblems,
  collectSourceDirectories,
} from "./conventions/markdownModuleLists";
import {
  collectMarkdownPathProblems,
  collectRepositoryPaths,
} from "./conventions/markdownPaths";
import { checkMarkdownLocalLinks } from "./conventions/markdownAnchors";
import { collectMiniAppFrontendBoundaryProblems } from "./conventions/miniAppFrontend";
import {
  collectNodeCompatibilityProblems,
  collectNodeImportUsage,
  collectStaleNodeAllowanceProblems,
  collectUnusedNodeAllowanceProblems,
} from "./conventions/nodeCompatibility";
import type { NodeImportUsage } from "./conventions/nodeCompatibility";
import { collectTelegramMessageProblems } from "./conventions/telegramMessages";
import {
  collectConstantValueAssertionProblems,
  collectExportedStringConstants,
  collectStringConstantAssertionProblems,
} from "./conventions/testAssertions";
import { collectMockResetProblems } from "./conventions/testMockReset";
import {
  collectConstantTextFragmentAssertionProblems,
  collectConstantTextFragments,
  collectUnusedConstantTextExemptionProblems,
  constantTextCorpus,
} from "./conventions/testAssertionFragments";
import {
  collectEnvironmentAccessProblems,
  collectFullSuiteImportProblems,
  collectInfraLayeringProblems,
  collectStatesPurityProblems,
  collectConstsPurityProblems,
  CONSTS_ROOT_PREFIXES,
  STATES_CLOSURE_OPAQUE_MODULES,
} from "./conventions/moduleBoundaries";

const PROJECT_ROOT: string = join(import.meta.dir, "..");
const CACHE_ROOT: string = join(PROJECT_ROOT, "packages", "cache");
/** 常量目录（`packages/consts/` 与 Mini App 前端的 `packages/mini-app-frontend/consts/`）的绝对路径前缀。 */
const CONSTS_ROOTS: readonly string[] = CONSTS_ROOT_PREFIXES.map(
  (prefix: string): string => join(PROJECT_ROOT, prefix)
);
const SOURCE_ROOT: string = join(PROJECT_ROOT, "packages");
const SCRIPTS_ROOT: string = join(PROJECT_ROOT, "scripts");
const TEST_ROOT: string = join(PROJECT_ROOT, "test");
const COMMANDS_ROOT: string = join(SOURCE_ROOT, "commands");
const INFRA_ROOT: string = join(SOURCE_ROOT, "infra");
const STATES_ROOT: string = join(SOURCE_ROOT, "states");
const WORKERS_ROOT: string = join(SOURCE_ROOT, "workers");

/**
 * 检查受跟踪与尚未加入索引的源码；Git 忽略的部署数据不进入清单。
 * @returns 相对仓库根的项目文件路径列表。
 */
function projectFiles(): string[] {
  const result: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      `safe.directory=${PROJECT_ROOT}`,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr: string = result.stderr === undefined
      ? ""
      : new TextDecoder().decode(result.stderr);
    throw new Error(
      `Failed to enumerate project files: ${stderr.trim()}`
    );
  }
  const stdout: string = result.stdout === undefined
    ? ""
    : new TextDecoder().decode(result.stdout);
  return stdout.split("\0").filter(
    (path: string): boolean => path.length > 0
  );
}

/** 各线程入口的绝对路径；从入口出发构建同线程模块闭包（含最短引入路径）。 */
const THREAD_ENTRIES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(THREAD_ENTRY_PATHS).map(
    ([thread, path]: [string, string]): [string, string] => [thread, join(PROJECT_ROOT, path)]
  )
);

const failures: string[] = [];
/** 逐文件遍历时顺带记下的 Node 兼容 import；整趟结束后反向核对登记表。 */
const nodeImportUsage: NodeImportUsage[] = [];
failures.push(...await collectRuntimeCalibrationProblems({ projectRoot: PROJECT_ROOT }));
failures.push(...collectStaleNodeAllowanceProblems(PROJECT_ROOT));
for (const problem of await collectColdMigrationProblems(PROJECT_ROOT)) {
  failures.push(`cold migration: ${problem}`);
}
failures.push(...await collectCoverageMetricProblems(PROJECT_ROOT));
for (const problem of await collectFaultInjectionSuiteProblems(PROJECT_ROOT)) {
  failures.push(`fault injection suite: ${problem}`);
}

for (const problem of await collectPerformanceRecordProblems(PROJECT_ROOT)) {
  failures.push(`performance record: ${problem}`);
}
for (const problem of await collectInstallModuleProblems(PROJECT_ROOT)) {
  failures.push(`install script: ${problem}`);
}
// 目录清单核对按真实目录解析文档里的目录名；整趟只遍历一次，且只走源码根
// （见 collectSourceDirectories 的 JSDoc）。
const sourceDirectories: readonly string[] = collectSourceDirectories([
  SOURCE_ROOT,
  SCRIPTS_ROOT,
  TEST_ROOT,
]);
const tracked: string[] = [];
for (const trackedPath of projectFiles()) {
  // 允许尚未 stage 的正常删除；其它门禁会从最终工作树/索引确认变更范围。
  if (await Bun.file(join(PROJECT_ROOT, trackedPath)).exists()) {
    tracked.push(trackedPath);
  }
}
const repositoryPaths: ReadonlySet<string> = collectRepositoryPaths(tracked);
failures.push(...await collectMiniAppFrontendBoundaryProblems(PROJECT_ROOT, tracked));
for (const trackedPath of tracked) {
  const path: string = join(PROJECT_ROOT, trackedPath);
  if (/\.(?:[cm]?[jt]sx?|sh)$/.test(path)) {
    failures.push(...collectFileLengthProblems(trackedPath, await Bun.file(path).text()));
  }
  if (extname(path) === ".md") {
    await checkMarkdownLocalLinks(PROJECT_ROOT, path, failures);
    failures.push(...await collectMarkdownModuleListProblems(
      PROJECT_ROOT,
      path,
      sourceDirectories
    ));
    failures.push(...await collectMarkdownPathProblems(
      PROJECT_ROOT,
      path,
      repositoryPaths
    ));
  }
  const extension: string = extname(path);
  if (![".ts", ".json", ".md", ".yaml", ".yml"].includes(extension)) continue;
  const stats: Stats = await Bun.file(path).stat();
  if (!stats.isFile() || (stats.mode & 0o111) === 0) continue;
  if ((await Bun.file(path).text()).startsWith("#!")) continue;
  failures.push(
    `${trackedPath} is a tracked non-script ${extension} file with executable permissions`
  );
}

const moduleGraph: ModuleGraphReader = createModuleGraphReader();
const statesOpaqueModules: ReadonlySet<string> = new Set(
  STATES_CLOSURE_OPAQUE_MODULES.map((module: string): string => join(PROJECT_ROOT, module))
);
for (const module of STATES_CLOSURE_OPAQUE_MODULES) {
  if (!(await Bun.file(join(PROJECT_ROOT, module)).exists())) {
    failures.push(`STATES_CLOSURE_OPAQUE_MODULES lists ${module}, which no longer exists`);
  }
}
const threadClosures: Map<string, Map<string, string[]>> = new Map();
for (const [thread, entry] of Object.entries(THREAD_ENTRIES)) {
  threadClosures.set(thread, await moduleGraph.threadModuleClosure(entry));
}

for (const [thread, closure] of threadClosures) {
  if (thread === "main") continue;
  failures.push(...await collectWorkerTelegramClosureProblems({
    projectRoot: PROJECT_ROOT,
    thread,
    closure,
    graph: moduleGraph,
  }));
}

const sourceFiles: readonly string[] = sourceFilesUnder(SOURCE_ROOT);
const cacheFiles: readonly string[] = sourceFiles.filter(
  (path: string): boolean => path.startsWith(CACHE_ROOT + "/")
);
const constFiles: readonly string[] = sourceFiles.filter(
  (path: string): boolean => CONSTS_ROOTS.some((root: string): boolean => path.startsWith(root))
);
const scriptFiles: readonly string[] = sourceFilesUnder(SCRIPTS_ROOT);
const testFiles: readonly string[] = sourceFilesUnder(TEST_ROOT);

const cacheFirstLines: Map<string, string> = new Map();
for (const path of cacheFiles) {
  cacheFirstLines.set(path, (await Bun.file(path).text()).split("\n", 1)[0] ?? "");
}
failures.push(...collectCacheOwnerHeaderProblems({ projectRoot: PROJECT_ROOT, firstLines: cacheFirstLines }));
failures.push(...collectStaleCacheExemptionProblems({
  projectRoot: PROJECT_ROOT,
  cacheFiles,
  threadClosures,
  exemptions: CACHE_OWNER_EXEMPTIONS,
}));
failures.push(...collectCacheOwnershipProblems({
  projectRoot: PROJECT_ROOT,
  cacheFiles,
  threadEntries: THREAD_ENTRIES,
  threadClosures,
  ownerByPrefix: CACHE_OWNER_BY_PREFIX,
  exemptions: CACHE_OWNER_EXEMPTIONS,
}));

const cacheSourceFiles: ReadonlySet<string> = new Set(cacheFiles);
const constsSourceFiles: ReadonlySet<string> = new Set(constFiles);
/** 根 manifest 直接声明的包；逐文件核对运行期裸导入时共用。 */
const declaredPackages: ReadonlySet<string> = await readDeclaredPackages(PROJECT_ROOT);
/** 常量目录导出的字符串常量表（取值 → 常量名），逐文件判定时顺带收集，供测试断言规则比对。 */
const exportedStringConstants: Map<string, string[]> = new Map();
/** 常量目录全部字符串字面量与模板静态片段，供测试断言的文案片段规则做子串比对。 */
const constantTextFragments: string[] = [];
/** 文案片段规则本次用到的提示词契约豁免（`路径::用例名`），跑完后核对有无闲置条目。 */
const usedConstantTextExemptions: Set<string> = new Set<string>();
/** 注释交叉引用按 basename 解析时的候选集合：生产源码与主线程入口。 */
const referenceResolutionFiles: readonly string[] = [
  ...sourceFiles,
  THREAD_ENTRIES.main!,
];
// 逐文件的源码约定：每个文件只读一次、只解析一次，适用的规则全在这一趟里跑完。
// cache/consts 规则按 sourceFilesUnder 的真实文件集合判定适用范围；模块级缓存规则由
// collectModuleCacheProblems 判定。仓库根的 index.ts 不在 sourceFilesUnder(SOURCE_ROOT) 里，
// 显式并进同一趟判定。
for (const path of referenceResolutionFiles) {
  const source: ts.SourceFile = await parseSourceFile(path);
  const params: SourceFileRuleParams = { projectRoot: PROJECT_ROOT, path, source };
  if (!cacheSourceFiles.has(path) && !constsSourceFiles.has(path)) {
    failures.push(...collectConstantLocationProblems(params));
  }
  failures.push(...collectNodeCompatibilityProblems(PROJECT_ROOT, path, source));
  nodeImportUsage.push(...collectNodeImportUsage(PROJECT_ROOT, path, source));
  failures.push(...collectUndeclaredDependencyProblems({ projectRoot: PROJECT_ROOT, path, source, declaredPackages }));
  if (cacheSourceFiles.has(path)) {
    failures.push(...collectCacheJsDocProblems(params));
  }
  if (constsSourceFiles.has(path)) {
    failures.push(...collectConstantProblems(params));
    collectExportedStringConstants(source, exportedStringConstants);
    collectConstantTextFragments(source, constantTextFragments);
  }
  failures.push(...collectObjectFreezeProblems(params));
  failures.push(...collectIteratorHeadProblems(params));
  if (!path.startsWith(CACHE_ROOT) && !constsSourceFiles.has(path)) {
    failures.push(...collectModuleCacheProblems(params));
  }
  failures.push(...collectDeclarationProblems(params));
  failures.push(...collectFunctionJsDocProblems(params));
  failures.push(...collectEnvironmentAccessProblems(params));
  if (path.startsWith(STATES_ROOT + "/")) {
    failures.push(...collectStatesPurityProblems({
      ...params,
      closure: await moduleGraph.boundedModuleClosure(path, statesOpaqueModules),
    }));
  }
  if (constsSourceFiles.has(path)) {
    failures.push(...collectConstsPurityProblems(params));
  }
  if (path.startsWith(INFRA_ROOT + "/")) {
    failures.push(...collectInfraLayeringProblems(params));
  }
  failures.push(...await collectCommentReferenceProblems({
    projectRoot: PROJECT_ROOT,
    path,
    source,
    allSourceFiles: referenceResolutionFiles,
  }));
  if (path.startsWith(WORKERS_ROOT + "/")) {
    failures.push(...collectWorkerTimerProblems(PROJECT_ROOT, path, source));
  }
}

// Node 兼容 import、依赖声明与全量基准 import 边界同时约束 scripts/ 与 test/，函数 JSDoc
// 同时约束 scripts/，测试断言取值口径只约束 test/，其余判定只针对 packages/。
const constantTextCorpusText: string = constantTextCorpus(constantTextFragments);
for (const path of [...scriptFiles, ...testFiles]) {
  const source: ts.SourceFile = await parseSourceFile(path);
  failures.push(...collectNodeCompatibilityProblems(PROJECT_ROOT, path, source));
  nodeImportUsage.push(...collectNodeImportUsage(PROJECT_ROOT, path, source));
  failures.push(...collectUndeclaredDependencyProblems({ projectRoot: PROJECT_ROOT, path, source, declaredPackages }));
  failures.push(...collectFullSuiteImportProblems({ projectRoot: PROJECT_ROOT, path, source }));
  if (path.startsWith(SCRIPTS_ROOT + "/")) {
    failures.push(...collectFunctionJsDocProblems({ projectRoot: PROJECT_ROOT, path, source }));
  }
  if (path.startsWith(TEST_ROOT + "/")) {
    failures.push(...collectConstantValueAssertionProblems({ projectRoot: PROJECT_ROOT, path, source }));
    failures.push(...collectStringConstantAssertionProblems({
      projectRoot: PROJECT_ROOT,
      path,
      source,
      constants: exportedStringConstants,
    }));
    failures.push(...collectConstantTextFragmentAssertionProblems({
      projectRoot: PROJECT_ROOT,
      path,
      source,
      corpus: constantTextCorpusText,
      usedExemptions: usedConstantTextExemptions,
    }));
  }
}
failures.push(...collectUnusedConstantTextExemptionProblems(usedConstantTextExemptions));
const constsProgram: ts.Program = createTypeCheckProgram(PROJECT_ROOT, constFiles);
const constsChecker: ts.TypeChecker = constsProgram.getTypeChecker();
const constDeclarations: readonly ExportedConstDeclaration[] = exportedConstDeclarations(constsProgram, constFiles);
failures.push(...collectConstImmutabilityAssertionProblems({
  projectRoot: PROJECT_ROOT,
  checker: constsChecker,
  declarations: constDeclarations,
  assertionSource: await Bun.file(join(PROJECT_ROOT, "test", "consts", "immutability.test.ts")).text(),
}));
failures.push(...collectConstExhaustiveListProblems({
  projectRoot: PROJECT_ROOT,
  checker: constsChecker,
  declarations: constDeclarations,
  partialTables: PARTIAL_LITERAL_TABLES,
}));
failures.push(...collectUnusedNodeAllowanceProblems(nodeImportUsage));
failures.push(...collectMockResetProblems({
  projectRoot: PROJECT_ROOT,
  program: createTypeCheckProgram(PROJECT_ROOT, testFiles),
  testFiles,
}));

failures.push(...await collectTelegramMessageProblems(
  PROJECT_ROOT,
  SOURCE_ROOT,
  COMMANDS_ROOT
));

if (failures.length > 0) {
  console.error(`Project convention check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Project convention check passed.");
}
