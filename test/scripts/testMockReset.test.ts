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
