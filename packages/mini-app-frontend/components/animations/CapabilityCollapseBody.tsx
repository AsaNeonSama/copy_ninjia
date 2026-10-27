import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import {
  MINI_APP_CAP_HEADER_ESTIMATED_HEIGHT_PX,
  MINI_APP_CAP_SCROLL_BOTTOM_MARGIN_PX,
  MINI_APP_CAP_SCROLL_COMFORT_BODY_FACTOR,
  MINI_APP_CAP_SCROLL_COMFORT_TOP_RATIO,
  MINI_APP_CAP_SCROLL_MIN_DELTA_PX,
  MINI_APP_CAP_SCROLL_SETTLE_DELAY_MS,
  MINI_APP_CAP_SCROLL_TOP_MARGIN_PX,
} from "../../consts/miniApp";
import { computeCapabilityCollapseDurationMs } from "../../libs/formatters";

/** 子系统面板展开后延迟视口跟滚的共享调度状态（保证连续展开多项时只触发最后一次滑动）。 */
export interface ExpandScrollScheduleState {
  /** 当前挂起的延迟滚动定时器句柄（无挂起任务时为 `null`）。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 当前批次所有正在展开面板中最晚完成展开动画的时间戳（`performance.now()` 毫秒）。 */
  latestFinishTimeMs: number;
}

/** 支持读取内容总高度的折叠面板内容 DOM 节点最小类型接口。 */
interface MeasurableCollapseElement {
  /** 元素包含边框与内边距的完整布局像素高度。 */
  readonly offsetHeight?: number;
  /** 元素内容的完整像素高度（不受外层 `height: 0` 裁切影响）。 */
  readonly scrollHeight?: number;
}

/** 支持直接写入行内高度与过渡时长样式的折叠外层容器 DOM 节点最小类型接口。 */
interface MeasurableCollapseWrapElement {
  /** 行内样式对象。 */
  readonly style?: {
    height: string;
    setProperty?: (property: string, value: string) => void;
  };
  /** 读取元素相对于视口的几何边界。 */
  readonly getBoundingClientRect?: () => {
    readonly top: number;
    readonly height: number;
  };
}

/** 支持读取视口尺寸与触发平滑滚动的全局宿主最小类型接口。 */
interface ScrollableViewportHost {
  /** 视口可视像素高度。 */
  readonly innerHeight?: number;
  /** 按指定增量平滑滚动文档视口。 */
  readonly scrollBy?: (options: {
    readonly top: number;
    readonly behavior: "smooth";
  }) => void;
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
  readonly wrapEl: MeasurableCollapseWrapElement;
  /** 展开内容的像素高度。 */
  readonly bodyHeight: number;
  /** 面板展开过渡时长（毫秒）。 */
  readonly durationMs: number;
  /** 跨子系统面板共享的展开跟滚定时器状态引用。 */
  readonly expandScrollStateRef: React.RefObject<ExpandScrollScheduleState>;
}

/** 折叠容器带自定义动画时长 CSS 变量的行内样式类型。 */
type CollapseWrapInlineStyle = React.CSSProperties & {
  readonly "--cap-duration": string;
};

/**
 * 读取折叠面板内容节点的完整像素高度（优先取含上边框的 `offsetHeight`）。
 *
 * @param element 折叠面板内容 DOM 节点
 * @returns 像素高度（未挂载时返回 `0`）
 */
function readCollapseBodyHeight(
  element: MeasurableCollapseElement | null
): number {
  if (element === null) return 0;
  const offset: number = element.offsetHeight ?? 0;
  if (offset > 0) return offset;
  return element.scrollHeight ?? 0;
}

/**
 * 在子系统折叠面板展开动画完成后触发浏览器原生平滑向下滚动以展现展开内容。
 * 若在等待期间连续展开多个面板，自动取消前序未触发的滚动定时器并顺延至最晚完成的展开面板结束后单次滑动。
 *
 * @param options 折叠容器节点、内容高度、展开时长与共享调度状态引用
 * @returns 取消本次延迟滚动定时器的清理函数（无需滚动时返回 `undefined`）
 */
function scrollViewportAfterCapabilityExpanded({
  wrapEl,
  bodyHeight,
  durationMs,
  expandScrollStateRef,
}: ScrollViewportAfterExpandedOptions): (() => void) | undefined {
  const host: ScrollableViewportHost = globalThis as ScrollableViewportHost;
  const scrollByFn:
    | ((options: { readonly top: number; readonly behavior: "smooth" }) => void)
    | undefined = host.scrollBy;
  if (
    typeof scrollByFn !== "function" ||
    typeof wrapEl.getBoundingClientRect !== "function" ||
    bodyHeight <= 0
  ) {
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
    const viewportHeight: number = host.innerHeight ?? 0;
    if (
      viewportHeight <= 0 ||
      typeof wrapEl.getBoundingClientRect !== "function"
    ) {
      return;
    }
    const wrapRect: { readonly top: number; readonly height: number } =
      wrapEl.getBoundingClientRect();
    const actualBodyHeight: number = Math.max(wrapRect.height, bodyHeight);
    const blockTop: number = wrapRect.top - MINI_APP_CAP_HEADER_ESTIMATED_HEIGHT_PX;
    const maxScrollKeepHeader: number = Math.max(
      0,
      blockTop - MINI_APP_CAP_SCROLL_TOP_MARGIN_PX
    );
    const expandedBottom: number = wrapRect.top + actualBodyHeight;
    const overflowBottom: number = Math.max(
      0,
      expandedBottom + MINI_APP_CAP_SCROLL_BOTTOM_MARGIN_PX - viewportHeight
    );
    const comfortTargetTop: number =
      viewportHeight * MINI_APP_CAP_SCROLL_COMFORT_TOP_RATIO;
    const comfortShift: number =
      blockTop > comfortTargetTop
        ? Math.min(
          actualBodyHeight * MINI_APP_CAP_SCROLL_COMFORT_BODY_FACTOR,
          blockTop - comfortTargetTop
        )
        : 0;
    const scrollDelta: number = Math.min(
      maxScrollKeepHeader,
      Math.max(overflowBottom, Math.round(comfortShift))
    );
    if (scrollDelta > MINI_APP_CAP_SCROLL_MIN_DELTA_PX) {
      scrollByFn.call(host, { top: scrollDelta, behavior: "smooth" });
    }
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
 * 基于真实像素高度与自适应过渡时长平滑展开/收起的子系统折叠面板容器。
 *
 * @param props 展开状态、共享滚动调度引用与子节点
 * @returns React 节点
 */
export function CapabilityCollapseBody({
  expanded,
  expandScrollStateRef,
  children,
}: CapabilityCollapseBodyProps): React.JSX.Element {
  const wrapRef: React.RefObject<MeasurableCollapseWrapElement | null> =
    useRef<MeasurableCollapseWrapElement | null>(null);
  const bodyRef: React.RefObject<MeasurableCollapseElement | null> =
    useRef<MeasurableCollapseElement | null>(null);
  const lastHeightRef: React.RefObject<number> = useRef<number>(0);
  const prevExpandedRef: React.RefObject<boolean> = useRef<boolean>(expanded);

  const setWrapNode: (el: MeasurableCollapseWrapElement | null) => void =
    useCallback((el: MeasurableCollapseWrapElement | null): void => {
      wrapRef.current = el;
    }, []);
  const setBodyNode: (el: MeasurableCollapseElement | null) => void =
    useCallback((el: MeasurableCollapseElement | null): void => {
      bodyRef.current = el;
      const measured: number = readCollapseBodyHeight(el);
      if (measured > 0) {
        lastHeightRef.current = measured;
      }
    }, []);

  useEffect((): void => {
    const measured: number = readCollapseBodyHeight(bodyRef.current);
    if (measured > 0) {
      lastHeightRef.current = measured;
    }
    const wrapEl: MeasurableCollapseWrapElement | null = wrapRef.current;
    if (wrapEl?.style === undefined) return;
    const effectiveHeight: number =
      measured > 0 ? measured : lastHeightRef.current;
    const durationMs: number =
      computeCapabilityCollapseDurationMs(effectiveHeight);
    wrapEl.style.setProperty?.("--cap-duration", `${durationMs}ms`);
    if (expanded && measured > 0) {
      const nextHeightCss: string = `${measured}px`;
      if (wrapEl.style.height !== nextHeightCss) {
        wrapEl.style.height = nextHeightCss;
      }
    }
  }, [expanded, children]);

  useEffect((): (() => void) | undefined => {
    const wasExpanded: boolean = prevExpandedRef.current;
    prevExpandedRef.current = expanded;
    if (!wasExpanded && expanded) {
      const wrapEl: MeasurableCollapseWrapElement | null = wrapRef.current;
      const measured: number = readCollapseBodyHeight(bodyRef.current);
      const effectiveHeight: number =
        measured > 0 ? measured : lastHeightRef.current;
      if (wrapEl !== null && effectiveHeight > 0) {
        const durationMs: number =
          computeCapabilityCollapseDurationMs(effectiveHeight);
        return scrollViewportAfterCapabilityExpanded({
          wrapEl,
          bodyHeight: effectiveHeight,
          durationMs,
          expandScrollStateRef,
        });
      }
    }
    return undefined;
  }, [expanded, expandScrollStateRef]);

  const currentMeasured: number = readCollapseBodyHeight(bodyRef.current);
  const effectiveHeight: number =
    currentMeasured > 0 ? currentMeasured : lastHeightRef.current;
  const durationMs: number =
    computeCapabilityCollapseDurationMs(effectiveHeight);
  const targetHeightCss: string =
    expanded ? (effectiveHeight > 0 ? `${effectiveHeight}px` : "auto") : "0px";
  const wrapStyle: CollapseWrapInlineStyle = {
    height: targetHeightCss,
    "--cap-duration": `${durationMs}ms`,
  };

  return (
    <div
      ref={setWrapNode}
      className={`cap-collapse-wrap ${expanded ? "expanded" : ""}`}
      style={wrapStyle}
      aria-hidden={!expanded}
    >
      <div ref={setBodyNode} className="cap-body">
        {children}
      </div>
    </div>
  );
}
