import {
  MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX,
  MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR,
  MINI_APP_EXPAND_SCROLL_COMFORT_TOP_RATIO,
  MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX,
  MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX,
  MINI_APP_FLIP_COLLAPSE_DURATION_MS,
  MINI_APP_FOLLOW_SCROLL_ABORT_EVENTS,
} from "../../consts/miniApp";
import { runFrameMotion } from "./frameMotion";

/** 支持读取相对视口几何边界的 DOM 节点最小类型接口。 */
export interface ViewportRectElement {
  /** 读取元素相对于视口的几何边界。 */
  readonly getBoundingClientRect?: () => {
    readonly top: number;
    readonly height: number;
  };
}

/** 文档视口 `scrollBy` 逐帧即时滚动调用的参数。 */
export interface ViewportScrollByParams {
  /** 纵向滚动增量像素。 */
  readonly top: number;
  /** 滚动行为：样式表不设置 `scroll-behavior`，`"auto"` 即即时滚动，不叠加浏览器平滑滚动。 */
  readonly behavior: "auto";
}

/** 用户主动滚动时中止程序跟滚的监听选项。 */
interface PassiveListenerOptions {
  /** 被动监听，不阻塞原生滚动。 */
  readonly passive: true;
}

/** 文档根节点的滚动尺寸最小类型接口。 */
interface ScrollingDocumentElement {
  /** 文档内容总高度像素值。 */
  readonly scrollHeight?: number;
}

/** 支持读取视口尺寸与滚动位置、逐帧滚动与监听用户滚动输入的全局宿主最小类型接口。 */
interface ScrollableViewportHost {
  /** 视口可视像素高度。 */
  readonly innerHeight?: number;
  /** 文档视口当前纵向滚动位置。 */
  readonly scrollY?: number;
  /** 当前文档（读取文档根节点的内容总高度）。 */
  readonly document?: {
    /** 文档根节点。 */
    readonly documentElement?: ScrollingDocumentElement;
  };
  /** 按指定增量滚动文档视口。 */
  readonly scrollBy?: (options: ViewportScrollByParams) => void;
  /** 注册用户输入监听。 */
  readonly addEventListener?: (
    type: string,
    listener: () => void,
    options: PassiveListenerOptions
  ) => void;
  /** 移除用户输入监听。 */
  readonly removeEventListener?: (
    type: string,
    listener: () => void,
    options: PassiveListenerOptions
  ) => void;
}

/** 视口跟滚目标：锚点节点随动画缓动进度从 `fromTop` 移到 `toTop`（均为相对视口顶部的像素坐标）。 */
export interface ViewportAnchorScrollTarget {
  /** 跟滚锚点节点（折叠项标题栏所在容器、图库预览容器或收起中的折叠容器）。 */
  readonly anchor: ViewportRectElement;
  /** 动画起始时锚点顶部的视口纵坐标。 */
  readonly fromTop: number;
  /** 锚点顶部最终到达的视口纵坐标。 */
  readonly toTop: number;
  /** 锚点到达 `toTop` 时的缓动进度（`(0, 1]`，期间按二次缓出插值、到达时速度为零）；缺省时在整个进度内按缓动进度线性插值。 */
  readonly settleProgress?: number;
}

/** 一次进行中的锚点跟滚：由所属逐帧动画在每帧样式写入后调用 `step`，结束或取消时调用 `dispose`。 */
export interface ViewportAnchorScroll {
  /** 按当前缓动进度把视口滚到使锚点落在目标位置（读取锚点实时位置，抵消同帧其他折叠面板造成的位移）。 */
  readonly step: (easedProgress: number) => void;
  /** 停止跟滚并移除用户输入监听（幂等）。 */
  readonly dispose: () => void;
}

/** 折叠项展开完成时各部分相对视口顶部的几何位置。 */
export interface ExpandedBodyGeometry {
  /** 折叠项标题栏顶部的像素坐标。 */
  readonly blockTop: number;
  /** 展开内容顶部的像素坐标。 */
  readonly bodyTop: number;
  /** 展开内容的像素高度。 */
  readonly bodyHeight: number;
}

/**
 * 按折叠项展开完成时的几何位置计算视口应滚动的像素距离：
 * - 若标题栏顶部已被拉出视口上沿（`blockTop < 0`，如上方折叠抽屉同时收起导致当前行上移越界），返回负向滚动增量将标题栏拉回 `MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX`；
 * - 否则取「展开内容底部连同下边距进入视口所需距离」与「标题栏低于舒适阅读区时按内容高度比例上移的距离」中的较大者，并以「标题栏距视口顶部保留上边距」为上限。
 *
 * @param geometry 标题栏与展开内容相对视口的几何位置
 * @param viewportHeight 视口可视像素高度
 * @returns 纵向滚动的像素距离（正值为向下滚动，负值为向上滚动，不需要滚动时为 `0`）
 */
export function computeExpandFollowScrollDelta(
  geometry: Readonly<ExpandedBodyGeometry>,
  viewportHeight: number
): number {
  if (geometry.blockTop < 0) {
    return Math.round(geometry.blockTop - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
  }
  const maxScrollKeepHeader: number = Math.max(
    0,
    geometry.blockTop - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX
  );
  const overflowBottom: number = Math.max(
    0,
    geometry.bodyTop +
      geometry.bodyHeight +
      MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX -
      viewportHeight
  );
  const comfortTargetTop: number =
    viewportHeight * MINI_APP_EXPAND_SCROLL_COMFORT_TOP_RATIO;
  const comfortShift: number =
    geometry.blockTop > comfortTargetTop
      ? Math.min(
        geometry.bodyHeight * MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR,
        geometry.blockTop - comfortTargetTop
      )
      : 0;
  return Math.min(
    maxScrollKeepHeader,
    Math.max(overflowBottom, Math.round(comfortShift))
  );
}

/**
 * 按折叠项展开完成时的几何位置解析同帧跟滚目标：标题栏取锚点节点顶部、展开内容取折叠容器顶部与展开后高度，
 * 滚动距离按 `computeExpandFollowScrollDelta` 计算；位移绝对值不超过 `MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX`、
 * 内容高度非正或宿主缺少视口接口时返回 `null`（不跟滚）。
 *
 * @param anchor 标题栏所在的锚点节点（缺失时不跟滚）
 * @param body 折叠容器节点
 * @param bodyHeight 展开完成后的内容像素高度
 * @returns 跟滚目标或 `null`
 */
export function resolveExpandFollowScrollTarget(
  anchor: ViewportRectElement | null,
  body: ViewportRectElement,
  bodyHeight: number
): ViewportAnchorScrollTarget | null {
  const host: ScrollableViewportHost = globalThis as ScrollableViewportHost;
  const viewportHeight: number = host.innerHeight ?? 0;
  if (
    anchor === null ||
    viewportHeight <= 0 ||
    bodyHeight <= 0 ||
    typeof host.scrollBy !== "function" ||
    typeof anchor.getBoundingClientRect !== "function" ||
    typeof body.getBoundingClientRect !== "function"
  ) {
    return null;
  }
  const blockTop: number = anchor.getBoundingClientRect().top;
  const scrollDelta: number = computeExpandFollowScrollDelta(
    { blockTop, bodyTop: body.getBoundingClientRect().top, bodyHeight },
    viewportHeight
  );
  if (Math.abs(scrollDelta) <= MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX) {
    return null;
  }
  return { anchor, fromTop: blockTop, toTop: blockTop - scrollDelta };
}

/**
 * 计算图库预览容器对齐到固定视口展示位置（距视口顶部 `MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX`）所需的纵向滚动增量。
 *
 * @param previewTop 预览容器顶部当前相对视口的像素坐标
 * @returns 纵向滚动像素增量（正值为向下滚动，负值为向上滚动）
 */
export function computePreviewCardScrollDelta(previewTop: number): number {
  return Math.round(previewTop - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
}

/**
 * 解析把图库预览容器滚到固定展示位置（顶部对齐 `MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX`）的跟滚目标；
 * 位移绝对值不超过 `MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX` 或宿主缺少滚动接口时返回 `null`。
 *
 * @param gridElement 图库预览折叠网格容器节点
 * @returns 跟滚目标或 `null`
 */
export function resolvePreviewCardScrollTarget(
  gridElement: ViewportRectElement | null
): ViewportAnchorScrollTarget | null {
  const host: ScrollableViewportHost = globalThis as ScrollableViewportHost;
  if (
    gridElement === null ||
    typeof gridElement.getBoundingClientRect !== "function" ||
    typeof host.scrollBy !== "function"
  ) {
    return null;
  }
  const previewTop: number = gridElement.getBoundingClientRect().top;
  const scrollDelta: number = computePreviewCardScrollDelta(previewTop);
  if (Math.abs(scrollDelta) <= MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX) {
    return null;
  }
  return { anchor: gridElement, fromTop: previewTop, toTop: previewTop - scrollDelta };
}

/**
 * 解析折叠面板收起时的视口回落目标：当前滚动位置超过收起后的最大滚动距离时，滚动位置从收起开始按二次缓出回落，
 * 在最大滚动距离降到回落终点的那一进度（`settleProgress`）以零速度落到终点；任一帧的滚动位置都不超过当帧的最大滚动距离，
 * 浏览器不截断滚动位置，上下内容的速度全程连续。锚点为折叠容器自身，目标为其顶部下移回落量；
 * 回落量不超过 `MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX` 或宿主缺少视口接口时返回 `null`。
 *
 * @param gridElement 收起中的折叠外层容器节点
 * @param removedHeightPx 本次收起将收掉的高度
 * @returns 视口回落目标或 `null`
 */
export function resolveCollapseClampScrollTarget(
  gridElement: ViewportRectElement,
  removedHeightPx: number
): ViewportAnchorScrollTarget | null {
  const host: ScrollableViewportHost = globalThis as ScrollableViewportHost;
  const viewportHeight: number = host.innerHeight ?? 0;
  const scrollHeight: number = host.document?.documentElement?.scrollHeight ?? 0;
  if (
    viewportHeight <= 0 ||
    scrollHeight <= 0 ||
    removedHeightPx <= 0 ||
    typeof host.scrollBy !== "function" ||
    typeof gridElement.getBoundingClientRect !== "function"
  ) {
    return null;
  }
  const scrollTop: number = host.scrollY ?? 0;
  const maxScrollTop: number = scrollHeight - viewportHeight;
  const settledScrollTop: number = Math.max(0, maxScrollTop - removedHeightPx);
  const fallbackPx: number = Math.round(scrollTop - settledScrollTop);
  if (fallbackPx <= MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX) {
    return null;
  }
  const gridTop: number = gridElement.getBoundingClientRect().top;
  return {
    anchor: gridElement,
    fromTop: gridTop,
    toTop: gridTop + fallbackPx,
    settleProgress: Math.min(1, (maxScrollTop - settledScrollTop) / removedHeightPx),
  };
}

/**
 * 开始一次锚点跟滚：每次 `step` 读取锚点实时视口位置，按缓动进度把文档视口即时滚到使锚点位于
 * `fromTop → toTop` 插值处（插值方式见 `ViewportAnchorScrollTarget.settleProgress`）；期间用户触摸或滚轮输入即停止跟滚，把视口交还给用户。
 *
 * @param target 跟滚目标
 * @returns 跟滚句柄
 */
export function startViewportAnchorScroll(
  target: Readonly<ViewportAnchorScrollTarget>
): ViewportAnchorScroll {
  const host: ScrollableViewportHost = globalThis as ScrollableViewportHost;
  const listenerOptions: PassiveListenerOptions = { passive: true };
  let active: boolean = true;
  const dispose = (): void => {
    if (!active) return;
    active = false;
    for (const type of MINI_APP_FOLLOW_SCROLL_ABORT_EVENTS) {
      host.removeEventListener?.(type, dispose, listenerOptions);
    }
  };
  for (const type of MINI_APP_FOLLOW_SCROLL_ABORT_EVENTS) {
    host.addEventListener?.(type, dispose, listenerOptions);
  }
  return {
    step: (easedProgress: number): void => {
      if (!active || typeof target.anchor.getBoundingClientRect !== "function") return;
      let pathProgress: number = easedProgress;
      if (target.settleProgress !== undefined) {
        const settleRemaining: number = 1 - Math.min(1, easedProgress / target.settleProgress);
        pathProgress = 1 - settleRemaining * settleRemaining;
      }
      const desiredTop: number =
        target.fromTop + (target.toTop - target.fromTop) * pathProgress;
      const offset: number = target.anchor.getBoundingClientRect().top - desiredTop;
      if (Math.abs(offset) >= 0.5) {
        host.scrollBy?.({ top: offset, behavior: "auto" });
      }
    },
    dispose,
  };
}

/**
 * 以折叠面板统一时长 `MINI_APP_FLIP_COLLAPSE_DURATION_MS` 与同一缓动曲线独立执行一次锚点跟滚（不伴随折叠动画时使用）。
 *
 * @param target 跟滚目标
 * @returns 取消函数（停止逐帧滚动并移除用户输入监听）
 */
export function animateViewportToAnchor(
  target: Readonly<ViewportAnchorScrollTarget>
): () => void {
  const scroll: ViewportAnchorScroll = startViewportAnchorScroll(target);
  const cancelMotion: () => void = runFrameMotion({
    durationMs: MINI_APP_FLIP_COLLAPSE_DURATION_MS,
    onFrame: scroll.step,
    onFinish: scroll.dispose,
  });
  return (): void => {
    cancelMotion();
    scroll.dispose();
  };
}
