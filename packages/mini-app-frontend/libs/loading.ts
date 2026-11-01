import { MINI_APP_MIN_LOADING_MS } from "../consts/miniApp";

/**
 * 等待异步加载或骨架屏动画达到最短展示时长（若实际耗时已达标则立即返回），确保加载与闪光动画完整平滑播放。
 *
 * @param startedAtMs 加载起始毫秒时间戳（`Date.now()`）
 * @param minDurationMs 最短展示毫秒数（默认 `MINI_APP_MIN_LOADING_MS`）
 * @returns 无返回值 Promise
 */
export async function waitMinimumLoadingDuration(
  startedAtMs: number,
  minDurationMs: number = MINI_APP_MIN_LOADING_MS
): Promise<void> {
  const remainingMs: number = minDurationMs - (Date.now() - startedAtMs);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, remainingMs);
  });
}
