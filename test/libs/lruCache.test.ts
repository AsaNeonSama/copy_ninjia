import { describe, expect, test } from "bun:test";
import { LruCache } from "../../packages/libs/lruCache";

describe("LruCache", () => {
  test("超容量淘汰最久未使用的一项", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  test("get 命中会续命，让它免于被淘汰", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  test("peek 查看不影响淘汰顺位", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.peek("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  test("set 覆盖已有键也视为一次使用", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 9);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(9);
    expect(cache.has("b")).toBe(false);
  });

  test("delete 移除条目", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.has("a")).toBe(false);
    expect(cache.delete("a")).toBe(false);
  });

  test("拒绝无效上限", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(-1)).toThrow(RangeError);
  });

  test("回归：get 命中一个值为 undefined 的键时不当成未命中，且照常续命", () => {
    const cache = new LruCache<string, number | undefined>(2);
    cache.set("a", undefined);
    cache.set("b", 2);
    expect(cache.has("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    cache.set("c", 3); // 容量满：淘汰的是最久未使用的 "b"，"a" 的 get 已续命
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  test("容量为 1 的满容节点复用及随机操作序列（含迭代中删当前项）与参照 LRU 一致", () => {
    const single = new LruCache<string, number>(1);
    single.set("a", 1);
    expect(single.get("a")).toBe(1);
    single.set("b", 2);
    expect(single.has("a")).toBe(false);
    expect([...single]).toEqual([["b", 2]]);
    expect(single.oldestKey()).toBe("b");

    let seed: number = 0x73c1_9e45;
    const nextInt = (max: number): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % max;
    };

    for (const capacity of [1, 2, 3, 7, 16]) {
      const lru = new LruCache<number, number | undefined>(capacity);
      const ref: Map<number, number | undefined> = new Map<number, number | undefined>();
      const keySpace: number = capacity * 3 + 2;

      for (let step: number = 0; step < 500; step += 1) {
        const op: number = nextInt(100);
        const key: number = nextInt(keySpace);
        if (op < 40) {
          const val: number | undefined = nextInt(10) === 0 ? undefined : step;
          lru.set(key, val);
          if (ref.has(key)) {
            ref.delete(key);
            ref.set(key, val);
          } else {
            if (ref.size >= capacity) {
              const oldest: number | undefined = ref.keys().next().value;
              if (oldest !== undefined) ref.delete(oldest);
            }
            ref.set(key, val);
          }
        } else if (op < 60) {
          const actual: number | undefined = lru.get(key);
          let expected: number | undefined;
          if (ref.has(key)) {
            expected = ref.get(key);
            ref.delete(key);
            ref.set(key, expected);
          }
          expect(actual).toBe(expected);
        } else if (op < 70) {
          expect(lru.peek(key)).toBe(ref.get(key));
        } else if (op < 78) {
          expect(lru.has(key)).toBe(ref.has(key));
        } else if (op < 88) {
          expect(lru.delete(key)).toBe(ref.delete(key));
        } else if (op < 92) {
          lru.clear();
          ref.clear();
        } else {
          const seenLru: number[] = [];
          const seenRef: number[] = [];
          const deleteMod: number = 2 + nextInt(3);
          for (const itemKey of lru.keys()) {
            seenLru.push(itemKey);
            if (itemKey % deleteMod === 0) lru.delete(itemKey);
          }
          for (const itemKey of [...ref.keys()]) {
            seenRef.push(itemKey);
            if (itemKey % deleteMod === 0) ref.delete(itemKey);
          }
          expect(seenLru).toEqual(seenRef);
        }
        expect(lru.size).toBe(ref.size);
        expect(lru.oldestKey()).toBe(ref.keys().next().value);
        if (step % 25 === 0) {
          expect([...lru.entries()]).toEqual([...ref.entries()]);
        }
      }
      expect([...lru.entries()]).toEqual([...ref.entries()]);
    }
  });
});
