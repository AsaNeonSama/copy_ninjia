import { useEffect, useRef } from "react";
import type React from "react";
import {
  MINI_APP_CAP_HEADER_ESTIMATED_HEIGHT_PX,
  MINI_APP_CAP_SCROLL_SETTLE_DELAY_MS,
  MINI_APP_FLIP_COLLAPSE_DURATION_MS,
} from "../../consts/miniApp";
import { scrollViewportToExpandedBody } from "./expandFollowScroll";
import type { ViewportRectElement } from "./expandFollowScroll";
import { useFlipCollapseLayoutEffect } from "./flipCollapse";
import type { UseFlipCollapseLayoutEffectResult } from "./flipCollapse";

/** 子系统面板展开后延迟视口跟滚的共享调度状态（保证连续展开多项时只触发最后一次滑动）。 */
export interface ExpandScrollScheduleState {
  /** 当前挂起的延迟滚动定时器句柄（无挂起任务时为 `null`）。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 当前批次所有正在展开面板中最晚完成展开动画的时间戳（`performance.now()` 毫秒）。 */
  latestFinishTimeMs: number;
}

/** `CapabilityCollapseBody` 折叠动画容器的属性参数。 */
export interface CapabilityCollapseBodyProps {
  /** 当前面板是否处于展开状态。 */
  readonly expanded: boolean;
  /** 跨子系统面板共享的展开跟滚定时器状态引用。 */
  readonly expandScrollStateRef: React.RefObject<ExpandScrollScheduleState>;
  /** 面板内部渲染内容。 */
  readonly children: React.ReactNode;
}

/** `scrollViewportAfterCapabilityExpanded` 展开后延迟跟滚的参数。 */
interface ScrollViewportAfterExpandedOptions {
  /** 折叠外层容器节点。 */
  readonly wrapEl: ViewportRectElement;
  /** 面板展开过渡时长（毫秒）。 */
  readonly durationMs: number;
  /** 跨子系统面板共享的展开跟滚定时器状态引用。 */
  readonly expandScrollStateRef: React.RefObject<ExpandScrollScheduleState>;
}

/**
 * 在子系统折叠面板展开动画完成后按 `scrollViewportToExpandedBody` 让视口平滑向下滚动以展现展开内容
 * （标题栏顶部按容器顶部减去 `MINI_APP_CAP_HEADER_ESTIMATED_HEIGHT_PX` 估算）。
 * 若在等待期间连续展开多个面板，自动取消前序未触发的滚动定时器并顺延至最晚完成的展开面板结束后单次滑动。
 *
 * @param options 折叠容器节点、展开时长与共享调度状态引用
 * @returns 取消本次延迟滚动定时器的清理函数（无需滚动时返回 `undefined`）
 */
function scrollViewportAfterCapabilityExpanded({
  wrapEl,
  durationMs,
  expandScrollStateRef,
}: ScrollViewportAfterExpandedOptions): (() => void) | undefined {
  if (typeof wrapEl.getBoundingClientRect !== "function") {
    return undefined;
  }

  const scheduleState: ExpandScrollScheduleState = expandScrollStateRef.current;
  if (scheduleState.timer !== null) {
    clearTimeout(scheduleState.timer);
    scheduleState.timer = null;
  }
  const now: number = performance.now();
  const finishTimeMs: number = Math.max(
    scheduleState.latestFinishTimeMs,
    now + durationMs
  );
  scheduleState.latestFinishTimeMs = finishTimeMs;
  const waitMs: number =
    Math.max(durationMs, Math.ceil(finishTimeMs - now)) +
    MINI_APP_CAP_SCROLL_SETTLE_DELAY_MS;

  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    if (scheduleState.timer === timer) {
      scheduleState.timer = null;
    }
    if (typeof wrapEl.getBoundingClientRect !== "function") {
      return;
    }
    const wrapRect: { readonly top: number; readonly height: number } =
      wrapEl.getBoundingClientRect();
    if (wrapRect.height <= 0) {
      return;
    }
    scrollViewportToExpandedBody({
      blockTop: wrapRect.top - MINI_APP_CAP_HEADER_ESTIMATED_HEIGHT_PX,
      bodyTop: wrapRect.top,
      bodyHeight: wrapRect.height,
    });
  }, waitMs);

  scheduleState.timer = timer;
  return (): void => {
    clearTimeout(timer);
    if (scheduleState.timer === timer) {
      scheduleState.timer = null;
    }
  };
}

/**
 * 基于首帧单次布局测量与 GPU FLIP `translate3d` 合成层裁剪/同级平移实现零逐帧重排展开与收起的子系统折叠面板容器。
 *
 * @param props 展开状态、共享滚动调度引用与子节点
 * @returns React 节点
 */
export function CapabilityCollapseBody({
  expanded,
  expandScrollStateRef,
  children,
}: CapabilityCollapseBodyProps): React.JSX.Element {
  const prevExpandedRef: React.RefObject<boolean> = useRef<boolean>(expanded);
  const {
    gridRef,
    innerRef,
    isClosing,
  }: UseFlipCollapseLayoutEffectResult = useFlipCollapseLayoutEffect({
    expanded,
  });

  useEffect((): (() => void) | undefined => {
    const wasExpanded: boolean = prevExpandedRef.current;
    prevExpandedRef.current = expanded;
    if (!wasExpanded && expanded) {
      const wrapEl: ViewportRectElement | null = gridRef.current;
      if (wrapEl !== null) {
        return scrollViewportAfterCapabilityExpanded({
          wrapEl,
          durationMs: MINI_APP_FLIP_COLLAPSE_DURATION_MS,
          expandScrollStateRef,
        });
      }
    }
    return undefined;
  }, [expanded, expandScrollStateRef, gridRef]);

  return (
    <div
      ref={gridRef}
      className={`cap-collapse-wrap ${expanded ? "expanded" : ""}${isClosing ? " flip-closing" : ""}`}
      aria-hidden={!expanded}
    >
      <div
        ref={innerRef}
        className="cap-collapse-inner"
      >
        <div className="cap-body">{children}</div>
      </div>
    </div>
  );
}
