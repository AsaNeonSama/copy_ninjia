import {
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from "../../consts/luckChallenge";
import { recentCallTimestamps } from "../../cache/main/luckChallenge";
import { tryConsumeSlidingWindow } from "../../libs/slidingWindowRateLimit";

/**
 * 全局滑动窗口；内联查询超限立即拒绝，不排队。窗口判定见 libs/slidingWindowRateLimit.ts。
 * @param now 当前时刻（毫秒）；默认取墙钟。
 * @returns 仍在配额内并已记账时返回 true；超额时返回 false。
 */
export function tryConsumeLuckRateLimit(now: number = Date.now()): boolean {
  return tryConsumeSlidingWindow({
    timestamps: recentCallTimestamps,
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxCalls: RATE_LIMIT_MAX_CALLS_PER_WINDOW,
    now,
  });
}
