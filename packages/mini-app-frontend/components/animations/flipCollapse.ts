import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import type React from "react";
import type {
  ViewportAnchorScroll,
  ViewportAnchorScrollTarget,
} from "./expandFollowScroll";
import type {
  FlipAnimatableElement,
  FlipFollowScrollResolver,
} from "./flipCollapseGeometry";
import { runFlipCollapseTransition } from "./flipCollapseTransition";

export {
  computeFlipCollapseDurationMs,
  findPairedTriggerElement,
  formatTranslate3dYWithDpr,
  hasCollapsedFlipGridAncestor,
  shouldFadeInnerPanel,
} from "./flipCollapseGeometry";
export type {
  FlipAnimatableElement,
  FlipClassList,
  FlipDataset,
  FlipFollowScrollResolver,
  FlipStyleDeclaration,
} from "./flipCollapseGeometry";
export { runFlipCollapseTransition } from "./flipCollapseTransition";
export type { RunFlipCollapseTransitionOptions } from "./flipCollapseTransition";

/** `useFlipCollapseLayoutEffect` Hook 的入参接口。 */
export interface UseFlipCollapseLayoutEffectOptions {
  /** 当前面板是否处于展开状态。 */
  readonly expanded: boolean;
  /** 可选的上下文切换键（如弹窗当前激活的标签页 key；该键变化时直接同步状态而不播放跨标签折叠动画）。 */
  readonly resetKey?: string | null;
  /** 是否同步对内层节点执行透明度过渡（缺省按容器类名自动判定）。 */
  readonly fadeInner?: boolean;
  /** 首次挂载即处于展开态时是否从零高播放展开过渡（缺省 `false`）。 */
  readonly animateOnInitialExpand?: boolean;
  /** 可选的外部网格容器节点引用（提供时复用该引用，供父组件读取实时几何位置）。 */
  readonly gridRef?: React.RefObject<FlipAnimatableElement | null>;
  /** 展开起始时解析同帧视口跟滚目标的回调（按最新一次渲染传入的回调执行）。 */
  readonly resolveFollowScroll?: FlipFollowScrollResolver;
  /** 收起起始时解析同帧视口滚动目标的回调（按最新一次渲染传入的回调执行）。 */
  readonly resolveCollapseScroll?: FlipFollowScrollResolver;
  /** 多个面板可同时过渡时共享的跟滚槽位。 */
  readonly followScrollSlotRef?: React.RefObject<ViewportAnchorScroll | null>;
}

/** `useFlipCollapseLayoutEffect` Hook 的返回值接口。 */
export interface UseFlipCollapseLayoutEffectResult {
  /** 绑定到外层网格容器节点的 `RefObject`。 */
  readonly gridRef: React.RefObject<FlipAnimatableElement | null>;
  /** 绑定到内层裁剪容器节点的 `RefObject`。 */
  readonly innerRef: React.RefObject<FlipAnimatableElement | null>;
  /** 当前是否处于收起过渡飞行期（供组件在渲染期拼入 `.flip-closing` 类名）。 */
  readonly isClosing: boolean;
}

/** `syncFlipCollapseLayoutEffect` 同步布局过渡副作用的参数接口。 */
export interface SyncFlipCollapseLayoutEffectOptions {
  /** 当前目标展开态。 */
  readonly expanded: boolean;
  /** 当前上下文重置键。 */
  readonly resetKey: string | null;
  /** 是否同步对内层节点执行透明度过渡。 */
  readonly fadeInner?: boolean;
  /** 首次挂载即处于展开态时是否从零高播放展开过渡（缺省 `false`）。 */
  readonly animateOnInitialExpand?: boolean;
  /** 标记当前是否处于组件首次挂载布局提交的引用（消费一次后置为 `false`）。 */
  readonly initialMountRef?: React.RefObject<boolean>;
  /** 外层网格节点引用。 */
  readonly gridRef: React.RefObject<FlipAnimatableElement | null>;
  /** 内层面板节点引用。 */
  readonly innerRef: React.RefObject<FlipAnimatableElement | null>;
  /** 上一次展开态引用。 */
  readonly prevExpandedRef: React.RefObject<boolean>;
  /** 上一次上下文重置键引用。 */
  readonly prevResetKeyRef: React.RefObject<string | null>;
  /** 收起飞行态激活标志引用。 */
  readonly closingActiveRef: React.RefObject<boolean>;
  /** 展开起始时解析同帧视口跟滚目标的回调。 */
  readonly resolveFollowScroll?: FlipFollowScrollResolver;
  /** 收起起始时解析同帧视口滚动目标的回调。 */
  readonly resolveCollapseScroll?: FlipFollowScrollResolver;
  /** 多个面板可同时过渡时共享的跟滚槽位。 */
  readonly followScrollSlotRef?: React.RefObject<ViewportAnchorScroll | null>;
}

/**
 * 同步单次布局提交中的展开/收起状态变化与上下文重置键切换，按需启动 `runFlipCollapseTransition`。
 *
 * @param options 状态引用与目标展开参数
 * @returns 过渡清理函数或 `undefined`
 */
export function syncFlipCollapseLayoutEffect({
  expanded,
  resetKey,
  fadeInner,
  animateOnInitialExpand = false,
  initialMountRef,
  gridRef,
  innerRef,
  prevExpandedRef,
  prevResetKeyRef,
  closingActiveRef,
  resolveFollowScroll,
  resolveCollapseScroll,
  followScrollSlotRef,
}: SyncFlipCollapseLayoutEffectOptions): (() => void) | undefined {
  const isInitialMount: boolean =
    initialMountRef !== undefined ? initialMountRef.current : true;
  if (initialMountRef !== undefined) {
    initialMountRef.current = false;
  }
  const rawWasExpanded: boolean = prevExpandedRef.current;
  const prevResetKey: string | null = prevResetKeyRef.current;
  prevExpandedRef.current = expanded;
  prevResetKeyRef.current = resetKey;
  const wasExpanded: boolean =
    isInitialMount && animateOnInitialExpand && expanded ? false : rawWasExpanded;

  const gridEl: FlipAnimatableElement | null = gridRef.current;
  const innerEl: FlipAnimatableElement | null = innerRef.current;
  if (prevResetKey !== resetKey) {
    closingActiveRef.current = false;
    gridEl?.classList?.remove("flip-closing");
    if (innerEl?.dataset !== undefined) delete innerEl.dataset.flipInterruptedProgress;
    return undefined;
  }
  if (wasExpanded === expanded) {
    // 展开态未变的重跑（其余依赖变化）已由上一轮清理清除行内样式，面板落在 CSS 终态，打断进度随之作废。
    closingActiveRef.current = false;
    if (!expanded) {
      gridEl?.classList?.remove("flip-closing");
    }
    if (innerEl?.dataset !== undefined) delete innerEl.dataset.flipInterruptedProgress;
    return undefined;
  }
  if (gridEl === null || innerEl === null) {
    closingActiveRef.current = false;
    return undefined;
  }
  const wasOneFrInDom: boolean =
    wasExpanded ||
    innerEl.dataset?.flipInFlight === "1" ||
    innerEl.dataset?.flipInterruptedProgress !== undefined;
  closingActiveRef.current = !expanded;
  return runFlipCollapseTransition({
    gridEl,
    innerEl,
    expanded,
    wasOneFrInDom,
    fadeInner,
    onClosingCleared: (): void => {
      closingActiveRef.current = false;
    },
    resolveFollowScroll,
    resolveCollapseScroll,
    followScrollSlotRef,
  });
}

/**
 * 为折叠容器组件接入绘制前测量与单时钟快出急停展开/收起过渡的 React Hook（SSR 环境自动降级为无副作用）。
 *
 * @param options 展开状态、可选上下文重置键与视口滚动参数
 * @returns 外层/内层节点引用与收起飞行态标志
 */
export function useFlipCollapseLayoutEffect({
  expanded,
  resetKey = null,
  fadeInner,
  animateOnInitialExpand = false,
  gridRef: externalGridRef,
  resolveFollowScroll,
  resolveCollapseScroll,
  followScrollSlotRef,
}: UseFlipCollapseLayoutEffectOptions): UseFlipCollapseLayoutEffectResult {
  const internalGridRef: React.RefObject<FlipAnimatableElement | null> = useRef<FlipAnimatableElement | null>(null);
  const gridRef: React.RefObject<FlipAnimatableElement | null> = externalGridRef ?? internalGridRef;
  const innerRef: React.RefObject<FlipAnimatableElement | null> = useRef<FlipAnimatableElement | null>(null);
  const initialMountRef: React.RefObject<boolean> = useRef<boolean>(true);
  const prevExpandedRef: React.RefObject<boolean> = useRef<boolean>(expanded);
  const prevResetKeyRef: React.RefObject<string | null> = useRef<string | null>(resetKey);
  const closingActiveRef: React.RefObject<boolean> = useRef<boolean>(false);
  const resolveExpandScrollEvent: FlipFollowScrollResolver = useEffectEvent(
    (gridElement: FlipAnimatableElement, heightPx: number): ViewportAnchorScrollTarget | null =>
      resolveFollowScroll?.(gridElement, heightPx) ?? null
  );
  const resolveCollapseScrollEvent: FlipFollowScrollResolver = useEffectEvent(
    (gridElement: FlipAnimatableElement, heightPx: number): ViewportAnchorScrollTarget | null =>
      resolveCollapseScroll?.(gridElement, heightPx) ?? null
  );

  if (prevResetKeyRef.current !== resetKey) {
    closingActiveRef.current = false;
  } else if (prevExpandedRef.current && !expanded) {
    closingActiveRef.current = true;
  } else if (expanded) {
    closingActiveRef.current = false;
  }
  const isClosing: boolean = closingActiveRef.current && !expanded;

  const hasDomDocument: boolean = (globalThis as { readonly document?: unknown }).document !== undefined;
  const useIsoLayoutEffect: typeof useEffect = hasDomDocument ? useLayoutEffect : useEffect;

  useIsoLayoutEffect(
    (): (() => void) | undefined =>
      syncFlipCollapseLayoutEffect({
        expanded,
        resetKey,
        fadeInner,
        animateOnInitialExpand,
        initialMountRef,
        gridRef,
        innerRef,
        prevExpandedRef,
        prevResetKeyRef,
        closingActiveRef,
        resolveFollowScroll: resolveExpandScrollEvent,
        resolveCollapseScroll: resolveCollapseScrollEvent,
        followScrollSlotRef,
      }),
    [animateOnInitialExpand, expanded, fadeInner, followScrollSlotRef, gridRef, resetKey]
  );

  return { gridRef, innerRef, isClosing };
}
