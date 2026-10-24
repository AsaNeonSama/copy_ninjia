/** 可注入的单调时钟；缺省为 performance.now()。只用于进程内耗时预算，不用于持久化时间戳。 */
export type MonotonicClock = () => number;

/**
 * 各截止点函数共用的缺省单调时钟。
 * @returns 当前 `performance.now()` 读数。
 */
function defaultMonotonicClock(): number {
  return performance.now();
}

/**
 * 从当前单调时间创建绝对截止点。负预算与零预算都立即到期。
 * @param timeoutMs 超时毫秒预算。
 * @param clock 单调时钟读取函数，默认为 `performance.now()`。
 * @returns 单调时钟坐标下的绝对截止时间点。
 */
export function createMonotonicDeadline(
  timeoutMs: number,
  clock: MonotonicClock = defaultMonotonicClock
): number {
  return clock() + Math.max(0, timeoutMs);
}

/**
 * 返回截止点的剩余毫秒预算；到期后稳定保持为零。
 * @param deadline 单调时钟下的绝对截止时间点。
 * @param clock 单调时钟读取函数，默认为 `performance.now()`。
 * @returns 非负剩余毫秒时间预算；到期后返回 0。
 */
export function remainingMonotonicTime(
  deadline: number,
  clock: MonotonicClock = defaultMonotonicClock
): number {
  return Math.max(0, deadline - clock());
}

/**
 * 判断单调截止点是否已经到期。
 * @param deadline 单调时钟下的绝对截止时间点。
 * @param clock 单调时钟读取函数，默认为 `performance.now()`。
 * @returns 剩余时间归零（已到期）时返回 true，否则返回 false。
 */
export function isMonotonicDeadlineExpired(
  deadline: number,
  clock: MonotonicClock = defaultMonotonicClock
): boolean {
  return remainingMonotonicTime(deadline, clock) === 0;
}

/**
 * 取一段等待自身的预算与总截止点剩余时间的较小值，多段等待由此共用一条总截止。
 * @param budgetMs 这一段自身的毫秒预算。
 * @param deadline 单调时钟下的绝对总截止时间点。
 * @param clock 单调时钟读取函数，默认为 `performance.now()`。
 * @returns 不超过 budgetMs 的非负毫秒预算（剩余时间向下取整）；总截止已到期时返回 0。
 */
export function budgetWithinDeadline(
  budgetMs: number,
  deadline: number,
  clock: MonotonicClock = defaultMonotonicClock
): number {
  return Math.min(budgetMs, Math.floor(remainingMonotonicTime(deadline, clock)));
}
