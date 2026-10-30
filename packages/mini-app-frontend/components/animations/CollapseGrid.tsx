import { useRef } from "react";
import type React from "react";
import { useFlipCollapseLayoutEffect } from "./flipCollapse";
import type {
  FlipAnimatableElement,
  FlipFollowScrollResolver,
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
  /** 展开起始时解析同帧视口跟滚目标的回调（入参为外层网格节点与展开完成后的高度）。 */
  readonly resolveFollowScroll?: FlipFollowScrollResolver;
  /** 收起起始时解析同帧视口滚动目标的回调（入参为外层网格节点与将收掉的高度）。 */
  readonly resolveCollapseScroll?: FlipFollowScrollResolver;
  /** 折叠面板内部子节点。 */
  readonly children: React.ReactNode;
}

/**
 * 基于绘制前单次测量与单时钟逐帧写入外层 `height`、内层 `translate3d`/`opacity` 及可选同帧视口滚动的通用展开/收起包装组件。
 *
 * @param props 展开状态、外层/内层类名、上下文重置键、视口滚动解析回调与子节点
 * @returns React 节点
 */
export function CollapseGrid({
  expanded,
  gridClassName,
  innerClassName,
  resetKey,
  containerRef,
  resolveFollowScroll,
  resolveCollapseScroll,
  children,
}: CollapseGridProps): React.JSX.Element {
  const {
    gridRef,
    innerRef,
    isClosing,
  }: UseFlipCollapseLayoutEffectResult = useFlipCollapseLayoutEffect({
    expanded,
    resetKey,
    gridRef: containerRef,
    resolveFollowScroll,
    resolveCollapseScroll,
  });
  return (
    <div
      ref={gridRef}
      className={`${gridClassName} ${expanded ? "expanded" : ""}${isClosing ? " flip-closing" : ""}`}
      aria-hidden={!expanded}
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
