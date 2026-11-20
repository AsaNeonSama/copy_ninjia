/** 测试断言常量取值与常量文案片段门禁（`testAssertions.ts` / `testAssertionFragments.ts`）测试。 */
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  collectConstantValueAssertionProblems,
  collectExportedStringConstants,
  collectStringConstantAssertionProblems,
} from "../../scripts/conventions/testAssertions";
import {
  CONSTANT_TEXT_CONTRACT_EXEMPTIONS,
  collectConstantTextFragmentAssertionProblems,
  collectConstantTextFragments,
  collectUnusedConstantTextExemptionProblems,
  constantTextCorpus,
} from "../../scripts/conventions/testAssertionFragments";

function source(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("测试断言取值口径", () => {
  test("拒绝把导入常量直接与字面量常量比对，静态与动态导入及各类字面量都算", () => {
    const path: string = "/project/test/sample.test.ts";
    const problems: readonly string[] = collectConstantValueAssertionProblems({
      projectRoot: "/project",
      path,
      source: source(path, [
        'import { ENABLED, ITEMS, LABEL, LIMIT_MAX, META } from "../packages/consts/sample";',
        'const { WINDOW_MS } = await import("../packages/consts/window");',
        "expect(LIMIT_MAX).toBe(8);",
        "expect(WINDOW_MS).toEqual(3 * 60_000);",
        "expect(LIMIT_MAX).toStrictEqual(-(1));",
        'expect(LABEL).toBe("label");',
        'expect(ITEMS).toEqual(["a", "b"]);',
        "expect(META).toEqual({ ok: true });",
        "expect(ENABLED).toBe(true);",
      ].join("\n")),
    });
    expect(problems).toEqual([
      expect.stringContaining("test/sample.test.ts:3 asserts imported constant LIMIT_MAX against a literal"),
      expect.stringContaining("test/sample.test.ts:4 asserts imported constant WINDOW_MS against a literal"),
      expect.stringContaining("test/sample.test.ts:5 asserts imported constant LIMIT_MAX against a literal"),
      expect.stringContaining("test/sample.test.ts:6 asserts imported constant LABEL against a literal"),
      expect.stringContaining("test/sample.test.ts:7 asserts imported constant ITEMS against a literal"),
      expect.stringContaining("test/sample.test.ts:8 asserts imported constant META against a literal"),
      expect.stringContaining("test/sample.test.ts:9 asserts imported constant ENABLED against a literal"),
    ]);
  });

  test("放过本文件夹具常量与由常量或行为推导的期望", () => {
    const path: string = "/project/test/sample.test.ts";
    expect(collectConstantValueAssertionProblems({
      projectRoot: "/project",
      path,
      source: source(path, [
        'import { LIMIT_MAX, LABEL } from "../packages/consts/sample";',
        "const LOCAL_FIXTURE: number = 3;",
        "expect(LOCAL_FIXTURE).toBe(3);",
        "expect(LABEL).toBe(computeLabel());",
        "expect(LIMIT_MAX).toBe(LIMIT_MAX);",
        "expect(LIMIT_MAX).toBeGreaterThan(1);",
        "expect(limit).toBe(8);",
      ].join("\n")),
    })).toEqual([]);
  });

  test("收集 consts 导出的字符串常量：拼接取值、同值多名都记下，未导出与过短的不收", () => {
    const constants: Map<string, string[]> = new Map<string, string[]>();
    collectExportedStringConstants(source("/project/packages/consts/sample.ts", [
      'export const TOOL_NAME: string = "fixture_tool";',
      'export const ALIAS_NAME: string = "fixture_" + `tool`;',
      'export const SHORT: string = "short";',
      'const PRIVATE_LABEL: string = "private label";',
      "export const LIMIT: number = 12_345_678;",
    ].join("\n")), constants);
    expect([...constants]).toEqual([["fixture_tool", ["TOOL_NAME", "ALIAS_NAME"]]]);
  });

  test("拒绝匹配器实参里与 consts 字符串常量逐字相同的字面量，嵌套与 not/resolves 链都算", () => {
    const path: string = "/project/test/sample.test.ts";
    const constants: ReadonlyMap<string, readonly string[]> = new Map([
      ["fixture_tool", ["TOOL_NAME"]],
      ["Asia/Fixture", ["ZONE_A", "ZONE_B"]],
    ]);
    const problems: readonly string[] = collectStringConstantAssertionProblems({
      projectRoot: "/project",
      path,
      constants,
      source: source(path, [
        'expect(definition.name).toBe("fixture_tool");',
        'expect(call).toHaveBeenCalledWith(expect.objectContaining({ zone: "Asia/Fixture" }));',
        'expect(names).not.toContain("fixture_tool");',
        'await expect(pending).resolves.toEqual(["fixture_tool"]);',
      ].join("\n")),
    });
    expect(problems).toEqual([
      expect.stringContaining("test/sample.test.ts:1 asserts a string literal equal to TOOL_NAME"),
      expect.stringContaining("test/sample.test.ts:2 asserts a string literal equal to ZONE_A / ZONE_B"),
      expect.stringContaining("test/sample.test.ts:3 asserts a string literal equal to TOOL_NAME"),
      expect.stringContaining("test/sample.test.ts:4 asserts a string literal equal to TOOL_NAME"),
    ]);
  });

  test("放过本文件夹具原样透传的字面量、常量引用与匹配器之外的用法；describe/test/it 标题不豁免断言字面量", () => {
    const path: string = "/project/test/sample.test.ts";
    expect(collectStringConstantAssertionProblems({
      projectRoot: "/project",
      path,
      constants: new Map([["fixture_tool", ["TOOL_NAME"]], ["audio/fixture", ["MIME"]]]),
      source: source(path, [
        'const input = { mime: "audio/fixture" };',
        'expect(normalize(input).mime).toBe("audio/fixture");',
        "expect(definition.name).toBe(TOOL_NAME);",
        'register("fixture_tool");',
        'expect(parse("fixture_tool")).toBe(true);',
        'test.each(["audio/fixture"])("each 夹具表仍放行 %s", (mime: string) => {',
        '  expect(mime).toBe("audio/fixture");',
        "});",
      ].join("\n")),
    })).toEqual([]);

    expect(collectStringConstantAssertionProblems({
      projectRoot: "/project",
      path,
      constants: new Map([["fixture_tool", ["TOOL_NAME"]], ["audio/fixture", ["MIME"]]]),
      source: source(path, [
        'describe("fixture_tool", () => {',
        '  test("audio/fixture", () => {',
        '    expect(definition.name).toBe("fixture_tool");',
        '    expect(result.mime).toBe("audio/fixture");',
        "  });",
        '  test.each([1])("fixture_tool", () => {',
        '    expect(definition.name).toBe("fixture_tool");',
        "  });",
        '  it.skipIf(false)("audio/fixture", () => {',
        '    expect(result.mime).toBe("audio/fixture");',
        "  });",
        "});",
      ].join("\n")),
    })).toEqual([
      expect.stringContaining("test/sample.test.ts:3 asserts a string literal equal to TOOL_NAME"),
      expect.stringContaining("test/sample.test.ts:4 asserts a string literal equal to MIME"),
      expect.stringContaining("test/sample.test.ts:7 asserts a string literal equal to TOOL_NAME"),
      expect.stringContaining("test/sample.test.ts:10 asserts a string literal equal to MIME"),
    ]);
  });
});

describe("测试断言不得抄写常量文案片段", () => {
  /** 一个 consts 文件的文案语料：普通字面量、对象字段与模板静态片段都收。 */
  function corpusOf(text: string): string {
    const fragments: string[] = [];
    collectConstantTextFragments(source("/project/packages/consts/sample.ts", text), fragments);
    return constantTextCorpus(fragments);
  }

  const CORPUS: string = corpusOf([
    'export const NOTICE: string = "本天才已经把这条消息删掉啦";',
    "export const TEXTS = { done: (label: string): string => `${label} 的权限本来就是全开的，笨蛋` };",
    "export const REPORT = (failed: number): string => `查询或请求失败 ${failed}`;",
  ].join("\n"));

  test("匹配器实参里含六个以上汉字的常量文案子串都算，插值渲染文案、模板静态片段、标题复用与嵌套匹配器同样拦下", () => {
    const path: string = "/project/test/sample.test.ts";
    const problems: readonly string[] = collectConstantTextFragmentAssertionProblems({
      projectRoot: "/project",
      path,
      corpus: CORPUS,
      usedExemptions: new Set<string>(),
      source: source(path, [
        'test("已经把这条消息删掉", () => {',
        '  expect(text).toContain("已经把这条消息删掉");',
        '  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("本来就是全开的") }));',
        "  expect(text).not.toContain(`${label} 的权限本来就是全开的`);",
        '  expect(text).toContain("查询或请求失败 2");',
        "});",
      ].join("\n")),
    });
    expect(problems).toEqual([
      expect.stringContaining("test/sample.test.ts:2 asserts text copied from packages/consts"),
      expect.stringContaining("test/sample.test.ts:3 asserts text copied from packages/consts"),
      expect.stringContaining("test/sample.test.ts:4 asserts text copied from packages/consts"),
      expect.stringContaining("test/sample.test.ts:5 asserts text copied from packages/consts"),
    ]);
  });

  test("放过不足六个汉字的片段、本文件夹具原样透传的文案与语料里没有的文字", () => {
    const path: string = "/project/test/sample.test.ts";
    expect(collectConstantTextFragmentAssertionProblems({
      projectRoot: "/project",
      path,
      corpus: CORPUS,
      usedExemptions: new Set<string>(),
      source: source(path, [
        'const input: string = "本天才已经把这条消息删掉啦";',
        'test("回执", () => {',
        '  expect(echo(input)).toBe("本天才已经把这条消息删掉啦");',
        '  expect(text).toContain("本天才");',
        '  expect(text).toContain("本天才 2 笨蛋");',
        "  expect(text).toContain(`本天才 ${label} 笨蛋`);",
        '  expect(text).toContain("测试自己写的一整句夹具文字");',
        '  register("已经把这条消息删掉");',
        "});",
      ].join("\n")),
    })).toEqual([]);
  });

  test("豁免表里的契约用例按文件与用例名放行并记为已用；没被用到的豁免逐条报出", () => {
    const exemption = CONSTANT_TEXT_CONTRACT_EXEMPTIONS[0]!;
    const title: string = exemption.tests[0]!;
    const path: string = `/project/${exemption.path}`;
    const used: Set<string> = new Set<string>();
    expect(collectConstantTextFragmentAssertionProblems({
      projectRoot: "/project",
      path,
      corpus: CORPUS,
      usedExemptions: used,
      source: source(path, [
        `test(${JSON.stringify(title)}, () => {`,
        '  expect(prompt).toContain("已经把这条消息删掉");',
        "});",
        'test("同文件里的普通用例", () => {',
        '  expect(prompt).toContain("已经把这条消息删掉");',
        "});",
      ].join("\n")),
    })).toEqual([expect.stringContaining(`${exemption.path}:5 asserts text copied`)]);
    expect([...used]).toEqual([`${exemption.path}::${title}`]);

    const unused: readonly string[] = collectUnusedConstantTextExemptionProblems(used);
    const exemptTitleCount: number = CONSTANT_TEXT_CONTRACT_EXEMPTIONS
      .reduce((count: number, entry): number => count + entry.tests.length, 0);
    expect(unused).toHaveLength(exemptTitleCount - 1);
    expect(unused.some((problem: string): boolean => problem.includes(title))).toBeFalse();
  });
});
