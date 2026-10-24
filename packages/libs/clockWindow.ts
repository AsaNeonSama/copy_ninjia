/**
 * 墙钟时间窗判定。两个判定都把「系统校时回拨」按窗口已结束处理：回拨后的 now 早于
 * 记录时刻、或截止时刻远于任何一档延迟时，不再等回拨量走完才过期。
 */

/**
 * recordedAt 到 now 的经过时长是否落在 [0, maxAgeMs] 内。
 * @param recordedAt 事件记录时的毫秒时间戳。
 * @param now 当前毫秒时间戳。
 * @param maxAgeMs 允许的最大存活毫秒时长。
 * @returns 经过时长在 `[0, maxAgeMs]` 闭区间内时返回 true，否则返回 false。
 */
export function isRecordedWithin(recordedAt: number, now: number, maxAgeMs: number): boolean {
  const age: number = now - recordedAt;
  return age >= 0 && age <= maxAgeMs;
}

/**
 * deadlineAt 是否仍在 now 之后且距 now 不超过 maxDelayMs。
 * @param deadlineAt 截止时刻的毫秒时间戳。
 * @param now 当前毫秒时间戳。
 * @param maxDelayMs 允许的最大剩余等待毫秒时长。
 * @returns 剩余时长在 `(0, maxDelayMs]` 半开区间内时返回 true，否则返回 false。
 */
export function isPendingWithin(deadlineAt: number, now: number, maxDelayMs: number): boolean {
  const remaining: number = deadlineAt - now;
  return remaining > 0 && remaining <= maxDelayMs;
}
