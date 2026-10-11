import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { scheduleEarliestExpirySweep } from "../../packages/libs/earliestExpirySweep";
import type { EarliestExpirySweeper } from "../../packages/libs/earliestExpirySweep";

interface CapturedTimer {
  readonly callback: () => void;
  readonly delay: number;
}

/** 被替换的 setTimeout 收下的回调与延迟；用例按需手动触发。 */
const timers: CapturedTimer[] = [];
let setTimeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;
let nowSpy: ReturnType<typeof spyOn<typeof Date, "now">>;
let wallClock: number = 1_000_000;

beforeEach((): void => {
  timers.length = 0;
  wallClock = 1_000_000;
  nowSpy = spyOn(Date, "now").mockImplementation((): number => wallClock);
  setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    timers.push({ callback, delay });
    return { unref(): void {} };
  }) as never);
});

afterEach((): void => {
  setTimeoutSpy.mockRestore();
  nowSpy.mockRestore();
});

/** 一张只记到期时刻的表：sweep 删掉到期项。 */
function createSweeper(expiries: number[]): EarliestExpirySweeper & { readonly sweeps: number[] } {
  const sweeps: number[] = [];
  return {
    state: { timer: null },
    earliestExpiry: (): number => Math.min(...expiries),
    sweep: (now: number): void => {
      sweeps.push(now);
      for (let index: number = expiries.length - 1; index >= 0; index--) {
        if (expiries[index]! <= now) expiries.splice(index, 1);
      }
    },
    sweeps,
  };
}

/** 按墙钟推进到 timer 的到点时刻并触发它。 */
function fire(timer: CapturedTimer | undefined): void {
  if (timer === undefined) throw new Error("expected a scheduled timer");
  wallClock += timer.delay;
  timer.callback();
}

describe("scheduleEarliestExpirySweep", () => {
  test("空表不排程", () => {
    const sweeper = createSweeper([]);
    scheduleEarliestExpirySweep(sweeper, wallClock);
    expect(sweeper.state.timer).toBeNull();
    expect(timers).toHaveLength(0);
  });

  test("延迟按调用方的 now 计算；已有排程时不重复挂 timer", () => {
    const sweeper = createSweeper([1_000_600]);
    scheduleEarliestExpirySweep(sweeper, 1_000_100);
    scheduleEarliestExpirySweep(sweeper, 1_000_200);
    expect(timers.map((timer: CapturedTimer): number => timer.delay)).toEqual([500]);
    expect(sweeper.state.timer).not.toBeNull();
  });

  test("到点按墙钟清扫后按剩余条目重排，清空后停止", () => {
    const sweeper = createSweeper([wallClock + 5, wallClock + 30]);
    scheduleEarliestExpirySweep(sweeper, wallClock);
    expect(timers.map((timer: CapturedTimer): number => timer.delay)).toEqual([5]);

    fire(timers[0]);
    expect(sweeper.sweeps).toEqual([1_000_005]);
    expect(timers.map((timer: CapturedTimer): number => timer.delay)).toEqual([5, 25]);

    fire(timers[1]);
    expect(sweeper.sweeps).toEqual([1_000_005, 1_000_030]);
    expect(timers).toHaveLength(2);
    expect(sweeper.state.timer).toBeNull();
  });

  test("最早到期已过去时延迟按 1 ms 计", () => {
    const sweeper = createSweeper([wallClock - 1_000]);
    scheduleEarliestExpirySweep(sweeper, wallClock);
    expect(timers.map((timer: CapturedTimer): number => timer.delay)).toEqual([1]);
  });
});
