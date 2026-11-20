/**
 * `scripts/conventions/sourceRules.ts` 的静态 `console.*` 与带 `.ts` 后缀聚合类型桶引用负例测试（`[S-09]`）。
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import {
  collectDeclarationProblems,
  collectTestOnlyTypeBarrelProblems,
} from "../../scripts/conventions/sourceRules";

const PROJECT_ROOT: string = "/project";

/**
 * 解析一段虚拟 TS 源码并运行 `collectDeclarationProblems`。
 *
 * @param relativePath 相对仓库根的虚拟路径
 * @param text 待检查源码文本
 * @returns 声明约定问题列表
 */
function declarationProblems(relativePath: string, text: string): readonly string[] {
  const path: string = `${PROJECT_ROOT}/${relativePath}`;
  const source: ts.SourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return collectDeclarationProblems({ projectRoot: PROJECT_ROOT, path, source });
}

describe("源码声明门禁：静态 console.* 与聚合类型桶后缀", () => {
  test("packages/ 普通模块禁止任意静态 console.* 调用；logger 的计算属性访问不受影响", async (): Promise<void> => {
    for (const method of ["log", "info", "warn", "debug", "error"] as const) {
      expect(declarationProblems("packages/infra/example.ts", `console.${method}("msg");`)).toEqual([
        method === "error"
          ? "packages/infra/example.ts:1 direct console.error is restricted to the disk I/O Worker boundary"
          : `packages/infra/example.ts:1 direct console.${method} is forbidden in packages/; use logger instead`,
      ]);
    }
    const loggerPath: string = join(process.cwd(), "packages", "infra", "logger.ts");
    const loggerSource: ts.SourceFile = ts.createSourceFile(
      loggerPath,
      await Bun.file(loggerPath).text(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    expect(collectDeclarationProblems({ projectRoot: process.cwd(), path: loggerPath, source: loggerSource })).toEqual([]);
  });

  test("Disk I/O 边界仅放行 console.error，其它静态 console.* 照常拒绝", (): void => {
    expect(declarationProblems("packages/workers/diskIOWorker.ts", 'console.error("ok");')).toEqual([]);
    expect(declarationProblems("packages/workers/diskIO/logFiles.ts", 'console.error("ok");')).toEqual([]);
    expect(declarationProblems("packages/workers/diskIOWorker.ts", 'console.log("no");')).toEqual([
      "packages/workers/diskIOWorker.ts:1 direct console.log is forbidden in packages/; use logger instead",
    ]);
    expect(declarationProblems("packages/workers/diskIO/logFiles.ts", 'console.warn("no");')).toEqual([
      "packages/workers/diskIO/logFiles.ts:1 direct console.warn is forbidden in packages/; use logger instead",
    ]);
  });

  test("带 .ts 后缀的测试专用聚合类型桶导入同样被生产代码拦截", (): void => {
    const problems: readonly string[] = declarationProblems(
      "packages/infra/example.ts",
      'import type { A } from "../types/antiRaid.ts";\n' +
      'import type { B } from "../types/diskIO.ts";\n' +
      'import type { C } from "../types/miniApp.ts";\n' +
      'import type { D } from "../types/index.ts";\n' +
      'import type { E } from "../types.ts";'
    );
    expect(problems).toHaveLength(5);
    expect(problems.every((item: string): boolean => item.includes("test-only barrel"))).toBeTrue();
  });

  test("scripts/ 下导入 packages/ 测试专用聚合类型桶同样被拦截，脚本自身 ./types 与领域模块放行", (): void => {
    const path: string = `${PROJECT_ROOT}/scripts/perf/fullSuite/example.ts`;
    const source: ts.SourceFile = ts.createSourceFile(
      path,
      'import type { A } from "../../../packages/types/diskIO";\n' +
      'import type { B } from "../../../packages/types/antiRaid.ts";\n' +
      'import type { C } from "../../../packages/mini-app-frontend/types/miniApp";\n' +
      'import type { D } from "../../../packages/types/index";\n' +
      'import type { E } from "../../../packages/types";\n' +
      'import type { Local } from "./types";\n' +
      'import type { Domain } from "../../../packages/types/diskIO/replies";\n' +
      'import type { Status } from "../../../packages/mini-app-frontend/types/miniApp/status";\n',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const problems: readonly string[] = collectTestOnlyTypeBarrelProblems({
      projectRoot: PROJECT_ROOT,
      path,
      source,
    });
    expect(problems).toEqual([
      "scripts/perf/fullSuite/example.ts:1 scripts must import from a domain type module instead of the test-only barrel ../../../packages/types/diskIO",
      "scripts/perf/fullSuite/example.ts:2 scripts must import from a domain type module instead of the test-only barrel ../../../packages/types/antiRaid.ts",
      "scripts/perf/fullSuite/example.ts:3 scripts must import from a domain type module instead of the test-only barrel ../../../packages/mini-app-frontend/types/miniApp",
      "scripts/perf/fullSuite/example.ts:4 scripts must import from a domain type module instead of the test-only barrel ../../../packages/types/index",
      "scripts/perf/fullSuite/example.ts:5 scripts must import from a domain type module instead of the test-only barrel ../../../packages/types",
    ]);
  });
});
