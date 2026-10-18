import { describe, expect, test } from "bun:test";
import { FifoMap } from "../../packages/libs/fifoMap";

function filled(keys: readonly string[], maxEntries: number = 10): FifoMap<string, number> {
  const map = new FifoMap<string, number>(maxEntries);
  for (const [index, key] of keys.entries()) map.set(key, index);
  return map;
}

describe("FifoMap 插入序与容量", () => {
  test("迭代按插入顺序，从最早到最新", () => {
    const map: FifoMap<string, number> = filled(["a", "b", "c"]);
    expect([...map]).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect([...map.keys()]).toEqual(["a", "b", "c"]);
    expect([...map.values()]).toEqual([0, 1, 2]);
    expect([...map.entries()]).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    const visited: string[] = [];
    map.forEach((value: number, key: string): void => {
      visited.push(`${key}=${value}`);
    });
    expect(visited).toEqual(["a=0", "b=1", "c=2"]);
    expect(map.oldestKey()).toBe("a");
    expect(map.size).toBe(3);
  });

  test("写已有键只改值、不移位，也不触发淘汰；get / has 不改变顺序", () => {
    const map: FifoMap<string, number> = filled(["a", "b", "c"], 3);
    map.set("a", 9);
    expect(map.get("b")).toBe(1);
    expect(map.has("c")).toBeTrue();
    expect([...map]).toEqual([["a", 9], ["b", 1], ["c", 2]]);
    expect(map.oldestKey()).toBe("a");
  });

  test("满载写入新键先淘汰最早项；先删再写把已有键挪到最新端", () => {
    const map: FifoMap<string, number> = filled(["a", "b", "c"], 3);
    map.set("d", 3);
    expect([...map.keys()]).toEqual(["b", "c", "d"]);
    expect(map.has("a")).toBeFalse();
    map.delete("b");
    map.set("b", 4);
    expect([...map.keys()]).toEqual(["c", "d", "b"]);
    map.set("e", 5);
    expect([...map.keys()]).toEqual(["d", "b", "e"]);
    expect(map.size).toBe(3);
  });

  test("大量写入后容量恒定，最早项始终是最旧的那一个", () => {
    const map = new FifoMap<number, number>(1_000);
    for (let index: number = 0; index < 10_000; index++) map.set(index, index);
    expect(map.size).toBe(1_000);
    expect(map.oldestKey()).toBe(9_000);
    expect(map.get(8_999)).toBeUndefined();
    expect(map.get(9_999)).toBe(9_999);
  });

  test("删除首、中、尾各位置后链表与 Map 一致", () => {
    const map: FifoMap<string, number> = filled(["a", "b", "c", "d", "e"]);
    expect(map.delete("a")).toBeTrue();
    expect(map.delete("c")).toBeTrue();
    expect(map.delete("e")).toBeTrue();
    expect(map.delete("missing")).toBeFalse();
    expect([...map.keys()]).toEqual(["b", "d"]);
    expect(map.oldestKey()).toBe("b");
    map.set("f", 5);
    expect([...map.keys()]).toEqual(["b", "d", "f"]);
  });

  test("迭代中删除当前项不跳项、不重复", () => {
    for (const mode of ["keys", "entries", "values", "forEach"] as const) {
      const map: FifoMap<string, number> = filled(["a", "b", "c", "d"]);
      const seen: string[] = [];
      if (mode === "keys") {
        for (const key of map.keys()) {
          seen.push(key);
          if (key !== "c") map.delete(key);
        }
      } else if (mode === "entries") {
        for (const [key] of map) {
          seen.push(key);
          if (key !== "c") map.delete(key);
        }
      } else if (mode === "values") {
        const keys: readonly string[] = ["a", "b", "c", "d"];
        for (const value of map.values()) {
          const key: string = keys[value]!;
          seen.push(key);
          if (key !== "c") map.delete(key);
        }
      } else {
        map.forEach((_value: number, key: string): void => {
          seen.push(key);
          if (key !== "c") map.delete(key);
        });
      }
      expect(seen).toEqual(["a", "b", "c", "d"]);
      expect([...map.keys()]).toEqual(["c"]);
      expect(map.oldestKey()).toBe("c");
    }
  });

  test("clear 清空后可继续写入；空表 oldestKey 为 undefined", () => {
    const map: FifoMap<string, number> = filled(["a", "b"]);
    map.clear();
    expect(map.size).toBe(0);
    expect(map.oldestKey()).toBeUndefined();
    expect([...map]).toEqual([]);
    map.set("c", 1);
    expect([...map]).toEqual([["c", 1]]);
  });

  test("存 undefined 值的键仍然存在；拒绝非法容量", () => {
    const map = new FifoMap<string, number | undefined>(2);
    map.set("a", undefined);
    expect(map.has("a")).toBeTrue();
    expect(map.get("a")).toBeUndefined();
    expect(map.size).toBe(1);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new FifoMap(invalid)).toThrow(RangeError);
    }
  });
});
