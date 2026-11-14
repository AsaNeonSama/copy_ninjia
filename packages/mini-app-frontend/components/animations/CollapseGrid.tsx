import { useRef } from "react";
import type React from "react";
import {
  MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME,
  MINI_APP_INLINE_NOTICE_INNER_CLASS_NAME,
} from "../../consts/animation";
import { MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS } from "../../consts/miniApp";
import { useFlipCollapseLayoutEffect } from "./flipCollapse";
import type {
  FlipAnimatableElement,
  FlipFollowScrollResolver,
  UseFlipCollapseLayoutEffectResult,
} from "./flipCollapse";
import { useDelayedUnmount } from "./useDelayedUnmount";
import type { DelayedUnmountState } from "./useDelayedUnmount";

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
  /** 是否同步对内层节点执行透明度过渡（缺省按容器类名自动判定）。 */
  readonly fadeInner?: boolean;
  /** 首次挂载即处于展开态时是否从零高播放展开过渡（缺省 `false`）。 */
  readonly animateOnInitialExpand?: boolean;
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
 * 基于绘制前单次测量与单时钟快出急停逐帧写入外层 `height`、内层 `translate3d`/`opacity` 及可选同帧视口滚动的通用展开/收起包装组件。
 *
 * @param props 展开状态、外层/内层类名、上下文重置键、透明度过渡标志、首次展开动画标志、视口滚动解析回调与子节点
 * @returns React 节点
 */
export function CollapseGrid({
  expanded,
  gridClassName,
  innerClassName,
  resetKey,
  fadeInner,
  animateOnInitialExpand,
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
    fadeInner,
    animateOnInitialExpand,
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

/** `InlineNoticeCollapse` 页内提示横幅/操作结果/进度提示统一折叠包装组件的属性参数。 */
export interface InlineNoticeCollapseProps<T> {
  /** 当前激活的提示数据（关闭态传入 `null`，收起飞行期间自动保留上一份非空快照直至动画结束）。 */
  readonly activeValue: T | null;
  /** 可选上下文切换键（切换时直接同步状态而不播放跨上下文折叠动画）。 */
  readonly resetKey?: string | number | null;
  /** 首次挂载即有非空值时是否播放展开过渡（缺省 `false`）。 */
  readonly animateOnInitialExpand?: boolean;
  /** 根据当前展示快照渲染内部提示节点的渲染函数。 */
  readonly children: (value: T) => React.ReactNode;
}

/**
 * 为页内错误横幅、批量操作结果卡片与上传进度提示提供统一的折叠展开/收起过渡与延迟卸载包装组件。
 *
 * @param props 当前提示值、可选上下文重置键、首次展开动画标志与渲染回调
 * @returns React 节点
 */
export function InlineNoticeCollapse<T>({
  activeValue,
  resetKey,
  animateOnInitialExpand = false,
  children,
}: InlineNoticeCollapseProps<T>): React.JSX.Element {
  const { displayValue }: Readonly<DelayedUnmountState<T>> = useDelayedUnmount(
    activeValue,
    MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS
  );
  const normalizedResetKey: string | null | undefined =
    typeof resetKey === "number" ? String(resetKey) : resetKey;
  return (
    <CollapseGrid
      expanded={activeValue !== null}
      gridClassName={MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME}
      innerClassName={MINI_APP_INLINE_NOTICE_INNER_CLASS_NAME}
      resetKey={normalizedResetKey}
      fadeInner
      animateOnInitialExpand={animateOnInitialExpand}
    >
      {displayValue !== null ? children(displayValue) : null}
    </CollapseGrid>
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
 * 在与下方编辑表单互换时由配对 `CollapseGrid` 统一协同驱动同起点重叠快出过渡的触发按钮折叠包装组件。
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
