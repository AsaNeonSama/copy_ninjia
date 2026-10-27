import { useEffect, useRef, useState } from "react";
import type React from "react";
import {
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS,
} from "../../consts/miniApp";

/** 浏览器 `globalThis` 上帧动画调度接口的最小类型声明。 */
interface AnimationFrameHost {
  readonly requestAnimationFrame?: (callback: (now: number) => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

/** `useAnimatedRangeProgress` 返回的滑块动画状态与事件处理句柄。 */
export interface AnimatedRangeProgressResult {
  /** 当前滑块渲染用的平滑数值（动画期间为连续浮点数，静止或手动拖拽时为目标整数）。 */
  readonly displayValue: number;
  /** 当前是否处于按钮点击触发的平滑生长过渡动画中。 */
  readonly isAnimating: boolean;
  /** 当前进度条填充百分比字符串（如 `"21.74%"`）。 */
  readonly progressPercent: string;
  /** 用户手动拖拽 `<input type="range">` 时调用：立即中止动画并同步目标小时数。 */
  readonly onManualDragChange: (rawValue: number) => void;
  /** 用户点击预设小时按钮或步进按钮（`−` / `+`）时调用：平滑生长过渡到目标小时数。 */
  readonly onButtonStepChange: (targetHours: number) => void;
}

/**
 * 计算回溯清理窗口滑块当前数值对应的进度条填充百分比字符串（`0.00%`–`100.00%`）。
 *
 * @param value 当前滑块显示值
 * @param min 最小小时数下界
 * @param max 最大小时数上界
 * @returns 百分比字符串
 */
export function computeRangeProgressPercent(
  value: number,
  min: number = MINI_APP_BATCH_KICK_MIN_HOURS,
  max: number = MINI_APP_BATCH_KICK_MAX_HOURS
): string {
  const span: number = Math.max(1, max - min);
  const clamped: number = Math.min(max, Math.max(min, value));
  return `${(((clamped - min) / span) * 100).toFixed(2)}%`;
}

/**
 * 计算滑块从起点平滑生长到目标点并在定点后产生轻微弹性回弹的插值数值。
 * 前段（`0..0.62`）快速平滑抵达目标值，后段（`0.62..1`）做阻尼微幅过冲与回弹；若目标位于两端边界则向内侧轻微回弹后落定。
 *
 * @param fromValue 动画起始小时值
 * @param toValue 动画目标小时值
 * @param progress 归一化时间进度（`0..1`）
 * @returns 当前帧的平滑显示值（已夹紧在合法范围内）
 */
export function interpolateSpringRangeValue(
  fromValue: number,
  toValue: number,
  progress: number
): number {
  const t: number = Math.min(1, Math.max(0, progress));
  if (t >= 1) return toValue;
  const delta: number = toValue - fromValue;
  const distance: number = Math.abs(delta);
  if (distance < 0.001) return toValue;

  const splitAt: number = 0.62;
  if (t <= splitAt) {
    const approachT: number = t / splitAt;
    const inv: number = 1 - approachT;
    const approachEased: number = 1 - inv * inv * inv;
    return fromValue + delta * approachEased;
  }

  const tailT: number = (t - splitAt) / (1 - splitAt);
  const direction: number = Math.sign(delta);
  const amplitude: number = Math.min(0.62, Math.max(0.26, distance * 0.075));
  const envelope: number = (1 - tailT) * (1 - tailT);
  const wave: number = Math.sin(tailT * Math.PI * 1.35) * envelope;
  const rawValue: number = toValue + direction * amplitude * wave;

  if (rawValue > MINI_APP_BATCH_KICK_MAX_HOURS) {
    const excess: number = rawValue - MINI_APP_BATCH_KICK_MAX_HOURS;
    return Math.max(
      MINI_APP_BATCH_KICK_MIN_HOURS,
      MINI_APP_BATCH_KICK_MAX_HOURS - excess * 0.65
    );
  }
  if (rawValue < MINI_APP_BATCH_KICK_MIN_HOURS) {
    const deficit: number = MINI_APP_BATCH_KICK_MIN_HOURS - rawValue;
    return Math.min(
      MINI_APP_BATCH_KICK_MAX_HOURS,
      MINI_APP_BATCH_KICK_MIN_HOURS + deficit * 0.65
    );
  }
  return rawValue;
}

/**
 * 控制回溯清理窗口（1–24 小时）滑块与进度条在点击小时按钮时平滑生长、手动拉动时即时跟随的动画 Hook。
 *
 * @param targetHours 当前目标小时数
 * @param setBatchKickHours 更新目标小时数的 store 动作
 * @returns 滑块渲染状态与事件回调
 */
export function useAnimatedRangeProgress(
  targetHours: number,
  setBatchKickHours: (hours: number) => void
): AnimatedRangeProgressResult {
  const [displayValue, setDisplayValue]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(targetHours);
  const [isAnimating, setIsAnimating]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const displayValueRef: React.RefObject<number> = useRef<number>(targetHours);
  const manualChangeRef: React.RefObject<boolean> = useRef<boolean>(false);
  const rafIdRef: React.RefObject<number | null> = useRef<number | null>(null);

  useEffect((): (() => void) | undefined => {
    const host: AnimationFrameHost = globalThis as unknown as AnimationFrameHost;
    if (rafIdRef.current !== null && typeof host.cancelAnimationFrame === "function") {
      host.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    if (manualChangeRef.current) {
      manualChangeRef.current = false;
      displayValueRef.current = targetHours;
      setDisplayValue(targetHours);
      setIsAnimating(false);
      return undefined;
    }

    const fromValue: number = displayValueRef.current;
    const toValue: number = targetHours;
    const reqFrame: ((callback: (now: number) => void) => number) | undefined =
      host.requestAnimationFrame;
    if (Math.abs(toValue - fromValue) < 0.001 || typeof reqFrame !== "function") {
      displayValueRef.current = toValue;
      setDisplayValue(toValue);
      setIsAnimating(false);
      return undefined;
    }

    const startTime: number =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    setIsAnimating(true);

    const stepFrame = (now: number): void => {
      const currentNow: number = Number.isFinite(now) ? now : Date.now();
      const elapsed: number = Math.max(0, currentNow - startTime);
      const progress: number = Math.min(
        1,
        elapsed / MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS
      );
      const nextValue: number = interpolateSpringRangeValue(
        fromValue,
        toValue,
        progress
      );

      if (progress < 1) {
        displayValueRef.current = nextValue;
        setDisplayValue(nextValue);
        rafIdRef.current = reqFrame(stepFrame);
      } else {
        rafIdRef.current = null;
        displayValueRef.current = toValue;
        setDisplayValue(toValue);
        setIsAnimating(false);
      }
    };

    rafIdRef.current = reqFrame(stepFrame);

    return (): void => {
      if (rafIdRef.current !== null && typeof host.cancelAnimationFrame === "function") {
        host.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [targetHours]);

  const onManualDragChange = (rawValue: number): void => {
    const host: AnimationFrameHost = globalThis as unknown as AnimationFrameHost;
    if (rafIdRef.current !== null && typeof host.cancelAnimationFrame === "function") {
      host.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const normalized: number = Number.isFinite(rawValue)
      ? Math.round(rawValue)
      : MINI_APP_BATCH_KICK_MIN_HOURS;
    const clamped: number = Math.min(
      MINI_APP_BATCH_KICK_MAX_HOURS,
      Math.max(MINI_APP_BATCH_KICK_MIN_HOURS, normalized)
    );
    manualChangeRef.current = true;
    displayValueRef.current = clamped;
    setDisplayValue(clamped);
    setIsAnimating(false);
    setBatchKickHours(clamped);
  };

  const onButtonStepChange = (nextHours: number): void => {
    manualChangeRef.current = false;
    setBatchKickHours(nextHours);
  };

  return {
    displayValue,
    isAnimating,
    progressPercent: computeRangeProgressPercent(displayValue),
    onManualDragChange,
    onButtonStepChange,
  };
}
