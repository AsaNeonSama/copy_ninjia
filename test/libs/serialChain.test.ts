import { describe, expect, test } from "bun:test";
import { runSerialChain } from "../../packages/libs/serialChain";
import type { SerialChainHolder } from "../../packages/libs/serialChain";

describe("runSerialChain", () => {
  test("并发提交的异步任务严格按入队顺序串行执行，后一项不早于前一项完成前开始", async () => {
    const holder: SerialChainHolder = { current: Promise.resolve() };
    const first: PromiseWithResolvers<string> = Promise.withResolvers<string>();
    const second: PromiseWithResolvers<string> = Promise.withResolvers<string>();
    const events: string[] = [];

    const firstPromise: Promise<string> = runSerialChain(holder, async (): Promise<string> => {
      events.push("start-1");
      const value: string = await first.promise;
      events.push("end-1");
      return value;
    });
    const secondPromise: Promise<string> = runSerialChain(holder, async (): Promise<string> => {
      events.push("start-2");
      const value: string = await second.promise;
      events.push("end-2");
      return value;
    });

    await Promise.resolve();
    expect(events).toEqual(["start-1"]);

    first.resolve("first-done");
    expect(await firstPromise).toBe("first-done");
    expect(events.slice(0, 2)).toEqual(["start-1", "end-1"]);

    second.resolve("second-done");
    expect(await secondPromise).toBe("second-done");
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  test("前序任务抛错仅拒绝其自身调用方，不毒化后续排队任务", async () => {
    const holder: SerialChainHolder = { current: Promise.resolve() };
    const events: string[] = [];

    const failedPromise: Promise<number> = runSerialChain(holder, async (): Promise<number> => {
      events.push("fail-1");
      throw new Error("boom");
    });
    const nextPromise: Promise<number> = runSerialChain(holder, async (): Promise<number> => {
      events.push("ok-2");
      return 42;
    });

    await expect(failedPromise).rejects.toThrow("boom");
    expect(await nextPromise).toBe(42);
    expect(events).toEqual(["fail-1", "ok-2"]);
  });
});
