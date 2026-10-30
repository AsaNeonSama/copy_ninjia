/**
 * 「谁能依赖谁」的门禁（scripts/conventions/moduleBoundaries.ts）。
 * 真实仓库全部合规，这里逐条造违规样本，确认它们被拦下。
 */

import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  collectConstsPurityProblems,
  collectEnvironmentAccessProblems,
  collectFullSuiteImportProblems,
  collectInfraLayeringProblems,
  collectStatesPurityProblems,
  STATES_CLOSURE_OPAQUE_MODULES,
} from "../../scripts/conventions/moduleBoundaries";
import { createModuleGraphReader } from "../../scripts/conventions/moduleGraph";
import type { ModuleGraphReader } from "../../scripts/conventions/moduleGraph";

const PROJECT_ROOT: string = "/project";

function params(relativePath: string, text: string): {
  projectRoot: string;
  path: string;
  source: ts.SourceFile;
} {
  const path: string = `${PROJECT_ROOT}/${relativePath}`;
  return {
    projectRoot: PROJECT_ROOT,
    path,
    source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

describe("环境变量读取边界", () => {
  test("两个边界文件之外读 process.env / Bun.env 一律拦下", () => {
    expect(collectEnvironmentAccessProblems(params(
      "packages/libs/example.ts",
      "const value = process.env.HOME;"
    ))).toEqual([expect.stringContaining("reads process.env")]);
    expect(collectEnvironmentAccessProblems(params(
      "packages/libs/example.ts",
      'const value = Bun.env["HOME"];'
    ))).toEqual([expect.stringContaining("reads Bun.env")]);
  });

  test("consts/paths.ts 与 consts/environment.ts 放行", () => {
    for (const file of ["packages/consts/paths.ts", "packages/consts/environment.ts"]) {
      expect(collectEnvironmentAccessProblems(params(file, "const v = process.env.HOME;"))).toEqual([]);
    }
  });

  test("同名属性不误伤：别的对象上的 env 不算", () => {
    expect(collectEnvironmentAccessProblems(params(
      "packages/libs/example.ts",
      "const value = options.env.HOME; const spawn = { env: {} };"
    ))).toEqual([]);
  });
});

describe("packages/consts 纯度", () => {
  test("运行期只允许同目录模块；纯类型引用、npm 包与 node: 内置模块不算", () => {
    expect(collectConstsPurityProblems(params(
      "packages/consts/aiChat/example.ts",
      'import { A } from "../exhaustiveList";\nimport type { B } from "../../types/x";\n' +
      'import { join } from "node:path";\nimport { FinishReason } from "@google/genai";'
    ))).toEqual([]);
  });

  test("其余 packages/ 模块的运行期引用一律拦下", () => {
    const problems = collectConstsPurityProblems(params(
      "packages/consts/example.ts",
      'import { a } from "../libs/x";\nexport { b } from "../infra/y";'
    ));
    expect(problems).toHaveLength(2);
    expect(problems.every((problem: string): boolean => problem.includes("may only depend on other consts modules"))).toBeTrue();
  });

  test("Mini App 前端常量目录运行期只依赖自身，packages/consts/ 同样拦下", () => {
    expect(collectConstsPurityProblems(params(
      "packages/mini-app-frontend/consts/example.ts",
      'import { A } from "./exhaustiveList";\nimport type { B } from "../types/x";'
    ))).toEqual([]);
    expect(collectConstsPurityProblems(params(
      "packages/mini-app-frontend/consts/example.ts",
      'import { MINUTE_MS } from "../../consts/time";'
    ))).toEqual([expect.stringContaining("packages/mini-app-frontend/consts/ may only depend on other consts modules")]);
  });

  test("常量目录之外的文件不在本规则范围内", () => {
    expect(collectConstsPurityProblems(params(
      "packages/libs/example.ts",
      'import { a } from "../infra/x";'
    ))).toEqual([]);
  });
});

describe("packages/states 纯度", () => {
  const ENTRY_RELATIVE: string = "packages/states/example.ts";
  const ENTRY: string = `${PROJECT_ROOT}/${ENTRY_RELATIVE}`;

  /** 由若干条相对路径的引入链造闭包；每条链从被检查的 states 模块起。 */
  function closureOf(...trails: readonly (readonly string[])[]): Map<string, string[]> {
    const closure: Map<string, string[]> = new Map<string, string[]>([[ENTRY, [ENTRY]]]);
    for (const trail of trails) {
      const absolute: string[] = [ENTRY, ...trail.map((step: string): string => `${PROJECT_ROOT}/${step}`)];
      closure.set(absolute.at(-1)!, absolute);
    }
    return closure;
  }

  test("直接依赖只允许 consts、libs、types 与同目录模块", () => {
    expect(collectStatesPurityProblems({
      ...params(
        ENTRY_RELATIVE,
        'import { A } from "../consts/x";\nimport { B } from "../libs/y";\n' +
        'import type { C } from "../types/z";\nimport { D } from "./other";'
      ),
      closure: closureOf(),
    })).toEqual([]);
  });

  test("直接依赖缓存、infra 与 Worker 桥一律拦下，登记的不透明模块也不能直接引入", () => {
    const problems: readonly string[] = collectStatesPurityProblems({
      ...params(
        ENTRY_RELATIVE,
        'import { logger } from "../infra/logger";\nimport { cache } from "../cache/main/x";\n' +
        'import { post } from "../antiRaid/workerBridge/controller";\nimport { getTimeZone } from "../config/time";'
      ),
      closure: closureOf(),
    });
    expect(problems).toHaveLength(4);
    expect(problems.every((problem: string): boolean => problem.includes("may only depend on"))).toBeTrue();
  });

  test("纯类型引用被擦除，不算运行期依赖", () => {
    expect(collectStatesPurityProblems({
      ...params(
        ENTRY_RELATIVE,
        'import type { ChatState } from "../types/chatState";\nimport type { Api } from "../infra/telegram";'
      ),
      closure: closureOf(),
    })).toEqual([]);
  });

  test("经 libs 间接碰到缓存时拦下并给出引入路径；不透明模块放行，直接依赖不在闭包里重复报", () => {
    const problems: readonly string[] = collectStatesPurityProblems({
      ...params(ENTRY_RELATIVE, 'import { B } from "../libs/y";'),
      closure: closureOf(
        ["packages/libs/y.ts"],
        ["packages/libs/y.ts", "packages/cache/main/x.ts"],
        ["packages/libs/time.ts", ...STATES_CLOSURE_OPAQUE_MODULES],
        ["packages/infra/logger.ts"]
      ),
    });
    expect(problems).toEqual([
      "packages/states/example.ts reaches packages/cache/main/x.ts at runtime " +
      "(packages/states/example.ts -> packages/libs/y.ts -> packages/cache/main/x.ts); " +
      "packages/states/ may only depend on consts, libs, types and other states modules",
    ]);
  });

  test("真实 states 模块：时区快照之后的 holder 不再展开，不登记时会被报出", async () => {
    const projectRoot: string = process.cwd();
    const path: string = join(projectRoot, "packages", "states", "temporaryAdBypass.ts");
    const source: ts.SourceFile = ts.createSourceFile(
      path,
      await Bun.file(path).text(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const opaque: ReadonlySet<string> = new Set(
      STATES_CLOSURE_OPAQUE_MODULES.map((module: string): string => join(projectRoot, module))
    );
    const reader: ModuleGraphReader = createModuleGraphReader();
    const bounded: Map<string, string[]> = await reader.boundedModuleClosure(path, opaque);
    const holder: string = join(projectRoot, "packages", "cache", "perThread", "time.ts");
    for (const module of opaque) expect(bounded.has(module)).toBeTrue();
    expect(bounded.has(holder)).toBeFalse();
    expect(collectStatesPurityProblems({ projectRoot, path, source, closure: bounded })).toEqual([]);

    const unbounded: Map<string, string[]> = await reader.threadModuleClosure(path);
    expect(unbounded.has(holder)).toBeTrue();
    expect(collectStatesPurityProblems({ projectRoot, path, source, closure: unbounded }))
      .toContainEqual(expect.stringContaining("reaches packages/cache/perThread/time.ts at runtime"));
  });
});

describe("infra 不得向上依赖业务层", () => {
  test("命令、AI、Anti-Raid、Mini App 与 Worker 一律拦下", () => {
    const problems = collectInfraLayeringProblems(params(
      "packages/infra/example.ts",
      'import { a } from "../commands/x";\nimport { b } from "../aiChat/workerBridge";\n' +
      'import { c } from "../antiRaid/adDetect";\nimport { d } from "../workers/aiChat/x";\n' +
      'import { e } from "../mini-app-api-server/auth/totpStorage";'
    ));
    expect(problems).toHaveLength(5);
    expect(problems[0]).toContain("inject the dependency instead");
  });

  test("落盘诊断出口是唯一豁免", () => {
    expect(collectInfraLayeringProblems(params(
      "packages/infra/diskIO/host.ts",
      'import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";'
    ))).toEqual([]);
  });

  test("同层与更低层照常放行", () => {
    expect(collectInfraLayeringProblems(params(
      "packages/infra/example.ts",
      'import { a } from "./logger";\nimport { b } from "../libs/x";\nimport { c } from "../cache/main/y";'
    ))).toEqual([]);
  });
});

describe("全量基准的 import 边界", () => {
  test("父进程与非夹具模块只能取常量或类型", () => {
    expect(collectFullSuiteImportProblems(params(
      "scripts/perf/fullSuite/sections.ts",
      'import { X } from "../../../packages/consts/qa";\n' +
      'import type { Y } from "../../../packages/infra/joinLog";'
    ))).toEqual([]);
    expect(collectFullSuiteImportProblems(params(
      "scripts/perf/fullSuite.ts",
      'import { recordJoinLog } from "../../packages/infra/joinLog";'
    ))).toEqual([expect.stringContaining("may only import packages/consts/")]);
  });

  test("五个夹具模块可以调生产入口", () => {
    for (const file of ["chain", "coldStart", "fixture", "seed", "storage"]) {
      expect(collectFullSuiteImportProblems(params(
        `scripts/perf/fullSuite/${file}.ts`,
        'import { recordJoinLog } from "../../../packages/infra/joinLog";'
      ))).toEqual([]);
    }
  });

  test("fullSuite 之外的脚本不受本规则约束", () => {
    expect(collectFullSuiteImportProblems(params(
      "scripts/perf/joinLog.ts",
      'import { recordJoinLog } from "../../packages/infra/joinLog";'
    ))).toEqual([]);
  });
});
