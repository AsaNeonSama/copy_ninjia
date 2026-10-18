import { describe, expect, test } from "bun:test";
import { stablePrefixFingerprint, stablePrefixFingerprintWithSlot } from "../../packages/libs/prefixFingerprint";
import type { PrefixHasherSlot } from "../../packages/types/prefixFingerprint";

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

describe("stablePrefixFingerprintWithSlot：前缀哈希状态单槽", () => {
  test("命中与失配两条路径的摘要都等于对全部分段直接哈希", () => {
    const holder: { current: PrefixHasherSlot | null } = { current: null };
    const systemPrompt: string = "人设".repeat(5_000);
    const toolsJson: string = JSON.stringify([{ name: "send_message" }]);
    const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
      [[systemPrompt, toolsJson], ["群甲参考记忆"]],
      // 内容相等但不是同一个字符串对象：仍命中。
      [[`${"人设".repeat(4_999)}人设`, toolsJson.slice()], ["群乙参考记忆"]],
      [[systemPrompt, toolsJson], []],
      [[systemPrompt, toolsJson], ["群甲参考记忆", "第二段"]],
      // 工具声明变化：失配重建。
      [[systemPrompt, JSON.stringify([])], ["群甲参考记忆"]],
      [[systemPrompt], [toolsJson, "群甲参考记忆"]],
      [[], ["只有尾段"]],
    ];
    for (const [head, tail] of cases) {
      expect(stablePrefixFingerprintWithSlot(holder, head, tail)).toBe(stablePrefixFingerprint([...head, ...tail]));
      expect(holder.current?.head).toEqual(head);
    }
  });

  test("命中时复用同一份哈希状态，且该状态不被尾段污染", () => {
    const holder: { current: PrefixHasherSlot | null } = { current: null };
    const head: readonly string[] = ["系统提示词", "工具"];
    const first: string = stablePrefixFingerprintWithSlot(holder, head, ["甲"]);
    const slot: PrefixHasherSlot | null = holder.current;
    stablePrefixFingerprintWithSlot(holder, [...head], ["乙"]);
    expect(holder.current).toBe(slot);
    expect(stablePrefixFingerprintWithSlot(holder, head, ["甲"])).toBe(first);
  });
});
