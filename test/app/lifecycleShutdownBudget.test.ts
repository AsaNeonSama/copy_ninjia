import { describe, expect, test } from "bun:test";
import { NORMAL_FLUSH_TIMEOUTS, SHUTDOWN_TOTAL_BUDGET_MS } from "../../packages/consts/lifecycle";
import { StateStore } from "../../packages/infra/storage/statePersistence";
import {
  installLifecycleFixtureHooks,
  lifecycleFixture as sharedFixture,
} from "../helpers/lifecycleFixture";
import type { FlushResult } from "../helpers/lifecycleFixture";

const {
  ApplicationLifecycle,
  advanceMonotonicTime,
  closeTranslate,
  drainAntiRaid,
  drainAvatarUpdates,
  drainTranslate,
  flushDiskIO,
  flushStateToDisk,
  getUpdates,
  loggerError,
  releaseSingleInstanceLock,
  setLastSeenUpdateId,
  terminateAntiRaid,
  terminateDiskIO,
  testDependencies,
  triggerDiskIOFatal,
} = sharedFixture;

installLifecycleFixtureHooks();

describe("停机时间预算", () => {
  test("Anti-Raid 与翻译按各自的专用预算排空", async () => {
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose();

    expect(drainAntiRaid).toHaveBeenCalledWith(NORMAL_FLUSH_TIMEOUTS.antiRaidMs);
    expect(drainTranslate).toHaveBeenCalledWith(NORMAL_FLUSH_TIMEOUTS.translateMs);
    expect(closeTranslate).toHaveBeenCalledWith(NORMAL_FLUSH_TIMEOUTS.translateMs);
    expect(flushDiskIO).toHaveBeenCalledWith(NORMAL_FLUSH_TIMEOUTS.diskIOMs);
  });

  test("总截止耗尽后其余排空与 state flush 按零预算执行，终止步骤照常执行", async () => {
    drainAvatarUpdates.mockImplementationOnce(async (): Promise<FlushResult> => {
      advanceMonotonicTime(SHUTDOWN_TOTAL_BUDGET_MS);
      return "flushed";
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose();

    expect(drainAntiRaid).toHaveBeenCalledWith(0);
    expect(closeTranslate).toHaveBeenCalledWith(0);
    expect(flushDiskIO).toHaveBeenCalledWith(0);
    expect(flushStateToDisk).toHaveBeenCalledWith(0, true);
    expect(terminateAntiRaid).toHaveBeenCalledTimes(1);
    expect(terminateDiskIO).toHaveBeenCalledTimes(1);
  });

  test("总截止从停机请求起算，wait 与 dispose 两遍共用同一截止", async () => {
    const remainingMs: number = 1_000;
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    triggerDiskIOFatal(new Error("disk unavailable"));
    advanceMonotonicTime(SHUTDOWN_TOTAL_BUDGET_MS - remainingMs);
    await lifecycle.wait();
    await lifecycle.dispose();

    expect(drainAntiRaid.mock.calls.map((args: unknown[]): unknown => args[0])).toEqual([remainingMs, remainingMs]);
  });

  test("总截止耗尽时真实 StateStore 不抛 RangeError，零预算跳过最终 offset 请求并正确判定结局", async () => {
    const store = new StateStore();
    let flushedInWait: boolean = false;
    const realStateDependencies = {
      ...testDependencies,
      flushStateToDisk: (timeoutMs: number, quiesce: boolean): Promise<FlushResult> => {
        if (!flushedInWait) {
          flushedInWait = true;
          // 落盘前置刚刚完成时总截止耗尽：offset 确认与随后 dispose 的 state flush 均落到零预算。
          advanceMonotonicTime(SHUTDOWN_TOTAL_BUDGET_MS);
        }
        return store.flush(timeoutMs, quiesce);
      },
    };
    const lifecycle = new ApplicationLifecycle(realStateDependencies);
    await lifecycle.init();
    setLastSeenUpdateId(42);

    await lifecycle.wait();
    await lifecycle.dispose();

    expect(getUpdates).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalledWith(
      "Shutdown owner threw during disposal:",
      expect.anything(),
      expect.anything()
    );
    expect(loggerError).toHaveBeenCalledWith(
      "Withholding the final Telegram offset because the shutdown budget is exhausted."
    );
    expect(loggerError).toHaveBeenCalledWith(
      "Shutdown drain/flush results:",
      expect.objectContaining({ state: "flushed", offsetConfirmed: false })
    );
  });
});
