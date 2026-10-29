import { useRef } from "react";
import type React from "react";
import type { ViewportRectElement } from "./expandFollowScroll";
import { useFlipCollapseLayoutEffect } from "./flipCollapse";
import type {
  FlipAnimatableElement,
  UseFlipCollapseLayoutEffectResult,
} from "./flipCollapse";

/** `CollapseGrid` 展开/收起过渡容器组件的属性参数。 */
export interface CollapseGridProps {
  /** 是否处于展开态（为 `true` 时附加 `.expanded` 类名，否则设置 `aria-hidden="true"`）。 */
  readonly expanded: boolean;
  /** 外层 CSS Grid 容器类名。 */
  readonly gridClassName: string;
  /** 内层裁剪容器类名（定义 `overflow: hidden; min-height: 0`）。 */
  readonly innerClassName: string;
  /** 面板上下文重置键（如弹窗当前激活的 Tab 键）：该键变化时直接同步新状态，不触发折叠动画。 */
  readonly resetKey?: string | null;
  /** 可选的外层网格容器节点引用（供父组件读取实时几何位置与飞行态标志）。 */
  readonly containerRef?: React.RefObject<FlipAnimatableElement | null>;
  /** 外层网格自身的展开过渡结束时的回调（参数为外层网格节点）；收起过渡结束与子孙节点冒泡上来的过渡结束事件不触发。 */
  readonly onExpandEnd?: (gridElement: ViewportRectElement) => void;
  /** 折叠面板内部子节点。 */
  readonly children: React.ReactNode;
}

/**
 * 构造外层网格节点的 `onTransitionEnd` 处理函数（仅在展开态下自身 `grid-template-rows` 或 `height` 过渡结束时回调 `onExpandEnd`）。
 *
 * @param expanded 当前是否处于展开态
 * @param onExpandEnd 展开结束回调
 * @returns React `TransitionEvent` 处理函数或 `undefined`
 */
export function createCollapseGridTransitionEndHandler(
  expanded: boolean,
  onExpandEnd: ((gridElement: ViewportRectElement) => void) | undefined
): ((event: React.TransitionEvent<HTMLDivElement>) => void) | undefined {
  if (onExpandEnd === undefined) {
    return undefined;
  }
  return (event: React.TransitionEvent<HTMLDivElement>): void => {
    if (
      !expanded ||
      event.target !== event.currentTarget ||
      (event.propertyName !== "grid-template-rows" &&
        event.propertyName !== "height")
    ) {
      return;
    }
    onExpandEnd(event.currentTarget as unknown as ViewportRectElement);
  };
}

/**
 * 基于首帧单次布局测量与外层 `height` + 内层 GPU `translate3d` 同步滑动实现零尾帧跳变展开与收起动画的通用包装组件。
 *
 * @param props 展开状态、外层/内层类名、上下文重置键、展开结束回调与子节点
 * @returns React 节点
 */
export function CollapseGrid({
  expanded,
  gridClassName,
  innerClassName,
  resetKey,
  containerRef,
  onExpandEnd,
  children,
}: CollapseGridProps): React.JSX.Element {
  const notifiedExpandRef: React.RefObject<boolean> = useRef<boolean>(false);
  if (!expanded) {
    notifiedExpandRef.current = false;
  }
  const notifyExpandOnce:
    | ((gridElement: ViewportRectElement) => void)
    | undefined =
      onExpandEnd !== undefined
        ? (gridElement: ViewportRectElement): void => {
          if (notifiedExpandRef.current) {
            return;
          }
          notifiedExpandRef.current = true;
          onExpandEnd(gridElement);
        }
        : undefined;
  const {
    gridRef,
    innerRef,
    isClosing,
  }: UseFlipCollapseLayoutEffectResult = useFlipCollapseLayoutEffect({
    expanded,
    resetKey,
    gridRef: containerRef,
    onExpandEnd: notifyExpandOnce,
  });
  const handleTransitionEnd:
    | ((event: React.TransitionEvent<HTMLDivElement>) => void)
    | undefined = createCollapseGridTransitionEndHandler(
      expanded,
      notifyExpandOnce
    );
  return (
    <div
      ref={gridRef}
      className={`${gridClassName} ${expanded ? "expanded" : ""}${isClosing ? " flip-closing" : ""}`}
      aria-hidden={!expanded}
      onTransitionEnd={handleTransitionEnd}
    >
      <div
        ref={innerRef}
        className={innerClassName}
      >
        {children}
      </div>
    </div>
  );
}

/** `TriggerCollapseGrid` 触发按钮逆向折叠容器组件的属性参数。 */
export interface TriggerCollapseGridProps {
  /** 是否已收起触发器（为 `true` 时附加 `.collapsed` 类名并设置 `aria-hidden="true"`）。 */
  readonly collapsed: boolean;
  /** 外层 CSS Grid 触发器折叠类名。 */
  readonly gridClassName: string;
  /** 内层裁剪容器类名。 */
  readonly innerClassName: string;
  /** 面板上下文重置键（如弹窗当前激活的 Tab 键）：该键变化时直接同步新状态，不触发折叠动画。 */
  readonly resetKey?: string | null;
  /** 触发按钮子节点。 */
  readonly children: React.ReactNode;
}

/**
 * 在与下方编辑表单互换时由配对 `CollapseGrid` 统一协同驱动同起点重叠过渡的触发按钮折叠包装组件。
 *
 * @param props 收起状态、外层/内层类名、可选上下文重置键与触发按钮子节点
 * @returns React 节点
 */
export function TriggerCollapseGrid({
  collapsed,
  gridClassName,
  innerClassName,
  resetKey = null,
  children,
}: TriggerCollapseGridProps): React.JSX.Element {
  const triggerRef: React.RefObject<FlipAnimatableElement | null> =
    useRef<FlipAnimatableElement | null>(null);
  const prevCollapsedRef: React.RefObject<boolean> = useRef<boolean>(collapsed);
  const prevResetKeyRef: React.RefObject<string | null> =
    useRef<string | null>(resetKey);
  const isSameResetKey: boolean = prevResetKeyRef.current === resetKey;
  const isEnteringCollapse: boolean =
    isSameResetKey &&
    !prevCollapsedRef.current &&
    collapsed;
  prevCollapsedRef.current = collapsed;
  prevResetKeyRef.current = resetKey;
  const isClosing: boolean =
    isSameResetKey &&
    collapsed &&
    (isEnteringCollapse ||
      triggerRef.current?.dataset?.flipTriggerClosing === "1");
  return (
    <div
      ref={triggerRef}
      data-flip-trigger="1"
      className={`${gridClassName} ${collapsed ? "collapsed" : ""}${isClosing ? " flip-closing" : ""}`}
      aria-hidden={collapsed}
    >
      <div className={innerClassName}>
        {children}
      </div>
    </div>
  );
}
