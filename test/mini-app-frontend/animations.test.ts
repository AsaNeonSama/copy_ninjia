/**
 * Mini App 前端折叠动画辅助：展开完成后的视口跟滚距离计算与滚动调用，
 * 以及 `CollapseGrid` 只在自身网格展开过渡结束时触发 `onExpandEnd`。
 */

import { describe, expect, test } from "bun:test";
import { CollapseGrid } from "../../packages/mini-app-frontend/components/animations/CollapseGrid";
import {
  computeExpandFollowScrollDelta,
  scrollViewportToExpandedBody,
} from "../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import type {
  ViewportRectElement,
  ViewportScrollByParams,
} from "../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import {
  MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX,
  MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR,
  MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX,
  MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX,
} from "../../packages/mini-app-frontend/consts/miniApp";

/** 测试直接调用的 `onTransitionEnd` 处理函数形状。 */
type TransitionEndHandler = (event: {
  readonly target: unknown;
  readonly currentTarget: unknown;
  readonly propertyName: string;
}) => void;

/** 直接调用 `CollapseGrid` 并取出外层网格的 `onTransitionEnd`。 */
function readTransitionEndHandler(
  expanded: boolean,
  onExpandEnd: ((gridElement: ViewportRectElement) => void) | undefined
): TransitionEndHandler | undefined {
  return (
    CollapseGrid({ expanded, gridClassName: "g", innerClassName: "i", onExpandEnd, children: null })
      .props as { readonly onTransitionEnd?: TransitionEndHandler }
  ).onTransitionEnd;
}

describe("折叠动画辅助", () => {
  test("展开跟滚距离：内容溢出视口底部时下滑到底边距，以标题栏保留上边距为上限，标题栏偏下时按内容比例上移", () => {
    const viewportHeight: number = 800;
    expect(
      computeExpandFollowScrollDelta({ blockTop: 100, bodyTop: 150, bodyHeight: 800 }, viewportHeight)
    ).toBe(100 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
    expect(
      computeExpandFollowScrollDelta({ blockTop: 200, bodyTop: 250, bodyHeight: 700 }, viewportHeight)
    ).toBe(250 + 700 + MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX - viewportHeight);
    expect(
      computeExpandFollowScrollDelta({ blockTop: 500, bodyTop: 550, bodyHeight: 100 }, viewportHeight)
    ).toBe(Math.round(100 * MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR));
    expect(
      computeExpandFollowScrollDelta({ blockTop: 50, bodyTop: 100, bodyHeight: 100 }, viewportHeight)
    ).toBe(0);
  });

  test("展开跟滚调用：超过最小位移才平滑滚动，内容高度非正时不滚动", () => {
    const host: { innerHeight?: number; scrollBy?: unknown } = globalThis as {
      innerHeight?: number;
      scrollBy?: unknown;
    };
    const prevInnerHeight: number | undefined = host.innerHeight;
    const prevScrollBy: unknown = host.scrollBy;
    const scrollCalls: ViewportScrollByParams[] = [];
    host.innerHeight = 800;
    host.scrollBy = (options: ViewportScrollByParams): void => {
      scrollCalls.push(options);
    };
    try {
      const expectedTop: number = Math.round(100 * MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR);
      expect(expectedTop).toBeGreaterThan(MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX);
      scrollViewportToExpandedBody({ blockTop: 500, bodyTop: 550, bodyHeight: 100 });
      scrollViewportToExpandedBody({ blockTop: 50, bodyTop: 100, bodyHeight: 100 });
      scrollViewportToExpandedBody({ blockTop: 500, bodyTop: 550, bodyHeight: 0 });
      expect(scrollCalls).toEqual([{ top: expectedTop, behavior: "smooth" }]);
    } finally {
      host.innerHeight = prevInnerHeight;
      host.scrollBy = prevScrollBy;
    }
  });

  test("CollapseGrid 只在展开态下自身 grid-template-rows 过渡结束时回调 onExpandEnd", () => {
    const gridNode: ViewportRectElement = {
      getBoundingClientRect: (): { readonly top: number; readonly height: number } => ({ top: 0, height: 0 }),
    };
    const expandEnds: ViewportRectElement[] = [];
    const onExpandEnd = (gridElement: ViewportRectElement): void => {
      expandEnds.push(gridElement);
    };
    const expandedHandler: TransitionEndHandler | undefined = readTransitionEndHandler(true, onExpandEnd);
    expandedHandler?.({ target: gridNode, currentTarget: gridNode, propertyName: "opacity" });
    expandedHandler?.({ target: {}, currentTarget: gridNode, propertyName: "grid-template-rows" });
    expandedHandler?.({ target: gridNode, currentTarget: gridNode, propertyName: "grid-template-rows" });
    expect(expandEnds).toEqual([gridNode]);
    readTransitionEndHandler(false, onExpandEnd)?.({
      target: gridNode,
      currentTarget: gridNode,
      propertyName: "grid-template-rows",
    });
    expect(expandEnds).toEqual([gridNode]);
    expect(readTransitionEndHandler(true, undefined)).toBeUndefined();
  });
});
