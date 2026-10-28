import type React from "react";
import type { ViewportRectElement } from "./expandFollowScroll";

/** `CollapseGrid` 展开/收起过渡容器组件的属性参数。 */
export interface CollapseGridProps {
  /** 是否处于展开态（为 `true` 时附加 `.expanded` 类名，否则设置 `aria-hidden="true"`）。 */
  readonly expanded: boolean;
  /** 外层 CSS Grid 容器类名（定义 `grid-template-rows: 0fr -> 1fr` 过渡）。 */
  readonly gridClassName: string;
  /** 内层裁剪容器类名（定义 `overflow: hidden; min-height: 0`）。 */
  readonly innerClassName: string;
  /** 外层网格自身的 `grid-template-rows` 展开过渡结束时的回调（参数为外层网格节点）；收起过渡结束与子孙节点冒泡上来的过渡结束事件不触发。 */
  readonly onExpandEnd?: (gridElement: ViewportRectElement) => void;
  /** 折叠面板内部子节点。 */
  readonly children: React.ReactNode;
}

/**
 * 配合 CSS Grid `0fr <-> 1fr` 规则实现平滑高度展开与收起动画的通用包装组件。
 *
 * @param props 展开状态、外层/内层类名、展开结束回调与子节点
 * @returns React 节点
 */
export function CollapseGrid({
  expanded,
  gridClassName,
  innerClassName,
  onExpandEnd,
  children,
}: CollapseGridProps): React.JSX.Element {
  const handleTransitionEnd:
    | ((event: React.TransitionEvent<HTMLDivElement>) => void)
    | undefined =
    onExpandEnd === undefined
      ? undefined
      : (event: React.TransitionEvent<HTMLDivElement>): void => {
        if (
          !expanded ||
          event.target !== event.currentTarget ||
          event.propertyName !== "grid-template-rows"
        ) {
          return;
        }
        onExpandEnd(event.currentTarget as unknown as ViewportRectElement);
      };
  return (
    <div
      className={`${gridClassName} ${expanded ? "expanded" : ""}`}
      aria-hidden={!expanded}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className={innerClassName}>{children}</div>
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
  /** 触发按钮子节点。 */
  readonly children: React.ReactNode;
}

/**
 * 配合 CSS Grid `1fr <-> 0fr` 规则在展开编辑表单时同步平滑收起顶部触发按钮的动画包装组件。
 *
 * @param props 收起状态、外层/内层类名与触发按钮子节点
 * @returns React 节点
 */
export function TriggerCollapseGrid({
  collapsed,
  gridClassName,
  innerClassName,
  children,
}: TriggerCollapseGridProps): React.JSX.Element {
  return (
    <div
      className={`${gridClassName} ${collapsed ? "collapsed" : ""}`}
      aria-hidden={collapsed}
    >
      <div className={innerClassName}>{children}</div>
    </div>
  );
}
