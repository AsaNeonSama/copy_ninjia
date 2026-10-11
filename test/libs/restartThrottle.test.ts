import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createRestartThrottle } from "../../packages/libs/restartThrottle";

/** 夹具：窗口内最多 3 次重启，窗口 1 秒。 */
const MAX_RESTARTS: number = 3;
const WINDOW_MS: number = 1_000;

let now: number = 0;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;

/** 把墙钟拨到 at 再问一次是否放弃自愈。 */
function giveUpAt(throttle: { shouldGiveUp: () => boolean }, at: number): boolean {
  now = at;
  return throttle.shouldGiveUp();
}

beforeEach(() => {
  now = 0;
  clock = spyOn(Date, "now").mockImplementation((): number => now);
});

afterEach(() => {
  clock.mockRestore();
});

describe("createRestartThrottle：滑动窗口内的重启配额", () => {
  test("配额内的重启继续自愈，超出上限的那次放弃", () => {
    const throttle: { shouldGiveUp: () => boolean } = createRestartThrottle(MAX_RESTARTS, WINDOW_MS);

    expect(giveUpAt(throttle, 100)).toBeFalse();
    expect(giveUpAt(throttle, 200)).toBeFalse();
    expect(giveUpAt(throttle, 300)).toBeFalse();
    expect(giveUpAt(throttle, 400)).toBeTrue();
  });

  test("最早一次重启恰好满一个窗口即释放名额", () => {
    const throttle: { shouldGiveUp: () => boolean } = createRestartThrottle(MAX_RESTARTS, WINDOW_MS);
    giveUpAt(throttle, 100);
    giveUpAt(throttle, 200);
    giveUpAt(throttle, 300);

    expect(giveUpAt(throttle, 100 + WINDOW_MS - 1)).toBeTrue();
    expect(giveUpAt(throttle, 100 + WINDOW_MS)).toBeFalse();
  });

  test("被拒的那次不记账，不占用后续窗口的名额", () => {
    const throttle: { shouldGiveUp: () => boolean } = createRestartThrottle(MAX_RESTARTS, WINDOW_MS);
    giveUpAt(throttle, 0);
    giveUpAt(throttle, 100);
    giveUpAt(throttle, 200);
    expect(giveUpAt(throttle, 500)).toBeTrue();
    // 0 滑出窗口后剩 [100, 200]，记下 1000。
    expect(giveUpAt(throttle, 1_000)).toBeFalse();
    // 100 滑出后剩 [200, 1000]；若被拒的 500 也记过账，这里会是满额并放弃。
    expect(giveUpAt(throttle, 1_100)).toBeFalse();
  });

  test("时钟回拨只丢落在未来的记录，仍在窗口内的历史照样占名额", () => {
    const throttle: { shouldGiveUp: () => boolean } = createRestartThrottle(2, WINDOW_MS);
    giveUpAt(throttle, 1_000);
    giveUpAt(throttle, 1_800);

    // 回拨到 1500：1800 落在未来被丢掉，1000 保留，本次记下。
    expect(giveUpAt(throttle, 1_500)).toBeFalse();
    // 1000 与 1500 都还在窗口内，名额已满。
    expect(giveUpAt(throttle, 1_500)).toBeTrue();
  });

  test("上限为 1 时窗口内第二次即放弃", () => {
    const throttle: { shouldGiveUp: () => boolean } = createRestartThrottle(1, WINDOW_MS);

    expect(giveUpAt(throttle, 10)).toBeFalse();
    expect(giveUpAt(throttle, 10)).toBeTrue();
    expect(giveUpAt(throttle, 10 + WINDOW_MS)).toBeFalse();
  });

  test("两个节流器各自记账，互不占用名额", () => {
    const first: { shouldGiveUp: () => boolean } = createRestartThrottle(1, WINDOW_MS);
    const second: { shouldGiveUp: () => boolean } = createRestartThrottle(1, WINDOW_MS);

    expect(giveUpAt(first, 10)).toBeFalse();
    expect(giveUpAt(second, 10)).toBeFalse();
    expect(giveUpAt(first, 20)).toBeTrue();
  });

  test("上限不是正安全整数时构造即抛 RangeError", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createRestartThrottle(invalid, WINDOW_MS)).toThrow(new RangeError("maxCapacity must be a positive safe integer"));
    }
  });
});
