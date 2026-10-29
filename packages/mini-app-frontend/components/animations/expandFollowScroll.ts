import {
  MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX,
  MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR,
  MINI_APP_EXPAND_SCROLL_COMFORT_TOP_RATIO,
  MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX,
  MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX,
} from "../../consts/miniApp";

/** 支持读取相对视口几何边界的 DOM 节点最小类型接口。 */
export interface ViewportRectElement {
  /** 读取元素相对于视口的几何边界。 */
  readonly getBoundingClientRect?: () => {
    readonly top: number;
    readonly height: number;
  };
}

/** 文档视口 `scrollBy` 平滑滚动调用的参数。 */
export interface ViewportScrollByParams {
  /** 纵向滚动增量像素。 */
  readonly top: number;
  /** 滚动行为。 */
  readonly behavior: "smooth";
}

/** 支持读取视口尺寸与触发平滑滚动的全局宿主最小类型接口。 */
interface ScrollableViewportHost {
  /** 视口可视像素高度。 */
  readonly innerHeight?: number;
  /** 按指定增量平滑滚动文档视口。 */
  readonly scrollBy?: (options: ViewportScrollByParams) => void;
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
 * 计算折叠项展开完成后视口应滚动的像素距离：
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
 * 按折叠项展开完成时的几何位置让文档视口平滑跟滚；滚动距离按 `computeExpandFollowScrollDelta` 计算，
 * 位移绝对值不超过 `MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX`、内容高度非正或宿主缺少视口接口时不滚动。
 *
 * @param geometry 标题栏与展开内容相对视口的几何位置
 */
export function scrollViewportToExpandedBody(
  geometry: Readonly<ExpandedBodyGeometry>
): void {
  const host: ScrollableViewportHost = globalThis as ScrollableViewportHost;
  const viewportHeight: number = host.innerHeight ?? 0;
  if (
    viewportHeight <= 0 ||
    geometry.bodyHeight <= 0 ||
    typeof host.scrollBy !== "function"
  ) {
    return;
  }
  const scrollDelta: number = computeExpandFollowScrollDelta(
    geometry,
    viewportHeight
  );
  if (Math.abs(scrollDelta) > MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX) {
    host.scrollBy({ top: scrollDelta, behavior: "smooth" });
  }
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
 * 将文档视口平滑滚动至图库预览容器的固定展示位置（顶部对齐 `MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX`）；
 * 位移绝对值不超过 `MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX` 或宿主缺少滚动接口时不滚动。
 *
 * @param gridElement 图库预览折叠网格容器节点
 */
export function scrollViewportToPreviewCard(
  gridElement: ViewportRectElement | null
): void {
  const host: ScrollableViewportHost = globalThis as ScrollableViewportHost;
  if (
    gridElement === null ||
    typeof gridElement.getBoundingClientRect !== "function" ||
    typeof host.scrollBy !== "function"
  ) {
    return;
  }
  const rect: { readonly top: number; readonly height: number } =
    gridElement.getBoundingClientRect();
  const scrollDelta: number = computePreviewCardScrollDelta(rect.top);
  if (Math.abs(scrollDelta) > MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX) {
    host.scrollBy({ top: scrollDelta, behavior: "smooth" });
  }
}
