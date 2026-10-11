import { describe, expect, test } from "bun:test";
import { isErrno } from "../../packages/libs/errno";

/** 构造一个带 code 字段的 Error 夹具。 */
function errorWithCode(code: unknown): Error {
  return Object.assign(new Error("夹具错误"), { code });
}

describe("isErrno：按系统错误码收窄", () => {
  test("Bun 读取不存在的文件抛出的真实系统错误按 ENOENT 命中", async () => {
    let caught: unknown;
    try {
      await Bun.file("/nonexistent-copy-ninjia-errno-test/missing.txt").text();
    } catch (error: unknown) {
      caught = error;
    }

    expect(isErrno(caught, "ENOENT")).toBeTrue();
    expect(isErrno(caught, "EACCES")).toBeFalse();
  });

  test("code 完全相等才命中，大小写与类型都不放宽", () => {
    expect(isErrno(errorWithCode("EEXIST"), "EEXIST")).toBeTrue();
    expect(isErrno(errorWithCode("EEXIST"), "ENOENT")).toBeFalse();
    expect(isErrno(errorWithCode("eexist"), "EEXIST")).toBeFalse();
    expect(isErrno(errorWithCode(17), "17")).toBeFalse();
  });

  test("Error 子类同样按 code 判定", () => {
    const error: TypeError = Object.assign(new TypeError("夹具"), { code: "ERR_INVALID_ARG_TYPE" });

    expect(isErrno(error, "ERR_INVALID_ARG_TYPE")).toBeTrue();
  });

  test("没有 code 字段的 Error 不命中", () => {
    expect(isErrno(new Error("ENOENT: no such file"), "ENOENT")).toBeFalse();
  });

  test("不是 Error 实例时即使带同名 code 也不命中", () => {
    const values: readonly unknown[] = [{ code: "ENOENT" }, "ENOENT", null, undefined, 2];
    for (const value of values) expect(isErrno(value, "ENOENT")).toBeFalse();
  });
});
