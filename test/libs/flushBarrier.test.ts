import { describe, expect, test } from "bun:test";
import { createFlushBarrier } from "../../packages/libs/flushBarrier";

describe("flush barrier", () => {
  test("ack 只结算一次并忽略迟到回执", async () => {
    const barrier = createFlushBarrier<readonly string[]>({ timeoutMs: 1_000 });
    let id: number = 0;
    let receivedDetail: readonly string[] | undefined;
    const result = barrier.begin(
      (nextId) => { id = nextId; },
      undefined,
      (detail) => { receivedDetail = detail; }
    );

    expect(barrier.pendingCount()).toBe(1);
    expect(barrier.settle(id, "failed", ["chatState"])).toBeTrue();
    expect(barrier.settle(id, "flushed", ["other"])).toBeFalse();
    await expect(result).resolves.toBe("failed");
    expect(receivedDetail).toEqual(["chatState"]);
    expect(barrier.pendingCount()).toBe(0);
  });

  test("超时、投递失败和同步异常都清理等待项", async () => {
    const barrier = createFlushBarrier({ timeoutMs: 1 });

    await expect(barrier.begin(() => undefined)).resolves.toBe("timedOut");
    await expect(barrier.begin(() => false, 1_000)).resolves.toBe("failed");
    await expect(barrier.begin(() => { throw new Error("post failed"); }, 1_000)).resolves.toBe("failed");
    expect(barrier.pendingCount()).toBe(0);
  });

  test("崩溃会立即按同一结果结算所有在途等待", async () => {
    const barrier = createFlushBarrier({ timeoutMs: 60_000 });
    const first = barrier.begin(() => undefined);
    const second = barrier.begin(() => undefined);

    barrier.settleAll("failed");

    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([
      { status: "fulfilled", value: "failed" },
      { status: "fulfilled", value: "failed" },
    ]);
    expect(barrier.pendingCount()).toBe(0);
  });

  test("onDetail 回调抛错时仍结算等待 Promise，且 settleAll 不遗漏后续等待项", async () => {
    const barrier = createFlushBarrier<string>({ timeoutMs: 60_000 });
    let singleId: number = 0;
    const single = barrier.begin(
      (nextId: number): void => { singleId = nextId; },
      undefined,
      (): void => { throw new Error("detail failed"); }
    );
    expect((): boolean => barrier.settle(singleId, "flushed", "x")).toThrow("detail failed");
    await expect(single).resolves.toBe("flushed");

    const first = barrier.begin(
      (): void => {},
      undefined,
      (): void => { throw new Error("first detail failed"); }
    );
    const second = barrier.begin((): void => {});
    expect((): void => barrier.settleAll("failed")).toThrow("first detail failed");
    await expect(first).resolves.toBe("failed");
    await expect(second).resolves.toBe("failed");
    expect(barrier.pendingCount()).toBe(0);
  });
});
