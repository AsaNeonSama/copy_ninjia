import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import type React from "react";
import {
  MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS,
  MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS,
  MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS,
  MINI_APP_FLIP_COLLAPSE_DURATION_MS,
} from "../../consts/miniApp";
import { startViewportAnchorScroll } from "./expandFollowScroll";
import type {
  ViewportAnchorScroll,
  ViewportAnchorScrollTarget,
  ViewportRectElement,
} from "./expandFollowScroll";
import { runFrameMotion } from "./frameMotion";

/** 逐帧写入折叠容器高度与内层面板位移/透明度的行内样式最小接口。 */
export interface FlipStyleDeclaration {
  /** CSS `height` 属性（外层折叠容器逐帧高度）。 */
  height?: string;
  /** CSS `margin-top` 属性（与顶部配对触发器重叠过渡时抵消触发器占高，保持面板顶部原点稳定）。 */
  marginTop?: string;
  /** CSS `transform` 属性（内层面板在裁剪框内的纵向位移）。 */
  transform: string;
  /** CSS `will-change` 属性。 */
  willChange: string;
  /** CSS `opacity` 属性。 */
  opacity?: string;
  /** CSS `pointer-events` 属性。 */
  pointerEvents?: string;
}

/** 支持增删与检测 CSS 类名的 `classList` 最小接口。 */
export interface FlipClassList {
  /** 添加一个或多个类名。 */
  readonly add: (...tokens: string[]) => void;
  /** 移除一个或多个类名。 */
  readonly remove: (...tokens: string[]) => void;
  /** 判断是否包含指定类名。 */
  readonly contains: (token: string) => boolean;
}

/** 挂载在折叠面板或配对触发器节点上的飞行状态与半途打断进度 `dataset` 属性。 */
export interface FlipDataset {
  /** 标记当前节点为与下方折叠面板配对的顶部触发器容器（`"1"`）。 */
  flipTrigger?: string;
  /** 标记配对触发器正处于收起飞行态（`"1"` 表示飞行中）。 */
  flipTriggerClosing?: string;
  /** 标记内层面板正处于逐帧动画飞行态（`"1"` 表示飞行中）。 */
  flipInFlight?: string;
  /** 半途打断时记录的展开进度文本（`0..1`，`0` 为收起、`1` 为完全展开），供下一次过渡从该进度续接。 */
  flipInterruptedProgress?: string;
}

/** 支持几何测量、类名切换与行内样式写入的折叠动画 DOM 元素最小接口。 */
export interface FlipAnimatableElement extends ViewportRectElement {
  /** 标签名（大写，如 `"SECTION"`）。 */
  readonly tagName?: string;
  /** 元素 ID。 */
  readonly id?: string;
  /** 元素行内样式对象。 */
  readonly style?: FlipStyleDeclaration;
  /** 元素类名集合。 */
  readonly classList?: FlipClassList;
  /** 元素 `data-*` 属性集。 */
  readonly dataset?: FlipDataset;
  /** 父元素节点。 */
  readonly parentElement?: FlipAnimatableElement | null;
  /** 前一个同级元素节点（用于定位与折叠面板紧邻配对的 `TriggerCollapseGrid`）。 */
  readonly previousElementSibling?: FlipAnimatableElement | null;
  /** 第一个子元素节点（配对触发器的内层节点）。 */
  readonly firstElementChild?: FlipAnimatableElement | null;
  /** 读取 HTML 属性（用于检测外层折叠容器是否处于 `aria-hidden="true"` 收起态）。 */
  readonly getAttribute?: (qualifiedName: string) => string | null;
}

/** 过渡起始时解析同帧视口滚动目标的回调：入参为外层折叠容器与本次过渡的高度（展开为展开完成后的高度，收起为将收掉的高度），返回 `null` 时不滚动。 */
export type FlipFollowScrollResolver = (
  gridElement: FlipAnimatableElement,
  heightPx: number
) => ViewportAnchorScrollTarget | null;

/**
 * 判断祖先节点是否为页面或弹窗内容区的折叠遍历停止边界。
 *
 * @param element 待判断的祖先节点
 * @returns 到达页面/弹窗边界时返回 `true`
 */
function isFlipBoundaryElement(element: FlipAnimatableElement): boolean {
  if (element.tagName === "SECTION" || element.tagName === "MAIN" || element.id === "root") {
    return true;
  }
  const classList: FlipClassList | undefined = element.classList;
  if (classList === undefined) return false;
  return (
    classList.contains("chat-targets-tab-pane") ||
    classList.contains("chat-targets-modal-body") ||
    classList.contains("app-main") ||
    classList.contains("animate-fade-in")
  );
}

/**
 * 检测当前折叠网格是否嵌套在另一个正在收起或已收起的外层折叠网格内部
 * （当父子折叠网格在同一提交批次同时收起时，内层维持展开高度随外层整体平滑收起）。
 *
 * @param gridEl 当前折叠网格节点
 * @returns 存在已收起外层折叠网格祖先时返回 `true`
 */
export function hasCollapsedFlipGridAncestor(gridEl: FlipAnimatableElement): boolean {
  let curr: FlipAnimatableElement | null = gridEl.parentElement ?? null;
  while (curr !== null && !isFlipBoundaryElement(curr)) {
    if (
      curr.getAttribute?.("aria-hidden") === "true" ||
      curr.classList?.contains("flip-closing") === true
    ) {
      return true;
    }
    curr = curr.parentElement ?? null;
  }
  return false;
}

/**
 * 判断当前折叠网格在展开/收起时是否同步执行内层透明度渐变（触发按钮与表单互换、图库预览卡片等独立面板开启透明度过渡）。
 *
 * @param gridEl 外层折叠网格节点
 * @returns 需要同步渐变 `opacity` 时返回 `true`
 */
function shouldFadeInnerPanel(gridEl: FlipAnimatableElement): boolean {
  const classList: FlipClassList | undefined = gridEl.classList;
  if (classList === undefined) return false;
  return (
    classList.contains("chat-targets-qa-trigger-collapse") ||
    classList.contains("chat-targets-qa-collapse-grid") ||
    classList.contains("totp-trigger-collapse-grid") ||
    classList.contains("totp-setup-collapse-grid") ||
    classList.contains("gallery-preview-collapse-grid")
  );
}

/**
 * 将纵向像素偏移取整后格式化为 `translate3d(0, Ypx, 0)` 字符串。
 *
 * @param offsetYPx 纵向像素偏移
 * @returns CSS `transform` 字符串
 */
export function formatTranslate3dY(offsetYPx: number): string {
  const rounded: number = Math.round(offsetYPx);
  return rounded === 0 ? "translate3d(0, 0, 0)" : `translate3d(0, ${rounded}px, 0)`;
}

/**
 * 将 `0..1` 的透明度保留三位小数格式化为 CSS `opacity` 字符串。
 *
 * @param value 透明度
 * @returns CSS `opacity` 字符串
 */
function formatOpacity(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * 按过渡方向与高度跨度计算完整过渡的时长：展开为 `MINI_APP_FLIP_COLLAPSE_DURATION_MS`；
 * 收起取「跨度 ÷ `MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS`」与展开时长的较大值，并以 `MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS` 为上限。
 *
 * @param spanPx 收起态与展开态之间的高度跨度
 * @param expanded 目标是否为展开态
 * @returns 从一端到另一端的完整过渡毫秒数
 */
export function computeFlipCollapseDurationMs(spanPx: number, expanded: boolean): number {
  if (expanded) return MINI_APP_FLIP_COLLAPSE_DURATION_MS;
  return Math.min(
    MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS,
    Math.max(
      MINI_APP_FLIP_COLLAPSE_DURATION_MS,
      Math.round(spanPx / MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS)
    )
  );
}

/**
 * 查找紧邻当前折叠网格上方的配对 `TriggerCollapseGrid` 节点（如验证器页面顶部操作栏或 QA 弹窗顶部新增按钮）。
 *
 * @param gridEl 外层折叠网格节点
 * @returns 配对的触发器容器节点（不存在时返回 `null`）
 */
export function findPairedTriggerElement(gridEl: FlipAnimatableElement): FlipAnimatableElement | null {
  const prev: FlipAnimatableElement | null = gridEl.previousElementSibling ?? null;
  if (prev === null) return null;
  if (
    prev.dataset?.flipTrigger === "1" ||
    prev.getAttribute?.("data-flip-trigger") === "1" ||
    prev.classList?.contains("totp-trigger-collapse-grid") === true ||
    prev.classList?.contains("chat-targets-qa-trigger-collapse") === true
  ) {
    return prev;
  }
  return null;
}

/** `runFlipCollapseTransition` 执行单次折叠过渡的参数接口。 */
export interface RunFlipCollapseTransitionOptions {
  /** 外层折叠裁剪容器节点。 */
  readonly gridEl: FlipAnimatableElement;
  /** 内层刚性高度内容节点。 */
  readonly innerEl: FlipAnimatableElement;
  /** 当前目标是否为展开态。 */
  readonly expanded: boolean;
  /** 本次提交前该面板是否已处于展开或飞行布局态（无打断进度时从完全展开起步）。 */
  readonly wasOneFrInDom: boolean;
  /** 是否同步对内层节点执行透明度过渡（缺省按容器类名自动判定）。 */
  readonly fadeInner?: boolean;
  /** 收起过渡结束时的清理通知回调（用于同步复位 `closingActiveRef`）。 */
  readonly onClosingCleared?: () => void;
  /** 展开起始时解析同帧视口跟滚目标的回调（入参为展开完成后的高度）。 */
  readonly resolveFollowScroll?: FlipFollowScrollResolver;
  /** 收起起始时解析同帧视口滚动目标的回调（入参为将收掉的高度）。 */
  readonly resolveCollapseScroll?: FlipFollowScrollResolver;
  /** 多个面板可同时过渡时共享的跟滚槽位：新的视口滚动启动时停止槽内旧滚动，保证只有最后启动的一次驱动视口。 */
  readonly followScrollSlotRef?: React.RefObject<ViewportAnchorScroll | null>;
}

/**
 * 在 DOM 提交后、浏览器绘制前测量内层面板与可选配对触发器的自然高度，写入起始帧样式，
 * 再以 `runFrameMotion` 的单一时钟逐帧写入外层容器 `height`、内层面板 `translate3d`/`opacity`、
 * 配对触发器的位移/透明度与可选的视口滚动：所有值都由同一展开进度派生，同帧提交，互不错位。
 * 无配对触发器时内层面板位移等于「当前高度 − 展开高度」，面板下沿始终贴住裁剪框下沿；
 * 有配对触发器时面板只滑动 16px 并与触发按钮交叉渐变。时长按 `computeFlipCollapseDurationMs` 取完整过渡时长再乘以剩余进度。
 *
 * @param options 外层节点、内层节点、目标展开态、视口滚动与结束回调
 * @returns 取消本次动画的清理函数（记录打断进度并清除行内样式；无需动画时返回 `undefined`）
 */
export function runFlipCollapseTransition({
  gridEl,
  innerEl,
  expanded,
  wasOneFrInDom,
  fadeInner,
  onClosingCleared,
  resolveFollowScroll,
  resolveCollapseScroll,
  followScrollSlotRef,
}: RunFlipCollapseTransitionOptions): (() => void) | undefined {
  const gridStyle: FlipStyleDeclaration | undefined = gridEl.style;
  const innerStyle: FlipStyleDeclaration | undefined = innerEl.style;
  if (gridStyle === undefined || innerStyle === undefined || typeof gridEl.getBoundingClientRect !== "function") {
    if (!expanded) {
      gridEl.classList?.remove("flip-closing");
      onClosingCleared?.();
    }
    return undefined;
  }

  // 若外层折叠网格也在同一次提交中收起，内层维持展开布局随外层整体收起。
  if (hasCollapsedFlipGridAncestor(gridEl)) {
    if (!expanded) {
      gridEl.classList?.add("flip-closing");
      const ancestorTimer: ReturnType<typeof setTimeout> = setTimeout((): void => {
        gridEl.classList?.remove("flip-closing");
        onClosingCleared?.();
      }, MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS);
      return (): void => {
        clearTimeout(ancestorTimer);
        gridEl.classList?.remove("flip-closing");
      };
    }
    return undefined;
  }

  const triggerEl: FlipAnimatableElement | null = findPairedTriggerElement(gridEl);
  const triggerInnerStyle: FlipStyleDeclaration | undefined = triggerEl?.firstElementChild?.style;

  if (!expanded) {
    gridEl.classList?.add("flip-closing");
    if (triggerEl !== null) {
      triggerEl.classList?.remove("flip-closing");
      if (triggerEl.dataset !== undefined) delete triggerEl.dataset.flipTriggerClosing;
    }
  } else {
    gridEl.classList?.remove("flip-closing");
    if (triggerEl !== null) {
      triggerEl.classList?.add("flip-closing");
      if (triggerEl.dataset !== undefined) triggerEl.dataset.flipTriggerClosing = "1";
    }
  }

  const innerDataset: FlipDataset | undefined = innerEl.dataset;
  const interruptedProgress: number = Number(innerDataset?.flipInterruptedProgress ?? Number.NaN);
  if (innerDataset !== undefined) delete innerDataset.flipInterruptedProgress;

  gridStyle.height = "";
  gridStyle.marginTop = "";

  const triggerH: number =
    triggerEl !== null && typeof triggerEl.getBoundingClientRect === "function"
      ? Math.max(0, Math.round(triggerEl.getBoundingClientRect().height))
      : 0;
  const measuredGridH: number = Math.max(0, Math.round(gridEl.getBoundingClientRect().height));
  const measuredInnerH: number =
    typeof innerEl.getBoundingClientRect === "function"
      ? Math.max(0, Math.round(innerEl.getBoundingClientRect().height))
      : 0;
  const deltaH: number = Math.max(measuredGridH, measuredInnerH);
  if (deltaH <= 0) {
    if (!expanded) {
      gridEl.classList?.remove("flip-closing");
      onClosingCleared?.();
    } else if (triggerEl !== null) {
      triggerEl.classList?.remove("flip-closing");
      if (triggerEl.dataset !== undefined) delete triggerEl.dataset.flipTriggerClosing;
    }
    return undefined;
  }

  const collapsedH: number = triggerH;
  const spanH: number = Math.max(deltaH, triggerH) - collapsedH;
  const slideRangePx: number = triggerH > 0 ? Math.min(deltaH, 16) : deltaH;
  const triggerSlidePx: number = Math.min(triggerH, 10);
  const shouldFadeInner: boolean = fadeInner ?? (triggerH > 0 || shouldFadeInnerPanel(gridEl));
  const progressStart: number = Number.isFinite(interruptedProgress)
    ? Math.min(1, Math.max(0, interruptedProgress))
    : wasOneFrInDom
      ? 1
      : 0;
  const progressEnd: number = expanded ? 1 : 0;
  let currentProgress: number = progressStart;

  const writeFrame = (progress: number): void => {
    currentProgress = progress;
    gridStyle.height = `${Math.round(collapsedH + spanH * progress)}px`;
    innerStyle.transform = formatTranslate3dY(-slideRangePx * (1 - progress));
    if (shouldFadeInner) innerStyle.opacity = formatOpacity(progress);
    if (triggerH > 0 && triggerInnerStyle !== undefined) {
      triggerInnerStyle.transform = formatTranslate3dY(-triggerSlidePx * progress);
      triggerInnerStyle.opacity = formatOpacity(1 - progress);
    }
  };

  // 起始帧样式在绘制前同步写入，保证首帧与上一状态零跳变。
  if (triggerH > 0) gridStyle.marginTop = `-${triggerH}px`;
  innerStyle.willChange = shouldFadeInner ? "transform, opacity" : "transform";
  innerStyle.pointerEvents = expanded ? "" : "none";
  if (triggerH > 0 && triggerInnerStyle !== undefined) {
    triggerInnerStyle.willChange = "transform, opacity";
  }
  writeFrame(progressStart);
  if (innerDataset !== undefined) innerDataset.flipInFlight = "1";

  let followScroll: ViewportAnchorScroll | null = null;
  const followScrollTarget: ViewportAnchorScrollTarget | null = expanded
    ? resolveFollowScroll?.(gridEl, collapsedH + spanH) ?? null
    : resolveCollapseScroll?.(gridEl, Math.round(spanH * progressStart)) ?? null;
  if (followScrollTarget !== null) {
    followScroll = startViewportAnchorScroll(followScrollTarget);
    if (followScrollSlotRef !== undefined) {
      followScrollSlotRef.current?.dispose();
      followScrollSlotRef.current = followScroll;
    }
  }

  const disposeFollowScroll = (): void => {
    if (followScroll === null) return;
    followScroll.dispose();
    if (followScrollSlotRef?.current === followScroll) followScrollSlotRef.current = null;
    followScroll = null;
  };

  const clearInlineStyles = (): void => {
    if (triggerEl !== null) {
      triggerEl.classList?.remove("flip-closing");
      if (triggerEl.dataset !== undefined) delete triggerEl.dataset.flipTriggerClosing;
    }
    if (triggerInnerStyle !== undefined) {
      triggerInnerStyle.transform = "";
      triggerInnerStyle.willChange = "";
      triggerInnerStyle.opacity = "";
    }
    gridStyle.height = "";
    gridStyle.marginTop = "";
    innerStyle.transform = "";
    innerStyle.willChange = "";
    innerStyle.opacity = "";
    innerStyle.pointerEvents = "";
    if (innerDataset !== undefined) delete innerDataset.flipInFlight;
  };

  let finished: boolean = false;
  const cancelMotion: () => void = runFrameMotion({
    durationMs: Math.round(
      computeFlipCollapseDurationMs(spanH, expanded) * Math.abs(progressEnd - progressStart)
    ),
    onFrame: (easedProgress: number): void => {
      writeFrame(progressStart + (progressEnd - progressStart) * easedProgress);
      followScroll?.step(easedProgress);
    },
    onFinish: (): void => {
      finished = true;
      disposeFollowScroll();
      clearInlineStyles();
      if (!expanded) {
        gridEl.classList?.remove("flip-closing");
        onClosingCleared?.();
      }
    },
  });

  return (): void => {
    if (finished) return;
    cancelMotion();
    disposeFollowScroll();
    if (innerDataset !== undefined) innerDataset.flipInterruptedProgress = String(currentProgress);
    clearInlineStyles();
  };
}

/** `useFlipCollapseLayoutEffect` Hook 的入参接口。 */
export interface UseFlipCollapseLayoutEffectOptions {
  /** 当前面板是否处于展开状态。 */
  readonly expanded: boolean;
  /** 可选的上下文切换键（如弹窗当前激活的标签页 key；该键变化时直接同步状态而不播放跨标签折叠动画）。 */
  readonly resetKey?: string | null;
  /** 是否同步对内层节点执行透明度过渡（缺省按容器类名自动判定）。 */
  readonly fadeInner?: boolean;
  /** 可选的外部网格容器节点引用（提供时复用该引用，便于父组件读取实时几何位置）。 */
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
  /** 当前是否处于收起过渡飞行期（供组件在渲染期直接拼入 `.flip-closing` 类名，避免提交阶段短暂落入 `display: none`）。 */
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
  gridRef,
  innerRef,
  prevExpandedRef,
  prevResetKeyRef,
  closingActiveRef,
  resolveFollowScroll,
  resolveCollapseScroll,
  followScrollSlotRef,
}: SyncFlipCollapseLayoutEffectOptions): (() => void) | undefined {
  const wasExpanded: boolean = prevExpandedRef.current;
  const prevResetKey: string | null = prevResetKeyRef.current;
  prevExpandedRef.current = expanded;
  prevResetKeyRef.current = resetKey;

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
 * 为折叠容器组件接入绘制前测量与单时钟逐帧展开/收起过渡的 React Hook（SSR 环境自动降级为无副作用）。
 *
 * @param options 展开状态、可选上下文重置键与视口滚动参数
 * @returns 外层/内层节点引用与收起飞行态标志
 */
export function useFlipCollapseLayoutEffect({
  expanded,
  resetKey = null,
  fadeInner,
  gridRef: externalGridRef,
  resolveFollowScroll,
  resolveCollapseScroll,
  followScrollSlotRef,
}: UseFlipCollapseLayoutEffectOptions): UseFlipCollapseLayoutEffectResult {
  const internalGridRef: React.RefObject<FlipAnimatableElement | null> = useRef<FlipAnimatableElement | null>(null);
  const gridRef: React.RefObject<FlipAnimatableElement | null> = externalGridRef ?? internalGridRef;
  const innerRef: React.RefObject<FlipAnimatableElement | null> = useRef<FlipAnimatableElement | null>(null);
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
        gridRef,
        innerRef,
        prevExpandedRef,
        prevResetKeyRef,
        closingActiveRef,
        resolveFollowScroll: resolveExpandScrollEvent,
        resolveCollapseScroll: resolveCollapseScrollEvent,
        followScrollSlotRef,
      }),
    [expanded, fadeInner, followScrollSlotRef, gridRef, resetKey]
  );

  return { gridRef, innerRef, isClosing };
}
