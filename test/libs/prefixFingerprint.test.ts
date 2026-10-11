import { describe, expect, test } from "bun:test";
import { stablePrefixFingerprint } from "../../packages/libs/prefixFingerprint";

/** base64url 字符集，无填充。 */
const BASE64URL_PATTERN: RegExp = /^[A-Za-z0-9_-]+$/;
/** 空输入不喂任何字节，摘要就是空串的 SHA-256 公开测试向量（base64url）。 */
const EMPTY_SHA256_BASE64URL: string = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

describe("stablePrefixFingerprint：稳定前缀指纹", () => {
  test("同一组段多次计算得到同一摘要", () => {
    const parts: readonly string[] = ["系统提示词", "{\"tools\":[]}"];

    expect(stablePrefixFingerprint(parts)).toBe(stablePrefixFingerprint([...parts]));
  });

  test("没有任何段时等于空串的 SHA-256", () => {
    expect(stablePrefixFingerprint([])).toBe(EMPTY_SHA256_BASE64URL);
  });

  test("输出为无填充的 base64url，长度与输入规模无关", () => {
    const short: string = stablePrefixFingerprint(["a"]);
    const long: string = stablePrefixFingerprint(["x".repeat(100_000), "y".repeat(50_000), "z"]);

    expect(short).toMatch(BASE64URL_PATTERN);
    expect(long).toMatch(BASE64URL_PATTERN);
    expect(long.length).toBe(short.length);
    expect(short.length).toBe(EMPTY_SHA256_BASE64URL.length);
  });

  test("段边界参与摘要：拼接结果相同但切分不同的输入互不相等", () => {
    expect(stablePrefixFingerprint(["ab", "c"])).not.toBe(stablePrefixFingerprint(["a", "bc"]));
    expect(stablePrefixFingerprint(["abc"])).not.toBe(stablePrefixFingerprint(["a", "b", "c"]));
  });

  test("空段也算一段：只差空段的各种切分互不相等", () => {
    const fingerprints: ReadonlySet<string> = new Set([
      stablePrefixFingerprint([]),
      stablePrefixFingerprint([""]),
      stablePrefixFingerprint(["", ""]),
      stablePrefixFingerprint(["a"]),
      stablePrefixFingerprint(["a", ""]),
    ]);

    expect(fingerprints.size).toBe(5);
  });

  test("顺序即语义：交换段的顺序得到不同摘要", () => {
    expect(stablePrefixFingerprint(["人设", "工具"])).not.toBe(stablePrefixFingerprint(["工具", "人设"]));
  });

  test("任一段改动一个字符即改变摘要", () => {
    expect(stablePrefixFingerprint(["人设", "工具A"])).not.toBe(stablePrefixFingerprint(["人设", "工具B"]));
  });
});
