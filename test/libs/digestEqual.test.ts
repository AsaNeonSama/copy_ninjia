import { describe, expect, test } from "bun:test";
import { timingSafeStringEqual } from "../../packages/libs/digestEqual";

describe("timingSafeStringEqual", () => {
  test("相同字符串返回 true，不同内容或不同长度的字符串返回 false", () => {
    expect(timingSafeStringEqual("", "")).toBeTrue();
    expect(timingSafeStringEqual("123456", "123456")).toBeTrue();
    expect(timingSafeStringEqual("123456", "123457")).toBeFalse();
    expect(timingSafeStringEqual("short", "longer-string")).toBeFalse();
    expect(timingSafeStringEqual("prefix", "prefix-extra")).toBeFalse();
  });

  test("多字节 UTF-8 字符按完整 UTF-8 编码摘要比对", () => {
    expect(timingSafeStringEqual("早安杂鱼♡🌸", "早安杂鱼♡🌸")).toBeTrue();
    expect(timingSafeStringEqual("早安杂鱼♡🌸", "早安杂鱼♡🌺")).toBeFalse();
    // 组合字符形式（e + 组合重音符）与预组合字符（é）的 UTF-8 字节不同，不应误判相等。
    expect(timingSafeStringEqual("e\u0301", "\u00e9")).toBeFalse();
  });
});
