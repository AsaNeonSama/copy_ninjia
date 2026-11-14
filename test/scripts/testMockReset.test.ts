import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTypeCheckProgram } from "../../scripts/conventions/sourceAnalysis";
import { collectMockResetProblems } from "../../scripts/conventions/testMockReset";

const PROJECT_ROOT: string = join(import.meta.dir, "..", "..");
const FIXTURE_DIR: string = mkdtempSync(join(tmpdir(), "test-mock-reset-"));

afterAll((): void => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

/** 把夹具写进临时目录，以 test/ 门禁同样的方式建 program，返回报出的问题。 */
async function problemsFor(files: Readonly<Record<string, string>>): Promise<readonly string[]> {
  const directory: string = mkdtempSync(join(FIXTURE_DIR, "case-"));
  const paths: string[] = [];
  for (const [name, source] of Object.entries(files)) {
    const path: string = join(directory, name);
    await Bun.write(path, source);
    paths.push(path);
  }
  return collectMockResetProblems({
    projectRoot: directory,
    program: createTypeCheckProgram(PROJECT_ROOT, paths),
    testFiles: paths,
  });
}

describe("排过 Once 的替身必须用 mockReset 复位", () => {
  test("复位钩子只做 mockClear 时报出钩子与 Once 两处位置", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { beforeEach, mock, test } from "bun:test";',
        "const send = mock((): number => 1);",
        "beforeEach(() => { send.mockClear(); });",
        'test("x", () => { send.mockReturnValueOnce(2); });',
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([
      "a.test.ts:3:20: send is reset with mockClear() but queues *Once values (a.test.ts:4:19); " +
      "reset it with mockReset() and reinstall its default implementation",
    ]);
  });

  test("mockReset 后装回默认实现、只清调用记录却从不排 Once、用例中途清调用记录，都放行", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { beforeEach, mock, test } from "bun:test";',
        "function sendStub(): number { return 1; }",
        "const send = mock(sendStub);",
        "const log = mock((): void => {});",
        "const read = mock((): number => 0);",
        "beforeEach(() => {",
        "  send.mockReset();",
        "  send.mockImplementation(sendStub);",
        "  log.mockClear();",
        "});",
        'test("x", () => {',
        "  send.mockReturnValueOnce(2);",
        "  read.mockReturnValueOnce(3);",
        "  read.mockClear();",
        "});",
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([]);
  });

  test("for...of 数组里的替身逐个归到声明；只报排过 Once 的那个", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { beforeEach, mock, test } from "bun:test";',
        "const send = mock((): number => 1);",
        "const log = mock((): void => {});",
        "beforeEach(() => { for (const mocked of [send, log]) mocked.mockClear(); });",
        'test("x", () => { send.mockReturnValueOnce(2); });',
        "",
      ].join("\n"),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("a.test.ts:4:54: send is reset with mockClear()");
  });

  test("跨文件：钩子调用 harness 的复位函数，Once 经 await import() 解构的替身排入", async () => {
    const problems: readonly string[] = await problemsFor({
      "harness.ts": [
        'import { mock } from "bun:test";',
        "export const send = mock((): number => 1);",
        "export function resetHarness(): void { send.mockClear(); }",
        "",
      ].join("\n"),
      "a.test.ts": [
        'import { beforeEach, test } from "bun:test";',
        'const { send, resetHarness } = await import("./harness");',
        "beforeEach(resetHarness);",
        'test("x", () => { send.mockReturnValueOnce(2); });',
        "",
      ].join("\n"),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("harness.ts:3:40: send is reset with mockClear()");
  });

  test("harness 对象属性按属性声明归并", async () => {
    const problems: readonly string[] = await problemsFor({
      "harness.ts": [
        'import { mock } from "bun:test";',
        "export const harness = { send: mock((): number => 1) };",
        "",
      ].join("\n"),
      "a.test.ts": [
        'import { beforeEach, test } from "bun:test";',
        'import { harness } from "./harness";',
        "beforeEach(() => { harness.send.mockClear(); });",
        'test("x", () => { harness.send.mockImplementationOnce((): number => 2); });',
        "",
      ].join("\n"),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("a.test.ts:3:20: send is reset with mockClear()");
  });

  test("afterEach 与 beforeAll 同样算复位钩子，钩子经多层函数调用到的 mockClear 也算", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { afterEach, beforeAll, mock, test } from "bun:test";',
        "const send = mock((): number => 1);",
        "const read = mock((): number => 0);",
        "function clearInner(): void { send.mockClear(); }",
        "function clearOuter(): void { clearInner(); }",
        "afterEach(() => { clearOuter(); });",
        "beforeAll(() => { read.mockClear(); });",
        'test("x", () => { send.mockReturnValueOnce(2); read.mockResolvedValueOnce(3); });',
        "",
      ].join("\n"),
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toStartWith("a.test.ts:4:31: send is reset with mockClear()");
    expect(problems[1]).toStartWith("a.test.ts:7:19: read is reset with mockClear()");
  });
});

/**
 * 拼出套件级 spyOn 未恢复的诊断文案（与 scripts/conventions/testSpyRestore.ts 的输出逐字一致）。
 * @param location `文件:行:列` 位置前缀。
 * @param origin 监听创建位置。
 * @param label 绑定变量名或 `spyOn(...)`。
 * @returns 完整诊断文案。
 */
function spyProblem(location: string, origin: "top-level" | "beforeAll" | "beforeEach", label: string): string {
  const hooks: string = origin === "beforeEach" ? "afterEach/afterAll" : "afterAll";
  return `${location}: ${origin} ${label} must be restored in ${hooks} of the same or an enclosing suite: ` +
    "call .mockRestore() when spying on a real function, or mock.restore() when the target may already be a mock " +
    "(spyOn then returns that mock and .mockRestore() clears its implementation)";
}

describe("套件级 spyOn 必须在同文件恢复", () => {
  test("顶层与 describe 顶层未恢复的 spyOn（含未绑定变量）都报出准确位置", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { describe, spyOn, test } from "bun:test";',
        "const target = { fn: (): number => 1, other: (): number => 2 };",
        'const s = spyOn(target, "fn");',
        'spyOn(target, "other").mockImplementation((): number => 3);',
        'describe("suite", () => {',
        '  const nestedTop = spyOn(target, "fn");',
        '  test("ok", () => { s(); nestedTop(); });',
        "});",
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([
      spyProblem("a.test.ts:3:11", "top-level", "s"),
      spyProblem("a.test.ts:4:1", "top-level", "spyOn(...)"),
      spyProblem("a.test.ts:6:21", "top-level", "nestedTop"),
    ]);
  });

  test("只在 beforeEach 调 mockClear 或在无关辅助函数调 mockRestore 仍算未按规恢复", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { beforeEach, spyOn, test } from "bun:test";',
        "const target = { fn: (): number => 1 };",
        'const s = spyOn(target, "fn");',
        "beforeEach(() => { s.mockClear(); });",
        "function unusedHelper(): void { s.mockRestore(); }",
        'test("ok", () => { s(); unusedHelper(); });',
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([
      spyProblem("a.test.ts:3:11", "top-level", "s"),
    ]);
  });

  test("顶层 spyOn 在同文件 afterAll（含数组循环与传递辅助函数）恢复，与用例内局部 spyOn 均放行", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { afterAll, describe, spyOn, test } from "bun:test";',
        "const target = { a: (): number => 1, b: (): number => 2, c: (): number => 3 };",
        'const spyA = spyOn(target, "a");',
        'const spyB = spyOn(target, "b");',
        "function restoreB(): void { spyB.mockRestore(); }",
        'describe("suite", () => {',
        '  const spyC = spyOn(target, "c");',
        "  afterAll(() => { for (const entry of [spyC]) entry.mockRestore(); });",
        "});",
        "afterAll(() => { spyA.mockRestore(); restoreB(); });",
        'test("local spy exempt", () => {',
        "  const local = { run: (): number => 4 };",
        '  spyOn(local, "run");',
        "});",
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([]);
  });

  test("识别柯里化 describe.each/skipIf、jest.spyOn 与字符串属性名解构", async () => {
    const problems: readonly string[] = await problemsFor({
      "helper.ts": [
        'import { mock } from "bun:test";',
        "export const send = mock((): number => 1);",
        "",
      ].join("\n"),
      "a.test.ts": [
        'import { beforeEach, describe, jest, test } from "bun:test";',
        "const target = { fn: (): number => 1 };",
        'describe.each([[1]])("row %d", () => {',
        '  const s = jest.spyOn(target, "fn");',
        '  test("unrestored", () => { s(); });',
        "});",
        'describe.skipIf(false)("skipped", () => {',
        '  const s2 = jest.spyOn(target, "fn");',
        '  test("unrestored2", () => { s2(); });',
        "});",
        'test("literal binding", async () => {',
        '  const { "send": aliased } = await import("./helper");',
        "  aliased.mockReturnValueOnce(2);",
        "});",
        "beforeEach(async () => {",
        '  const { "send": aliased } = await import("./helper");',
        "  aliased.mockClear();",
        "});",
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([
      "a.test.ts:17:3: send is reset with mockClear() but queues *Once values (a.test.ts:13:3); reset it with mockReset() and reinstall its default implementation",
      spyProblem("a.test.ts:4:13", "top-level", "s"),
      spyProblem("a.test.ts:8:14", "top-level", "s2"),
    ]);
  });

  test("mock.restore() 可恢复同作用域顶层 spyOn，子 describe 钩子不能替模块顶层恢复，非 .test 辅助文件顶层 spyOn 同样受检", async () => {
    const problems: readonly string[] = await problemsFor({
      "sharedHelper.ts": [
        'import { spyOn } from "bun:test";',
        "const target = { leaked: (): number => 1 };",
        'export const leakedSpy = spyOn(target, "leaked");',
        "",
      ].join("\n"),
      "a.test.ts": [
        'import { afterAll, describe, mock, spyOn, test } from "bun:test";',
        "const target = { top: (): number => 1, ok: (): number => 2 };",
        'const topSpy = spyOn(target, "top");',
        'describe("nested", () => {',
        "  afterAll(() => { topSpy.mockRestore(); });",
        '  const okSpy = spyOn(target, "ok");',
        "  afterAll(() => { mock.restore(); });",
        '  test("use", () => { okSpy(); });',
        "});",
        'test("use top", () => { topSpy(); });',
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([
      spyProblem("a.test.ts:3:16", "top-level", "topSpy"),
      spyProblem("sharedHelper.ts:3:26", "top-level", "leakedSpy"),
    ]);
  });

  test("顶层与 beforeAll 创建的监听只在 afterEach 还原时报出：第一个用例后监听就被撤掉", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { afterEach, beforeAll, spyOn, test } from "bun:test";',
        "const target = { top: (): number => 1, setup: (): number => 2 };",
        'const topSpy = spyOn(target, "top");',
        "let setupSpy: ReturnType<typeof spyOn> | undefined;",
        'beforeAll(() => { setupSpy = spyOn(target, "setup"); });',
        "afterEach(() => { topSpy.mockRestore(); setupSpy?.mockRestore(); });",
        'test("use", () => { topSpy(); });',
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([
      spyProblem("a.test.ts:3:16", "top-level", "topSpy"),
      spyProblem("a.test.ts:5:30", "beforeAll", "setupSpy"),
    ]);
  });

  test("准备钩子引用的具名函数与 test/ 辅助函数里的监听同样受检，同一钩子内创建并还原的监听放行", async () => {
    const problems: readonly string[] = await problemsFor({
      "spyHelper.ts": [
        'import { spyOn } from "bun:test";',
        "export function installHelperSpy(target: { h: () => number }): void {",
        '  spyOn(target, "h");',
        "}",
        "",
      ].join("\n"),
      "a.test.ts": [
        'import { afterEach, beforeEach, describe, spyOn, test } from "bun:test";',
        'import { installHelperSpy } from "./spyHelper";',
        "const target = { a: (): number => 1, b: (): number => 2, c: (): number => 3, h: (): number => 4 };",
        "let aSpy: ReturnType<typeof spyOn> | undefined;",
        'function installA(): void { aSpy = spyOn(target, "a"); }',
        'function installB(): void { spyOn(target, "b"); }',
        'describe("restored", () => {',
        "  beforeEach(installA);",
        "  afterEach(() => { aSpy?.mockRestore(); });",
        '  test("use", () => { target.a(); });',
        "});",
        'describe("leaked", () => {',
        "  beforeEach(installB);",
        "  beforeEach(() => { installHelperSpy(target); });",
        '  test("use", () => { target.b(); });',
        "});",
        'describe("setup-only", () => {',
        "  beforeEach(() => {",
        '    const quiet = spyOn(target, "c");',
        "    target.c();",
        "    quiet.mockRestore();",
        "  });",
        '  test("use", () => { target.c(); });',
        "});",
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([
      spyProblem("a.test.ts:6:29", "beforeEach", "spyOn(...)"),
      spyProblem("spyHelper.ts:3:3", "beforeEach", "spyOn(...)"),
    ]);
  });

  test("beforeEach 创建的监听在 afterEach 或 afterAll 还原（含 jest.restoreAllMocks）放行，未还原时报出", async () => {
    const problems: readonly string[] = await problemsFor({
      "a.test.ts": [
        'import { afterAll, afterEach, beforeAll, beforeEach, describe, jest, spyOn, test } from "bun:test";',
        "const target = { a: (): number => 1, b: (): number => 2, c: (): number => 3, d: (): number => 4 };",
        'describe("each", () => {',
        '  beforeEach(() => { spyOn(target, "a").mockImplementation((): number => 0); });',
        "  afterEach(() => { jest.restoreAllMocks(); });",
        '  test("use", () => { target.a(); });',
        "});",
        'describe("all", () => {',
        '  beforeAll(() => { spyOn(target, "b"); });',
        '  beforeEach(() => { spyOn(target, "c"); });',
        "  afterAll(() => { jest.restoreAllMocks(); });",
        '  test("use", () => { target.b(); target.c(); });',
        "});",
        'describe("leak", () => {',
        '  beforeEach(() => { spyOn(target, "d"); });',
        '  test("use", () => { target.d(); });',
        "});",
        "",
      ].join("\n"),
    });
    expect(problems).toEqual([
      spyProblem("a.test.ts:15:22", "beforeEach", "spyOn(...)"),
    ]);
  });
});
