/**
 * 依赖声明门禁：项目源码的运行期裸导入必须由根 manifest 直接声明。判据：未声明的包（含只经传递依赖提升的包）被报出、
 * 已声明包的子路径归到所属包名、运行时内建模块与纯类型引用不参与判定、真实仓库现状干净。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  collectUndeclaredDependencyProblems,
  packageNameOf,
  readDeclaredPackages,
} from "../../scripts/conventions/manifestDependencies";
import type { DeclaredPackages } from "../../scripts/conventions/manifestDependencies";
import { sourceFilesUnder } from "../../scripts/conventions/sourceAnalysis";

const PROJECT_ROOT: string = "/project";
const FIXTURE_PATH: string = "/project/scripts/example.ts";
const DECLARED: ReadonlySet<string> = new Set<string>(["grammy", "@grammyjs/runner", "drizzle-orm", "typescript"]);
const roots: string[] = [];

function problemsOf(text: string, declaredPackages: ReadonlySet<string> = DECLARED): readonly string[] {
  return collectUndeclaredDependencyProblems({
    projectRoot: PROJECT_ROOT,
    path: FIXTURE_PATH,
    source: ts.createSourceFile(FIXTURE_PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    declaredPackages,
  });
}

afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("依赖声明门禁", (): void => {
  test.each([
    ["grammy", "grammy"],
    ["grammy/types", "grammy"],
    ["drizzle-orm/bun-sqlite/migrator", "drizzle-orm"],
    ["@grammyjs/runner", "@grammyjs/runner"],
    ["@scope/pkg/deep/path", "@scope/pkg"],
    ["./local", undefined],
    ["../packages/libs/text", undefined],
    ["/absolute/module", undefined],
    ["bun", undefined],
    ["bun:test", undefined],
    ["node:fs", undefined],
    ["fs", undefined],
    ["fs/promises", undefined],
  ] as const)("说明符 %s 归到包 %s", (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected);
  });

  test.each([
    'import { familySync } from "detect-libc";',
    'import libc from "detect-libc";',
    'import "detect-libc";',
    'const { familySync } = await import("detect-libc");',
    'const libc = require("detect-libc");',
    'export { familySync } from "detect-libc";',
    'import { familySync, type Family } from "detect-libc";',
  ])("未声明的运行期包引用必须报出：%s", (source) => {
    expect(problemsOf(source)).toEqual([
      "scripts/example.ts:1 imports detect-libc at runtime, " +
      "but detect-libc is not declared in package.json dependencies or devDependencies",
    ]);
  });

  test("作用域包按前两段报出，行号指向引用处", () => {
    expect(problemsOf('import { a } from "grammy";\nimport { b } from "@scope/pkg/sub";\n')).toEqual([
      "scripts/example.ts:2 imports @scope/pkg/sub at runtime, " +
      "but @scope/pkg is not declared in package.json dependencies or devDependencies",
    ]);
  });

  test.each([
    'import { Bot } from "grammy";',
    'import type { Update } from "grammy/types";',
    'import { run } from "@grammyjs/runner";',
    'import { sqliteTable } from "drizzle-orm/sqlite-core";',
    'import type { Family } from "detect-libc";',
    'import { type Family } from "detect-libc";',
    'export type { Family } from "detect-libc";',
    'import { join } from "node:path";',
    'import { readFileSync } from "fs";',
    'import { expect } from "bun:test";',
    'import { heapStats } from "bun:jsc";',
    'import { helper } from "./helper";',
    'const fixture: string = "import { x } from \\"detect-libc\\";";',
  ])("已声明包、内建模块、纯类型引用与字符串夹具不报：%s", (source) => {
    expect(problemsOf(source)).toEqual([]);
  });

  test("manifest 将 dependencies 与 devDependencies 拆分为 runtime 与 all，缺节按空处理", async (): Promise<void> => {
    const root: string = mkdtempSync(join(tmpdir(), "manifest-dependencies-"));
    roots.push(root);
    await Bun.write(join(root, "package.json"), JSON.stringify({
      dependencies: { grammy: "^1.0.0" },
      devDependencies: { "detect-libc": "^2.1.2" },
    }));
    const declared: DeclaredPackages = await readDeclaredPackages(root);
    expect([...declared.runtime].sort()).toEqual(["grammy"]);
    expect([...declared.all].sort()).toEqual(["detect-libc", "grammy"]);
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "empty" }));
    const empty: DeclaredPackages = await readDeclaredPackages(root);
    expect([...empty.runtime]).toEqual([]);
    expect([...empty.all]).toEqual([]);
  });

  test("负例：生产源码引用仅声明在 devDependencies 的包按 runtime 拦截，脚本与测试放行", () => {
    const prodPath: string = "/project/packages/infra/devDepLeak.ts";
    const scriptPath: string = "/project/scripts/example.ts";
    const devOnlyText: string = 'import { familySync } from "detect-libc";\nvoid familySync;\n';
    const runtimeSet: ReadonlySet<string> = new Set<string>(["grammy"]);
    const allSet: ReadonlySet<string> = new Set<string>(["grammy", "detect-libc"]);

    expect(collectUndeclaredDependencyProblems({
      projectRoot: PROJECT_ROOT,
      path: prodPath,
      source: ts.createSourceFile(prodPath, devOnlyText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      declaredPackages: runtimeSet,
      runtimeOnly: true,
    })).toEqual([
      "packages/infra/devDepLeak.ts:1 imports detect-libc at runtime, " +
      "but detect-libc is not declared in package.json dependencies",
    ]);
    expect(collectUndeclaredDependencyProblems({
      projectRoot: PROJECT_ROOT,
      path: scriptPath,
      source: ts.createSourceFile(scriptPath, devOnlyText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      declaredPackages: allSet,
    })).toEqual([]);
  });

  test("回归用例：构建脚本的 detect-libc 缺少直接声明时报出", async (): Promise<void> => {
    const projectRoot: string = process.cwd();
    const path: string = join(projectRoot, "scripts", "build.ts");
    const declared: Set<string> = new Set<string>((await readDeclaredPackages(projectRoot)).all);
    expect(declared.has("detect-libc")).toBeTrue();
    declared.delete("detect-libc");
    const source: ts.SourceFile = ts.createSourceFile(
      path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS
    );
    expect(collectUndeclaredDependencyProblems({ projectRoot, path, source, declaredPackages: declared })).toEqual([
      expect.stringContaining("scripts/build.ts:4 imports detect-libc at runtime, but detect-libc is not declared"),
    ]);
  });

  test("真实仓库的运行期裸导入分别匹配 runtime（生产）与 all（脚本/测试）声明", async (): Promise<void> => {
    const projectRoot: string = process.cwd();
    const declared: DeclaredPackages = await readDeclaredPackages(projectRoot);
    const runtimePaths: readonly string[] = [
      join(projectRoot, "index.ts"),
      ...sourceFilesUnder(join(projectRoot, "packages")),
    ];
    const devAndScriptPaths: readonly string[] = [
      ...sourceFilesUnder(join(projectRoot, "scripts")),
      ...sourceFilesUnder(join(projectRoot, "test")),
    ];
    const problems: string[] = [];
    for (const path of runtimePaths) {
      const source: ts.SourceFile = ts.createSourceFile(
        path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS
      );
      problems.push(...collectUndeclaredDependencyProblems({
        projectRoot,
        path,
        source,
        declaredPackages: declared.runtime,
        runtimeOnly: true,
      }));
    }
    for (const path of devAndScriptPaths) {
      const source: ts.SourceFile = ts.createSourceFile(
        path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS
      );
      problems.push(...collectUndeclaredDependencyProblems({
        projectRoot,
        path,
        source,
        declaredPackages: declared.all,
      }));
    }
    expect(problems).toEqual([]);
  });
});
