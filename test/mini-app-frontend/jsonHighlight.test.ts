/**
 * Mini App JSON 词法高亮分词、精确行列语法定位与格式化单元测试。
 */

import { describe, expect, test } from "bun:test";
import {
  formatJsonPretty,
  tokenizeJsonForHighlight,
  validateJsonSyntax,
} from "../../packages/mini-app-frontend/libs/jsonHighlight";
import type {
  JsonHighlightToken,
  JsonSyntaxValidationResult,
} from "../../packages/mini-app-frontend/types/miniApp";

describe("JSON 词法高亮分词、精确行列语法定位与美化", () => {
  test("tokenizeJsonForHighlight 覆盖全部语法类别且与原文本逐字符恒等", () => {
    const sample: string =
      '{\n  "name": "doro\\n\\u0041",\n  "port": -8080.5e+2,\n  "enabled": true,\n  "extra": [false, null]\n}\n';
    const tokens: readonly Readonly<JsonHighlightToken>[] =
      tokenizeJsonForHighlight(sample);
    expect(
      tokens.map((tok: Readonly<JsonHighlightToken>): string => tok.text).join("")
    ).toBe(sample);

    const byKind = (kind: JsonHighlightToken["kind"]): string[] =>
      tokens
        .filter((tok: Readonly<JsonHighlightToken>): boolean => tok.kind === kind)
        .map((tok: Readonly<JsonHighlightToken>): string => tok.text);

    expect(byKind("key")).toEqual(['"name"', '"port"', '"enabled"', '"extra"']);
    expect(byKind("string")).toEqual(['"doro\\n\\u0041"']);
    expect(byKind("number")).toEqual(["-8080.5e+2"]);
    expect(byKind("boolean")).toEqual(["true", "false"]);
    expect(byKind("null")).toEqual(["null"]);
    expect(byKind("brace")).toEqual(["{", "[", "]", "}"]);
    expect(byKind("punct")).toEqual([":", ",", ":", ",", ":", ",", ":", ","]);
    expect(byKind("invalid")).toEqual([]);

    // 非法转义、未闭合字符串、前导零数值与裸标识符归入 invalid 且不丢失换行结构。
    const broken: string = '{"bad": "\\q", "num": 012, "unclosed: 1\n  bareword}';
    const brokenTokens: readonly Readonly<JsonHighlightToken>[] =
      tokenizeJsonForHighlight(broken);
    expect(
      brokenTokens
        .map((tok: Readonly<JsonHighlightToken>): string => tok.text)
        .join("")
    ).toBe(broken);
    expect(
      brokenTokens
        .filter((tok: Readonly<JsonHighlightToken>): boolean => tok.kind === "invalid")
        .map((tok: Readonly<JsonHighlightToken>): string => tok.text)
    ).toEqual(['"\\q"', "012", '"unclosed: 1', "bareword"]);
  });

  test("validateJsonSyntax 精确计算跨引擎一致的 1 起始错误行列号，formatJsonPretty 按 2 空格格式化", () => {
    const emptyRes: Readonly<JsonSyntaxValidationResult> =
      validateJsonSyntax("   \n  ");
    expect(emptyRes.ok).toBeFalse();
    if (!emptyRes.ok) {
      expect(emptyRes.empty).toBeTrue();
      expect(emptyRes.line).toBe(1);
    }

    expect(validateJsonSyntax('{"ok": [1, true, null]}').ok).toBeTrue();

    // 第 3 行末尾多余逗号后在第 4 行闭合花括号处报错（第 4 行第 1 列）。
    const trailingComma: string = '{\n  "a": 1,\n  "b": 2,\n}';
    const commaRes: Readonly<JsonSyntaxValidationResult> =
      validateJsonSyntax(trailingComma);
    expect(commaRes.ok).toBeFalse();
    if (!commaRes.ok) {
      expect(commaRes.empty).toBeFalse();
      expect(commaRes.line).toBe(4);
      expect(commaRes.column).toBe(1);
    }

    // 第 2 行键名后缺失冒号。
    const missingColon: string = '{\n  "host" "127.0.0.1"\n}';
    const colonRes: Readonly<JsonSyntaxValidationResult> =
      validateJsonSyntax(missingColon);
    expect(colonRes.ok).toBeFalse();
    if (!colonRes.ok) {
      expect(colonRes.line).toBe(2);
      expect(colonRes.column).toBe(10);
    }

    // UTF-8 BOM 独立归入 invalid 且深度嵌套未闭合数组无调用栈溢出。
    const withBom: string = '\ufeff{"ok": true}';
    const bomTokens: readonly Readonly<JsonHighlightToken>[] =
      tokenizeJsonForHighlight(withBom);
    expect(bomTokens.map((t: Readonly<JsonHighlightToken>): string => t.text).join("")).toBe(
      withBom
    );
    expect(bomTokens[0]).toEqual({ kind: "invalid", text: "\ufeff" });
    const bomValidation: Readonly<JsonSyntaxValidationResult> =
      validateJsonSyntax(withBom);
    expect(bomValidation.ok).toBeFalse();
    if (!bomValidation.ok) {
      expect(bomValidation.line).toBe(1);
      expect(bomValidation.column).toBe(1);
    }

    const deepUnclosed: string = "[".repeat(25_000);
    const deepRes: Readonly<JsonSyntaxValidationResult> =
      validateJsonSyntax(deepUnclosed);
    expect(deepRes.ok).toBeFalse();
    if (!deepRes.ok) {
      expect(deepRes.line).toBe(1);
      expect(deepRes.column).toBe(25_001);
    }

    expect(formatJsonPretty('{"a":1,"b":[true,null]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}\n'
    );
  });
});
