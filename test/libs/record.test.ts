import { describe, expect, test } from "bun:test";
import { retainOnlyKeys } from "../../packages/libs/record";

describe("retainOnlyKeys", () => {
  test("保留 keep 中的键，删除多余条目且不改保留项的值", () => {
    const first: { readonly value: number } = { value: 1 };
    const third: { readonly value: number } = { value: 3 };
    const map: Map<string, { readonly value: number }> = new Map<string, { readonly value: number }>([
      ["a", first],
      ["b", { value: 2 }],
      ["c", third],
    ]);

    retainOnlyKeys(map, new Set<string>(["a", "c", "missing"]));

    expect([...map.keys()]).toEqual(["a", "c"]);
    expect(map.get("a")).toBe(first);
    expect(map.get("c")).toBe(third);
  });

  test("keep 为空集合时清空全部条目", () => {
    const map: Map<number, string> = new Map<number, string>([
      [1, "one"],
      [2, "two"],
    ]);

    retainOnlyKeys(map, new Set<number>());

    expect(map.size).toBe(0);
  });
});
