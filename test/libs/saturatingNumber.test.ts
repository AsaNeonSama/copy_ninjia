import { describe, expect, test } from "bun:test";
import { saturatingSafeIntegerAdd } from "../../packages/libs/saturatingNumber";

const MAX: number = Number.MAX_SAFE_INTEGER;

describe("saturatingSafeIntegerAdd：非负安全整数饱和累加", () => {
  test("未触顶时就是普通加法", () => {
    expect(saturatingSafeIntegerAdd(0, 0)).toBe(0);
    expect(saturatingSafeIntegerAdd(2, 3)).toBe(5);
    expect(saturatingSafeIntegerAdd(0, 17)).toBe(17);
    expect(saturatingSafeIntegerAdd(17, 0)).toBe(17);
  });

  test("和恰好比上限小 1 时仍是精确结果", () => {
    expect(saturatingSafeIntegerAdd(MAX - 10, 9)).toBe(MAX - 1);
    expect(saturatingSafeIntegerAdd(9, MAX - 10)).toBe(MAX - 1);
  });

  test("和恰好等于上限时得到上限", () => {
    expect(saturatingSafeIntegerAdd(MAX - 1, 1)).toBe(MAX);
    expect(saturatingSafeIntegerAdd(0, MAX)).toBe(MAX);
    expect(saturatingSafeIntegerAdd(MAX, 0)).toBe(MAX);
  });

  test("超过上限时停在上限，结果仍是安全整数", () => {
    const results: readonly number[] = [
      saturatingSafeIntegerAdd(MAX, 1),
      saturatingSafeIntegerAdd(MAX - 1, 2),
      saturatingSafeIntegerAdd(MAX, MAX),
      saturatingSafeIntegerAdd(1, MAX),
    ];

    expect(results).toEqual([MAX, MAX, MAX, MAX]);
    for (const result of results) expect(Number.isSafeInteger(result)).toBeTrue();
  });

  test("反复累加到顶后保持在上限", () => {
    let total: number = MAX - 5;
    for (let step: number = 0; step < 4; step += 1) total = saturatingSafeIntegerAdd(total, 3);

    expect(total).toBe(MAX);
  });
});
