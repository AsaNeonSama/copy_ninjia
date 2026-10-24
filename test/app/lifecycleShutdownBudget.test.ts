import { describe, expect, test } from "bun:test";
import { NORMAL_FLUSH_TIMEOUTS, SHUTDOWN_TOTAL_BUDGET_MS } from "../../packages/consts/lifecycle";
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
});
