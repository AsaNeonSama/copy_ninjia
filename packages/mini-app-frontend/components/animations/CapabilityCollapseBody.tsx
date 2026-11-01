import type React from "react";
import { resolveExpandFollowScrollTarget } from "./expandFollowScroll";
import type {
  ViewportAnchorScroll,
  ViewportAnchorScrollTarget,
} from "./expandFollowScroll";
import { useFlipCollapseLayoutEffect } from "./flipCollapse";
import type {
  FlipAnimatableElement,
  UseFlipCollapseLayoutEffectResult,
} from "./flipCollapse";

/** `CapabilityCollapseBody` 折叠动画容器的属性参数。 */
export interface CapabilityCollapseBodyProps {
  /** 当前面板是否处于展开状态。 */
  readonly expanded: boolean;
  /** 跨子系统面板共享的跟滚槽位（连续展开多项时只由最后一次展开驱动视口）。 */
  readonly followScrollSlotRef: React.RefObject<ViewportAnchorScroll | null>;
  /** 面板内部渲染内容。 */
  readonly children: React.ReactNode;
}

/**
 * 解析子系统面板展开的同帧跟滚目标：以所在 `.cap-block`（折叠容器父节点，顶部即标题栏顶部）为锚点。
 *
 * @param gridElement 折叠外层容器节点
 * @param expandedHeightPx 展开完成后的内容高度
 * @returns 跟滚目标或 `null`
 */
function resolveCapabilityFollowScroll(
  gridElement: FlipAnimatableElement,
  expandedHeightPx: number
): ViewportAnchorScrollTarget | null {
  return resolveExpandFollowScrollTarget(
    gridElement.parentElement ?? null,
    gridElement,
    expandedHeightPx
  );
}

/**
 * 子系统折叠面板容器：展开/收起按 `useFlipCollapseLayoutEffect` 单时钟逐帧过渡，展开时同帧跟滚到标题栏与内容可见。
 *
 * @param props 展开状态、共享跟滚槽位与子节点
 * @returns React 节点
 */
export function CapabilityCollapseBody({
  expanded,
  followScrollSlotRef,
  children,
}: CapabilityCollapseBodyProps): React.JSX.Element {
  const {
    gridRef,
    innerRef,
    isClosing,
  }: UseFlipCollapseLayoutEffectResult = useFlipCollapseLayoutEffect({
    expanded,
    resolveFollowScroll: resolveCapabilityFollowScroll,
    followScrollSlotRef,
  });

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
