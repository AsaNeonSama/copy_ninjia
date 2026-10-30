import { useEffect, useRef, useState } from "react";
import type React from "react";
import {
  MINI_APP_ANIMATION_FRAME_STEP_MS,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS,
  MINI_APP_RANGE_ADVANCE_REMAINING_THRESHOLD,
  MINI_APP_RANGE_KICKOFF_MAX_PROGRESS,
  MINI_APP_RANGE_PULLBACK_MAX_SPAN,
  MINI_APP_RANGE_PULLBACK_MIN_SPAN,
  MINI_APP_RANGE_SPRING_AMPLITUDE_MAX,
  MINI_APP_RANGE_SPRING_AMPLITUDE_MIN,
  MINI_APP_RANGE_SPRING_AMPLITUDE_RATIO,
  MINI_APP_RANGE_SPRING_BOUNDARY_DAMPING,
  MINI_APP_RANGE_SPRING_SPLIT_PROGRESS,
  MINI_APP_RANGE_VALUE_EPSILON,
} from "../../consts/miniApp";
import { getFrameMotionHost } from "./frameMotion";
import type { FrameMotionHost } from "./frameMotion";

/** `useAnimatedRangeProgress` 返回的滑块动画状态与事件处理句柄。 */
export interface AnimatedRangeProgressResult {
  /** 当前滑块渲染用的平滑数值（动画期间为连续浮点数，静止或手动拖拽时为目标整数）。 */
  readonly displayValue: number;
  /** 当前是否处于按钮点击触发的平滑生长过渡动画中。 */
  readonly isAnimating: boolean;
  /** 交替翻转的 CSS 关键帧相位（`"a"` / `"b"`），保证连续点击或快速回撤时每次点击都能重新触发弹性关键帧动画。 */
  readonly animationPhase: "a" | "b";
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
 * 前段（`0..MINI_APP_RANGE_SPRING_SPLIT_PROGRESS`）快速平滑抵达目标值，后段做阻尼微幅过冲与回弹；若目标位于两端边界则向内侧轻微回弹后落定。
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
  if (distance < MINI_APP_RANGE_VALUE_EPSILON) return toValue;

  const splitAt: number = MINI_APP_RANGE_SPRING_SPLIT_PROGRESS;
  if (t <= splitAt) {
    const approachT: number = t / splitAt;
    const inv: number = 1 - approachT;
    const approachEased: number = 1 - inv * inv * inv;
    return fromValue + delta * approachEased;
  }

  const tailT: number = (t - splitAt) / (1 - splitAt);
  const direction: number = Math.sign(delta);
  const amplitude: number = Math.min(
    MINI_APP_RANGE_SPRING_AMPLITUDE_MAX,
    Math.max(
      MINI_APP_RANGE_SPRING_AMPLITUDE_MIN,
      distance * MINI_APP_RANGE_SPRING_AMPLITUDE_RATIO
    )
  );
  const envelope: number = (1 - tailT) * (1 - tailT);
  const wave: number = Math.sin(tailT * Math.PI) * envelope;
  const rawValue: number = toValue + direction * amplitude * wave;

  if (rawValue > MINI_APP_BATCH_KICK_MAX_HOURS) {
    const excess: number = rawValue - MINI_APP_BATCH_KICK_MAX_HOURS;
    return Math.max(
      MINI_APP_BATCH_KICK_MIN_HOURS,
      MINI_APP_BATCH_KICK_MAX_HOURS - excess * MINI_APP_RANGE_SPRING_BOUNDARY_DAMPING
    );
  }
  if (rawValue < MINI_APP_BATCH_KICK_MIN_HOURS) {
    const deficit: number = MINI_APP_BATCH_KICK_MIN_HOURS - rawValue;
    return Math.min(
      MINI_APP_BATCH_KICK_MAX_HOURS,
      MINI_APP_BATCH_KICK_MIN_HOURS + deficit * MINI_APP_RANGE_SPRING_BOUNDARY_DAMPING
    );
  }
  return rawValue;
}

/**
 * 计算按钮步进或回撤触发新一轮滑块动画时的有效起始数值。
 * 连续同向点击但上一轮尚未推进满时向前垫进起点，避免滑块原地停滞；
 * 快速回撤至原目标导致当前显示值与新目标差值过小时，朝上一目标方向预留回拉行程，保证回撤动画始终可见。
 *
 * @param currentDisplay 当前帧滑块显示值
 * @param prevTarget 上一轮目标小时数
 * @param nextTarget 本轮新目标小时数
 * @returns 归一化后的动画起始数值
 */
export function resolveAnimatedRangeStartValue(
  currentDisplay: number,
  prevTarget: number,
  nextTarget: number
): number {
  if (prevTarget === nextTarget) {
    return currentDisplay;
  }
  const stepDelta: number = nextTarget - prevTarget;
  const prevRemaining: number = prevTarget - currentDisplay;
  if (
    stepDelta * prevRemaining > 0 &&
    Math.abs(prevRemaining) > MINI_APP_RANGE_ADVANCE_REMAINING_THRESHOLD
  ) {
    const advanced: number =
      currentDisplay + prevRemaining * MINI_APP_RANGE_PULLBACK_MAX_SPAN;
    return Math.min(
      MINI_APP_BATCH_KICK_MAX_HOURS,
      Math.max(MINI_APP_BATCH_KICK_MIN_HOURS, advanced)
    );
  }
  if (Math.abs(nextTarget - currentDisplay) < MINI_APP_RANGE_PULLBACK_MIN_SPAN) {
    const pullbackSpan: number = Math.min(
      MINI_APP_RANGE_PULLBACK_MAX_SPAN,
      Math.max(
        MINI_APP_RANGE_PULLBACK_MIN_SPAN,
        Math.abs(prevTarget - nextTarget) * MINI_APP_RANGE_PULLBACK_MAX_SPAN
      )
    );
    const offsetStart: number =
      nextTarget + Math.sign(prevTarget - nextTarget) * pullbackSpan;
    return Math.min(
      MINI_APP_BATCH_KICK_MAX_HOURS,
      Math.max(MINI_APP_BATCH_KICK_MIN_HOURS, offsetStart)
    );
  }
  return currentDisplay;
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
  const [animationPhase, setAnimationPhase]: [
    "a" | "b",
    React.Dispatch<React.SetStateAction<"a" | "b">>
  ] = useState<"a" | "b">("a");
  const displayValueRef: React.RefObject<number> = useRef<number>(targetHours);
  const committedTargetRef: React.RefObject<number> = useRef<number>(targetHours);
  const manualChangeRef: React.RefObject<boolean> = useRef<boolean>(false);
  const rafIdRef: React.RefObject<number | null> = useRef<number | null>(null);

  useEffect((): (() => void) | undefined => {
    const host: FrameMotionHost = getFrameMotionHost();
    if (rafIdRef.current !== null && typeof host.cancelAnimationFrame === "function") {
      host.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const prevTarget: number = committedTargetRef.current;
    committedTargetRef.current = targetHours;

    if (manualChangeRef.current) {
      manualChangeRef.current = false;
      displayValueRef.current = targetHours;
      setDisplayValue(targetHours);
      setIsAnimating(false);
      return undefined;
    }

    const toValue: number = targetHours;
    const fromValue: number = resolveAnimatedRangeStartValue(
      displayValueRef.current,
      prevTarget,
      toValue
    );
    const reqFrame: ((callback: (now: number) => void) => number) | undefined =
      host.requestAnimationFrame;
    if (
      Math.abs(toValue - fromValue) < MINI_APP_RANGE_VALUE_EPSILON ||
      typeof reqFrame !== "function"
    ) {
      displayValueRef.current = toValue;
      setDisplayValue(toValue);
      setIsAnimating(false);
      return undefined;
    }

    const kickoffProgress: number = Math.min(
      MINI_APP_RANGE_KICKOFF_MAX_PROGRESS,
      MINI_APP_ANIMATION_FRAME_STEP_MS / MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS
    );
    const kickoffValue: number = interpolateSpringRangeValue(
      fromValue,
      toValue,
      kickoffProgress
    );
    displayValueRef.current = kickoffValue;
    setDisplayValue(kickoffValue);
    setIsAnimating(true);
    setAnimationPhase((prev: "a" | "b"): "a" | "b" => (prev === "a" ? "b" : "a"));

    let firstFrameTime: number | null = null;

    const stepFrame = (now: number): void => {
      const currentNow: number = Number.isFinite(now) ? now : Date.now();
      firstFrameTime ??= currentNow - MINI_APP_ANIMATION_FRAME_STEP_MS;
      const elapsed: number = Math.max(
        MINI_APP_ANIMATION_FRAME_STEP_MS,
        currentNow - firstFrameTime
      );
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
    const host: FrameMotionHost = getFrameMotionHost();
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
    committedTargetRef.current = clamped;
    displayValueRef.current = clamped;
    setDisplayValue(clamped);
    setIsAnimating(false);
    setBatchKickHours(clamped);
  };

  const onButtonStepChange = (nextHours: number): void => {
    const normalized: number = Number.isFinite(nextHours)
      ? Math.round(nextHours)
      : MINI_APP_BATCH_KICK_MIN_HOURS;
    const clamped: number = Math.min(
      MINI_APP_BATCH_KICK_MAX_HOURS,
      Math.max(MINI_APP_BATCH_KICK_MIN_HOURS, normalized)
    );
    manualChangeRef.current = false;
    setBatchKickHours(clamped);
  };

  return {
    displayValue,
    isAnimating,
    animationPhase,
    progressPercent: computeRangeProgressPercent(displayValue),
    onManualDragChange,
    onButtonStepChange,
  };
}
