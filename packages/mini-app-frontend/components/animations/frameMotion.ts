import {
  MINI_APP_FLIP_COLLAPSE_EASING_POINTS,
  MINI_APP_FRAME_MOTION_MAX_LAG_MS,
  MINI_APP_FRAME_MOTION_MAX_STEP_MS,
} from "../../consts/miniApp";

/** 浏览器 `globalThis` 上逐帧调度接口的最小类型声明。 */
export interface FrameMotionHost {
  readonly requestAnimationFrame?: (callback: (now: number) => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

/**
 * 获取当前运行环境的逐帧动画调度宿主对象（`requestAnimationFrame` / `cancelAnimationFrame`）。
 *
 * @returns 逐帧调度宿主引用
 */
export function getFrameMotionHost(): FrameMotionHost {
  return globalThis as FrameMotionHost;
}

/**
 * 按 CSS `cubic-bezier(x1, y1, x2, y2)` 曲线把线性时间进度换算为缓动进度：
 * 先以至多 8 轮牛顿迭代求解横坐标对应的曲线参数（横坐标误差小于 `1e-6` 即收敛），斜率过小或未收敛时退回 24 轮二分法。
 *
 * @param points 曲线控制点 `[x1, y1, x2, y2]`
 * @param progress 线性时间进度（`0..1`，越界按端点处理）
 * @returns 缓动进度（端点精确为 `0` 与 `1`）
 */
export function evaluateCubicBezierEase(
  points: Readonly<readonly [number, number, number, number]>,
  progress: number
): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const cx: number = 3 * points[0];
  const bx: number = 3 * (points[2] - points[0]) - cx;
  const ax: number = 1 - cx - bx;
  const cy: number = 3 * points[1];
  const by: number = 3 * (points[3] - points[1]) - cy;
  const ay: number = 1 - cy - by;
  const epsilon: number = 1e-6;

  let t: number = progress;
  for (let i: number = 0; i < 8; i += 1) {
    const xError: number = ((ax * t + bx) * t + cx) * t - progress;
    if (Math.abs(xError) < epsilon) {
      return ((ay * t + by) * t + cy) * t;
    }
    const slope: number = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(slope) < epsilon) break;
    t -= xError / slope;
  }

  let lower: number = 0;
  let upper: number = 1;
  t = progress;
  for (let i: number = 0; i < 24; i += 1) {
    const x: number = ((ax * t + bx) * t + cx) * t;
    if (x < progress) {
      lower = t;
    } else {
      upper = t;
    }
    t = (lower + upper) / 2;
  }
  return ((ay * t + by) * t + cy) * t;
}

/** `runFrameMotion` 的入参。 */
export interface RunFrameMotionOptions {
  /** 动画时长毫秒数（非正值或宿主缺少帧调度接口时同步落到终点）。 */
  readonly durationMs: number;
  /** 每帧以 `MINI_APP_FLIP_COLLAPSE_EASING_POINTS` 缓动后的进度（`0..1`）回调，同一帧内的样式写入与视口滚动都在这里完成。 */
  readonly onFrame: (easedProgress: number) => void;
  /** 进度为 `1` 的末帧写入后调用（取消时不调用）。 */
  readonly onFinish: () => void;
}

/**
 * 以 `requestAnimationFrame` 驱动一段按时间推进的缓动动画：首帧（起始帧）时间戳为起点、进度为 `0`；
 * 之后每帧的动画时钟推进「距上一帧的间隔」，单帧推进上限取 `MINI_APP_FRAME_MOTION_MAX_STEP_MS` 与本次动画此前已观测的最短帧间隔中的较大值
 * （起始帧之后的第一个间隔承担起始帧的绘制，不计入最短帧间隔）；
 * 时钟落后实际经过时间超过 `MINI_APP_FRAME_MOTION_MAX_LAG_MS` 时追平到「经过时间减该值」；
 * 按时钟换算进度回调 `onFrame`，进度到 `1` 的那一帧写入后调用 `onFinish`。
 *
 * @param options 时长、逐帧回调与收尾回调
 * @returns 取消函数（取消后不再回调；已结束时为空操作）
 */
export function runFrameMotion({
  durationMs,
  onFrame,
  onFinish,
}: RunFrameMotionOptions): () => void {
  const host: FrameMotionHost = getFrameMotionHost();
  let startTime: number = -1;
  let lastFrameTime: number = -1;
  let shortestIntervalMs: number = 0;
  let elapsedMs: number = 0;
  let frameHandle: number = 0;
  let active: boolean = true;
  const cancel = (): void => {
    if (!active) return;
    active = false;
    host.cancelAnimationFrame?.(frameHandle);
  };
  if (
    durationMs <= 0 ||
    typeof host.requestAnimationFrame !== "function" ||
    typeof host.cancelAnimationFrame !== "function"
  ) {
    active = false;
    onFrame(1);
    onFinish();
    return cancel;
  }
  const step = (now: number): void => {
    if (!active) return;
    if (startTime < 0) {
      startTime = now;
    } else {
      const intervalMs: number = Math.max(0, now - lastFrameTime);
      const frameStepMs: number = Math.min(
        intervalMs,
        Math.max(MINI_APP_FRAME_MOTION_MAX_STEP_MS, shortestIntervalMs)
      );
      if (lastFrameTime > startTime) {
        shortestIntervalMs = shortestIntervalMs === 0 ? intervalMs : Math.min(shortestIntervalMs, intervalMs);
      }
      elapsedMs = Math.max(elapsedMs + frameStepMs, now - startTime - MINI_APP_FRAME_MOTION_MAX_LAG_MS);
    }
    lastFrameTime = now;
    const linear: number = Math.min(1, elapsedMs / durationMs);
    onFrame(evaluateCubicBezierEase(MINI_APP_FLIP_COLLAPSE_EASING_POINTS, linear));
    if (linear >= 1) {
      active = false;
      onFinish();
      return;
    }
    frameHandle = host.requestAnimationFrame?.(step) ?? 0;
  };
  frameHandle = host.requestAnimationFrame(step);
  return cancel;
}
