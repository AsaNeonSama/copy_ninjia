import { describe, expect, test } from "bun:test";
import { sweepExpiredSnapshots } from "../../packages/libs/boundedMap";
import { FifoMap } from "../../packages/libs/fifoMap";

describe("sweepExpiredSnapshots", () => {
  test("按 TTL 淘汰过期快照，跳过仍在拉取的群，返回淘汰条数", () => {
    const snapshots = new FifoMap<number, { readonly fetchedAt: number }>(10);
    snapshots.set(-1, { fetchedAt: 0 });
    snapshots.set(-2, { fetchedAt: 0 });
    snapshots.set(-3, { fetchedAt: 900 });
    const inFlight: ReadonlyMap<number, unknown> = new Map([[-2, Promise.resolve()]]);
    expect(sweepExpiredSnapshots({ snapshots, inFlight, ttlMs: 500, now: 1_000 })).toBe(1);
    expect([...snapshots.keys()]).toEqual([-2, -3]);
  });
});
