import { useEffect, useLayoutEffect, useRef } from "react";
import type React from "react";
import {
  MINI_APP_FLIP_COLLAPSE_DURATION_MS,
  MINI_APP_FLIP_COLLAPSE_EASING,
} from "../../consts/miniApp";
import type { ViewportRectElement } from "./expandFollowScroll";

/** 支持写入折叠容器高度与内层 GPU 合成层平移/透明度过渡样式的行内样式最小接口。 */
export interface FlipStyleDeclaration {
  /** CSS `height` 属性（驱动外层折叠容器与包裹卡片/弹窗同步平滑伸缩）。 */
  height?: string;
  /** CSS `margin-top` 属性（在与顶部配对触发器重叠过渡时抵消触发器占高，保持面板顶部原点稳定）。 */
  marginTop?: string;
  /** CSS `transform` 属性（驱动内层刚性面板在裁剪框内同步上下滑动）。 */
  transform: string;
  /** CSS `transition` 属性。 */
  transition: string;
  /** CSS `will-change` 属性。 */
  willChange: string;
  /** CSS `opacity` 属性。 */
  opacity?: string;
  /** CSS `pointer-events` 属性。 */
  pointerEvents?: string;
}

/** 监听内层节点 `transitionend` 事件的最小事件对象接口。 */
export interface FlipTransitionEndEvent {
  /** 触发过渡结束的目标节点。 */
  readonly target?: unknown;
  /** 完成过渡的 CSS 属性名称。 */
  readonly propertyName?: string;
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

/** 挂载在折叠面板或配对触发器节点上的飞行状态与半途打断采样 `dataset` 属性。 */
export interface FlipDataset {
  /** 标记当前节点为与下方折叠面板配对的顶部触发器容器（`"1"`）。 */
  flipTrigger?: string;
  /** 标记配对触发器正处于收起飞行态（`"1"` 表示飞行中）。 */
  flipTriggerClosing?: string;
  /** 标记当前节点正处于 200ms 过渡飞行态（`"1"` 表示飞行中）。 */
  flipInFlight?: string;
  /** 半途打断时采样记录的外层网格瞬时像素高度文本。 */
  flipInterruptedH?: string;
  /** 半途打断时采样记录的内层面板瞬时纵向平移像素值文本。 */
  flipInterruptedY?: string;
}

/** 支持几何测量、类名切换、样式过渡与事件监听的折叠动画 DOM 元素最小接口。 */
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
  /** 第一个子元素节点（用于驱动配对触发器内层节点的同步位移与透明度过渡）。 */
  readonly firstElementChild?: FlipAnimatableElement | null;
  /** 触发单次样式冲刷的布局宽度只读属性。 */
  readonly offsetWidth?: number;
  /** 读取 HTML 属性（用于检测外层折叠容器是否处于 `aria-hidden="true"` 收起态）。 */
  readonly getAttribute?: (qualifiedName: string) => string | null;
  /** 注册 DOM 事件监听器（用于精确对齐合成器 `transitionend` 结束帧）。 */
  readonly addEventListener?: (type: string, listener: (event: FlipTransitionEndEvent) => void) => void;
  /** 移除 DOM 事件监听器。 */
  readonly removeEventListener?: (type: string, listener: (event: FlipTransitionEndEvent) => void) => void;
}

/** 全局宿主窗口对象的最小读取接口。 */
export interface FlipGlobalHost {
  /** 文档对象（用于判定是否处于浏览器 DOM 环境）。 */
  readonly document?: unknown;
  /** 读取元素当前计算后样式（用于半途打断飞行态动画时采样矩阵位移）。 */
  readonly getComputedStyle?: (element: unknown) => { readonly transform?: string };
}

/**
 * 从 CSS `transform` 字符串（支持 `matrix(...)`、`matrix3d(...)`、`translate3d(...)` 与 `translateY(...)`）解析当前纵向像素偏移量。
 *
 * @param transformText 计算后样式或行内样式中的 `transform` 字符串
 * @returns 纵向位移像素值（无位移或不可解析时返回 `0`）
 */
export function parseCurrentTranslateYPx(transformText: string): number {
  const trimmed: string = transformText.trim();
  if (trimmed.length === 0 || trimmed === "none") return 0;
  if (trimmed.startsWith("matrix3d(") && trimmed.endsWith(")")) {
    const parts: readonly string[] = trimmed.slice(9, -1).split(",");
    const rawTy: number = Number.parseFloat(parts[13] ?? "0");
    return Number.isFinite(rawTy) ? Math.round(rawTy) : 0;
  }
  if (trimmed.startsWith("matrix(") && trimmed.endsWith(")")) {
    const parts: readonly string[] = trimmed.slice(7, -1).split(",");
    const rawTy: number = Number.parseFloat(parts[5] ?? "0");
    return Number.isFinite(rawTy) ? Math.round(rawTy) : 0;
  }
  const match3d: RegExpExecArray | null =
    /translate3d\(\s*[^,]+,\s*([+-]?\d+(?:\.\d+)?)px/u.exec(trimmed);
  if (match3d?.[1] !== undefined) {
    const val: number = Number.parseFloat(match3d[1]);
    return Number.isFinite(val) ? Math.round(val) : 0;
  }
  const matchY: RegExpExecArray | null =
    /translateY\(\s*([+-]?\d+(?:\.\d+)?)px/u.exec(trimmed);
  if (matchY?.[1] !== undefined) {
    const val: number = Number.parseFloat(matchY[1]);
    return Number.isFinite(val) ? Math.round(val) : 0;
  }
  return 0;
}

/**
 * 读取元素在被打断瞬间的真实纵向 GPU 位移像素值（仅在元素处于飞行态时采样计算样式，空闲态零开销返回 `0`）。
 *
 * @param element 目标可动画元素
 * @returns 当前纵向位移像素值
 */
export function readElementCurrentTranslateYPx(element: FlipAnimatableElement | null): number {
  if (element === null) return 0;
  if (element.dataset?.flipInFlight === "1") {
    const host: FlipGlobalHost = globalThis as FlipGlobalHost;
    if (typeof host.getComputedStyle === "function") {
      try {
        const computedTransform: string = (host.getComputedStyle(element).transform ?? "").trim();
        if (computedTransform.length > 0) return parseCurrentTranslateYPx(computedTransform);
      } catch (_error: unknown) {
        // 测试模拟节点非原生 Element 时回退读取行内 transform。
      }
    }
  }
  return parseCurrentTranslateYPx(element.style?.transform ?? "");
}

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
 * 将纵向像素偏移格式化为 GPU 合成层 `translate3d(0, Ypx, 0)` 字符串。
 *
 * @param offsetYPx 纵向像素偏移
 * @returns CSS `transform` 字符串
 */
export function formatTranslate3dY(offsetYPx: number): string {
  const rounded: number = Math.round(offsetYPx);
  return rounded === 0 ? "translate3d(0, 0, 0)" : `translate3d(0, ${rounded}px, 0)`;
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

/** `runFlipCollapseTransition` 执行单次折叠容器高度与刚性内层面板同步滑动过渡的参数接口。 */
export interface RunFlipCollapseTransitionOptions {
  /** 外层折叠裁剪容器节点。 */
  readonly gridEl: FlipAnimatableElement;
  /** 内层刚性高度内容节点。 */
  readonly innerEl: FlipAnimatableElement;
  /** 当前目标是否为展开态。 */
  readonly expanded: boolean;
  /** 本次提交前该面板是否已处于展开或收起飞行布局态。 */
  readonly wasOneFrInDom: boolean;
  /** 是否同步对内层节点执行透明度过渡（缺省按容器类名自动判定）。 */
  readonly fadeInner?: boolean;
  /** 收起飞行态结束时的清理通知回调（用于同步复位 `closingActiveRef`）。 */
  readonly onClosingCleared?: () => void;
  /** 展开过渡结束时的通知回调（用于触发视口平滑跟滚）。 */
  readonly onExpandEnd?: (gridElement: ViewportRectElement) => void;
}

/**
 * 在 DOM 提交后、浏览器绘制前测量内层刚性面板与可选配对触发器的自然高度，
 * 并在同一缓动曲线上同步驱动外层容器 `height` 与内层面板 `translate3d` / `opacity`，
 * 使下拉上收滑动动画与外层卡片/弹窗高度伸缩在每一帧严格对齐，结束帧零布局跳变、零背景闪烁。
 *
 * @param options 外层节点、内层节点、目标展开态与结束回调
 * @returns 取消本次微任务与定时器的清理函数（无需动画时返回 `undefined`）
 */
export function runFlipCollapseTransition({
  gridEl,
  innerEl,
  expanded,
  wasOneFrInDom,
  fadeInner,
  onClosingCleared,
  onExpandEnd,
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
      }, MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      return (): void => {
        clearTimeout(ancestorTimer);
        gridEl.classList?.remove("flip-closing");
      };
    }
    return undefined;
  }

  const triggerEl: FlipAnimatableElement | null = findPairedTriggerElement(gridEl);
  const triggerInnerEl: FlipAnimatableElement | null = triggerEl?.firstElementChild ?? null;
  const triggerInnerStyle: FlipStyleDeclaration | undefined = triggerInnerEl?.style;

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
  const rawInterruptedH: string | undefined = innerDataset?.flipInterruptedH;
  const rawInterruptedY: string | undefined = innerDataset?.flipInterruptedY;
  if (innerDataset !== undefined) {
    delete innerDataset.flipInterruptedH;
    delete innerDataset.flipInterruptedY;
  }

  gridStyle.transition = "none";
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
  const expandedH: number = Math.max(deltaH, triggerH);
  const hasInterruptedH: boolean = rawInterruptedH !== undefined && Number.isFinite(Number(rawInterruptedH));
  const hStart: number = hasInterruptedH
    ? Math.max(collapsedH, Math.min(expandedH, Math.round(Number(rawInterruptedH))))
    : wasOneFrInDom
      ? expandedH
      : collapsedH;
  const hEnd: number = expanded ? expandedH : collapsedH;

  const slideRangePx: number = triggerH > 0 ? Math.min(deltaH, 16) : deltaH;
  const hasInterruptedY: boolean = rawInterruptedY !== undefined && Number.isFinite(Number(rawInterruptedY));
  const uStart: number = hasInterruptedY
    ? Math.round(Number(rawInterruptedY))
    : wasOneFrInDom
      ? readElementCurrentTranslateYPx(innerEl)
      : -slideRangePx;
  const uEnd: number = expanded ? 0 : -slideRangePx;
  const shouldFadeInner: boolean = fadeInner ?? (triggerH > 0 || shouldFadeInnerPanel(gridEl));

  // 1. 同步写入外层容器、配对触发器与内层面板在 t=0 帧的初始高度及偏移位置，保证首帧零跳变
  if (triggerH > 0) gridStyle.marginTop = `-${triggerH}px`;
  gridStyle.height = `${hStart}px`;
  innerStyle.transition = "none";
  innerStyle.willChange = shouldFadeInner ? "transform, opacity" : "transform";
  innerStyle.transform = formatTranslate3dY(uStart);
  if (shouldFadeInner) {
    const spanH: number = Math.max(1, expandedH - collapsedH);
    const startOpacity: number =
      deltaH > 0
        ? Math.max(0, Math.min(1, Math.round(((hStart - collapsedH) / spanH) * 100) / 100))
        : expanded
          ? 0
          : 1;
    innerStyle.opacity = String(startOpacity);
  }
  innerStyle.pointerEvents = expanded ? "" : "none";
  if (innerDataset !== undefined) innerDataset.flipInFlight = "1";

  const triggerSlidePx: number = Math.min(triggerH, 10);
  if (triggerH > 0 && triggerInnerStyle !== undefined) {
    triggerInnerStyle.transition = "none";
    triggerInnerStyle.willChange = "transform, opacity";
    triggerInnerStyle.transform = formatTranslate3dY(expanded ? 0 : -triggerSlidePx);
    triggerInnerStyle.opacity = expanded ? "1" : "0";
  }

  const heightTransition: string =
    `height ${MINI_APP_FLIP_COLLAPSE_DURATION_MS}ms ${MINI_APP_FLIP_COLLAPSE_EASING}`;
  const transformTransition: string =
    `transform ${MINI_APP_FLIP_COLLAPSE_DURATION_MS}ms ${MINI_APP_FLIP_COLLAPSE_EASING}`;
  const transformAndOpacityTransition: string =
    `${transformTransition}, opacity ${MINI_APP_FLIP_COLLAPSE_DURATION_MS}ms ${MINI_APP_FLIP_COLLAPSE_EASING}`;

  let cancelled: boolean = false;
  let finished: boolean = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let innerTransitionListener: ((event: FlipTransitionEndEvent) => void) | null = null;

  const clearTriggerStyles = (): void => {
    if (triggerEl !== null) {
      triggerEl.classList?.remove("flip-closing");
      if (triggerEl.dataset !== undefined) delete triggerEl.dataset.flipTriggerClosing;
    }
    if (triggerInnerStyle !== undefined) {
      triggerInnerStyle.transition = "";
      triggerInnerStyle.transform = "";
      triggerInnerStyle.willChange = "";
      triggerInnerStyle.opacity = "";
    }
  };

  const finishTransition = (): void => {
    if (finished || cancelled) return;
    finished = true;
    if (cleanupTimer !== null) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    if (innerTransitionListener !== null) {
      innerEl.removeEventListener?.("transitionend", innerTransitionListener);
      innerTransitionListener = null;
    }
    clearTriggerStyles();
    if (!expanded) {
      gridEl.classList?.remove("flip-closing");
      onClosingCleared?.();
    }
    gridStyle.transition = "";
    gridStyle.height = "";
    gridStyle.marginTop = "";
    innerStyle.transition = "";
    innerStyle.transform = "";
    innerStyle.willChange = "";
    innerStyle.opacity = "";
    innerStyle.pointerEvents = "";
    if (innerDataset !== undefined) {
      delete innerDataset.flipInFlight;
      delete innerDataset.flipInterruptedH;
      delete innerDataset.flipInterruptedY;
    }
    if (expanded && onExpandEnd !== undefined) onExpandEnd(gridEl);
  };

  // 2. 在同一绘制帧的微任务阶段统一冲刷初始样式并同步启动外层高度与内层位移过渡
  queueMicrotask((): void => {
    if (cancelled) return;
    void gridEl.offsetWidth;
    gridStyle.transition = heightTransition;
    gridStyle.height = `${hEnd}px`;
    innerStyle.transition = shouldFadeInner ? transformAndOpacityTransition : transformTransition;
    innerStyle.transform = formatTranslate3dY(uEnd);
    if (shouldFadeInner) innerStyle.opacity = expanded ? "1" : "0";
    if (triggerH > 0 && triggerInnerStyle !== undefined) {
      triggerInnerStyle.transition = transformAndOpacityTransition;
      triggerInnerStyle.transform = formatTranslate3dY(expanded ? -triggerSlidePx : 0);
      triggerInnerStyle.opacity = expanded ? "0" : "1";
    }

    const hasTransitionEndSupport: boolean =
      typeof innerEl.addEventListener === "function" && (uStart !== uEnd || hStart !== hEnd);
    if (hasTransitionEndSupport) {
      innerTransitionListener = (event: FlipTransitionEndEvent): void => {
        if (
          event.target === innerEl &&
          (event.propertyName === undefined || event.propertyName === "transform")
        ) {
          finishTransition();
        }
      };
      innerEl.addEventListener?.("transitionend", innerTransitionListener);
    }

    const fallbackDurationMs: number = hasTransitionEndSupport
      ? MINI_APP_FLIP_COLLAPSE_DURATION_MS + 34
      : MINI_APP_FLIP_COLLAPSE_DURATION_MS;
    cleanupTimer = setTimeout(finishTransition, fallbackDurationMs);
  });

  return (): void => {
    if (!finished && innerDataset !== undefined) {
      const midH: number = Math.max(0, Math.round(gridEl.getBoundingClientRect?.().height ?? 0));
      const midY: number = readElementCurrentTranslateYPx(innerEl);
      innerDataset.flipInterruptedH = String(midH);
      innerDataset.flipInterruptedY = String(midY);
    }
    cancelled = true;
    if (cleanupTimer !== null) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    if (innerTransitionListener !== null) {
      innerEl.removeEventListener?.("transitionend", innerTransitionListener);
      innerTransitionListener = null;
    }
    clearTriggerStyles();
    gridStyle.transition = "";
    gridStyle.height = "";
    gridStyle.marginTop = "";
    innerStyle.transition = "";
    innerStyle.transform = "";
    innerStyle.willChange = "";
    innerStyle.opacity = "";
    innerStyle.pointerEvents = "";
    if (innerDataset !== undefined) delete innerDataset.flipInFlight;
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
  /** 展开过渡收尾完成时的可选回调（保证在内层 `transform` 先于外层 `height` 完成并清理样式时同样可靠触发）。 */
  readonly onExpandEnd?: (gridElement: FlipAnimatableElement) => void;
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
  /** 展开过渡收尾完成时的可选回调。 */
  readonly onExpandEnd?: (gridElement: FlipAnimatableElement) => void;
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
  onExpandEnd,
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
    if (innerEl?.dataset !== undefined) {
      delete innerEl.dataset.flipInterruptedH;
      delete innerEl.dataset.flipInterruptedY;
    }
    return undefined;
  }
  if (wasExpanded === expanded) return undefined;
  if (gridEl === null || innerEl === null) {
    closingActiveRef.current = false;
    return undefined;
  }
  const wasOneFrInDom: boolean =
    wasExpanded ||
    innerEl.dataset?.flipInFlight === "1" ||
    innerEl.dataset?.flipInterruptedH !== undefined;
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
    onExpandEnd,
  });
}

/**
 * 为折叠容器组件接入浏览器绘制前外层高度与内层 GPU 滑动同步展开/收起过渡的 React Hook（SSR 环境自动降级为无副作用）。
 *
 * @param options 展开状态与可选上下文重置键
 * @returns 外层/内层节点引用与收起飞行态标志
 */
export function useFlipCollapseLayoutEffect({
  expanded,
  resetKey = null,
  fadeInner,
  gridRef: externalGridRef,
  onExpandEnd,
}: UseFlipCollapseLayoutEffectOptions): UseFlipCollapseLayoutEffectResult {
  const internalGridRef: React.RefObject<FlipAnimatableElement | null> = useRef<FlipAnimatableElement | null>(null);
  const gridRef: React.RefObject<FlipAnimatableElement | null> = externalGridRef ?? internalGridRef;
  const innerRef: React.RefObject<FlipAnimatableElement | null> = useRef<FlipAnimatableElement | null>(null);
  const prevExpandedRef: React.RefObject<boolean> = useRef<boolean>(expanded);
  const prevResetKeyRef: React.RefObject<string | null> = useRef<string | null>(resetKey);
  const closingActiveRef: React.RefObject<boolean> = useRef<boolean>(false);
  const onExpandEndRef: React.RefObject<((gridElement: FlipAnimatableElement) => void) | undefined> =
    useRef<((gridElement: FlipAnimatableElement) => void) | undefined>(onExpandEnd);
  onExpandEndRef.current = onExpandEnd;

  if (prevResetKeyRef.current !== resetKey) {
    closingActiveRef.current = false;
  } else if (prevExpandedRef.current && !expanded) {
    closingActiveRef.current = true;
  } else if (expanded) {
    closingActiveRef.current = false;
  }
  const isClosing: boolean = closingActiveRef.current && !expanded;

  const hasDomDocument: boolean = (globalThis as FlipGlobalHost).document !== undefined;
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
        onExpandEnd: (gridElement: FlipAnimatableElement): void => {
          onExpandEndRef.current?.(gridElement);
        },
      }),
    [expanded, fadeInner, gridRef, resetKey]
  );

  return { gridRef, innerRef, isClosing };
}
