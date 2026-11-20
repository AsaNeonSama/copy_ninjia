import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { diskIOStub } from "../helpers/diskIOMock";

const postDiskIO = mock((_message: unknown): boolean => true);
mock.module("../../packages/infra/diskIO", () => diskIOStub({ postDiskIO }));

const { requestAiMemoryDelete } = await import("../../packages/aiChat/memoryMirror");
const {
  aiMemoryDeleteWaiters,
  aiMemoryRevisionCounters,
  aiMemoryRevisionFloor,
  pendingAiMemoryDeletes,
} = await import("../../packages/cache/main/aiChat");

afterEach((): void => {
  for (const waiters of aiMemoryDeleteWaiters.values()) {
    for (const waiter of waiters) clearTimeout(waiter.timer);
  }
  aiMemoryDeleteWaiters.clear();
  pendingAiMemoryDeletes.clear();
  aiMemoryRevisionCounters.clear();
  aiMemoryRevisionFloor.current = 0;
  postDiskIO.mockClear();
});

describe("aiChat/memoryMirror", () => {
  test("等待持久化删除回执的超时定时器调用 unref，不阻塞进程退出", () => {
    const unrefSpy = mock((): void => {});
    const fakeTimer: ReturnType<typeof setTimeout> = { unref: unrefSpy } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockReturnValueOnce(fakeTimer);
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation((): void => {});
    try {
      const pending: Promise<void> = requestAiMemoryDelete(-1001, true);
      void pending;
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(unrefSpy).toHaveBeenCalledTimes(1);
      expect(aiMemoryDeleteWaiters.get(-1001)).toHaveLength(1);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
