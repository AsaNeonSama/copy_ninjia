import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";

const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError }),
}));

const { trackBackgroundTask } = await import("../../packages/infra/backgroundTasks");

beforeEach(() => loggerError.mockClear());

describe("trackBackgroundTask", () => {
  test("成功结算后从在途集合摘除，不记日志", async () => {
    const tasks: Set<Promise<void>> = new Set<Promise<void>>();
    const { promise, resolve }: PromiseWithResolvers<number> = Promise.withResolvers<number>();
    trackBackgroundTask(tasks, promise, "task failed:");
    expect(tasks.size).toBe(1);
    const [observed]: Promise<void>[] = [...tasks];
    resolve(7);
    await expect(observed!).resolves.toBeUndefined();
    expect(tasks.size).toBe(0);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("失败只记一行带 owner 前缀的日志，观察 Promise 照常 resolve 并摘除", async () => {
    const tasks: Set<Promise<void>> = new Set<Promise<void>>();
    const failure: Error = new Error("boom");
    trackBackgroundTask(tasks, Promise.reject(failure), "task failed:");
    const [observed]: Promise<void>[] = [...tasks];
    await expect(observed!).resolves.toBeUndefined();
    expect(tasks.size).toBe(0);
    expect(loggerError.mock.calls).toEqual([["task failed:", failure]]);
  });

  test("只摘除自己登记的条目，同集合里的其它任务不受影响", async () => {
    const tasks: Set<Promise<void>> = new Set<Promise<void>>();
    const pending: Promise<void> = new Promise<void>((): void => {});
    tasks.add(pending);
    trackBackgroundTask(tasks, Promise.resolve(), "task failed:");
    expect(tasks.size).toBe(2);
    await Promise.allSettled([...tasks].filter((task: Promise<void>): boolean => task !== pending));
    expect([...tasks]).toEqual([pending]);
  });
});
