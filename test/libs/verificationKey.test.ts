import { describe, expect, test } from "bun:test";
import {
  parseVerificationKey,
  requireVerificationKey,
  verificationKey,
  verificationKeyPrefix,
  verificationKeySuffix,
} from "../../packages/libs/verificationKey";

/**
 * `chatId:userId` 复合键的生成/解析/归属判定。
 *
 * 本文件是格式的唯一契约点：往返一致、负数群 id 不被负号误切、形状不符一律 null
 * （调用方据此丢弃，不拿 NaN 继续投递）。
 */
describe("待验证复合键", () => {
  test("生成与解析往返一致，负数群 id 不被负号切错", () => {
    const key: string = verificationKey(-1_001_234_567_890, 42);
    expect(key).toBe("-1001234567890:42");
    expect(parseVerificationKey(key)).toEqual({ chatId: -1_001_234_567_890, userId: 42 });
    expect(parseVerificationKey(verificationKey(-1001, 0))).toEqual({ chatId: -1001, userId: 0 });
    expect(parseVerificationKey(verificationKey(-1001, -42))).toEqual({ chatId: -1001, userId: -42 });
  });

  test("前缀与生成方同源，能挑出本群条目且不误伤别的群", () => {
    const prefix: string = verificationKeyPrefix(-1001);
    expect(verificationKey(-1001, 7).startsWith(prefix)).toBeTrue();
    // -10010 与 -1001 的前缀只差一位，分隔符使它们互不误伤。
    expect(verificationKey(-10_010, 7).startsWith(prefix)).toBeFalse();
  });

  test("后缀与生成方同源，能挑出同一用户条目且不误伤尾数相同的用户", () => {
    const suffix: string = verificationKeySuffix(42);
    expect(verificationKey(-1001, 42).endsWith(suffix)).toBeTrue();
    expect(verificationKey(-1001, 142).endsWith(suffix)).toBeFalse();
    expect(verificationKey(-1001, -42).endsWith(suffix)).toBeFalse();
    expect(verificationKey(-1001, -42).endsWith(verificationKeySuffix(-42))).toBeTrue();
  });

  test("形状不符一律 null，不交出 NaN", () => {
    expect(parseVerificationKey("nope")).toBeNull();
    expect(parseVerificationKey(":42")).toBeNull();
    expect(parseVerificationKey("-1001:")).toBeNull();
    expect(parseVerificationKey("-1001:abc")).toBeNull();
    // 超出安全整数范围的一侧同样按不可用处理。
    expect(parseVerificationKey("-1001:99999999999999999999")).toBeNull();
    // 两侧都只接受 verificationKey 会生成的规范十进制写法；`Number` 能解析的其它写法一律拒绝。
    expect(parseVerificationKey("-1001: 42")).toBeNull();
    expect(parseVerificationKey("-1001:+42")).toBeNull();
    expect(parseVerificationKey("-1001:4e1")).toBeNull();
    expect(parseVerificationKey("-1001:042")).toBeNull();
    expect(parseVerificationKey("-1001:42.0")).toBeNull();
    expect(parseVerificationKey("-1001:0x2a")).toBeNull();
    expect(parseVerificationKey("-1001:-0")).toBeNull();
    expect(parseVerificationKey("-1001:-")).toBeNull();
    expect(parseVerificationKey("-01001:42")).toBeNull();
  });

  test("本线程生成的键按不变量解析，形状不符直接抛错", () => {
    expect(requireVerificationKey(verificationKey(-1001, 42))).toEqual({ chatId: -1001, userId: 42 });
    expect(() => requireVerificationKey("-1001:")).toThrow("Verification key was not produced by verificationKey: -1001:");
  });
});
