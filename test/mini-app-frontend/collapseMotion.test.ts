/**
 * Mini App 前端折叠与滑块动画引擎：快出急停缓动曲线与逐帧时钟（长帧截断与落后上限）、
 * 单时钟折叠过渡（物理像素对齐、面板底边 1:1 锁死、高度/位移/透明度同源）、首次展开动画、页内提示折叠与纵向 Flex 间距补偿、
 * 收起时长按高度跨度延长、半途打断续接、配对触发器交叉渐变、视口跟滚与回落、共享跟滚槽位，以及回溯滑块插值。
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CollapseGrid, InlineNoticeCollapse } from "../../packages/mini-app-frontend/components/animations/CollapseGrid";
import {
  animateViewportToAnchor, computeExpandFollowScrollDelta, computePreviewCardScrollDelta,
  resolveCollapseClampScrollTarget, resolveExpandFollowScrollTarget, resolvePreviewCardScrollTarget, startViewportAnchorScroll,
} from "../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import type {
  ViewportAnchorScroll, ViewportAnchorScrollTarget, ViewportRectElement, ViewportScrollByParams,
} from "../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import {
  computeFlipCollapseDurationMs, findPairedTriggerElement, formatFlipPx, formatTranslate3dY,
  hasCollapsedFlipGridAncestor, runFlipCollapseTransition, shouldFadeInnerPanel, snapFlipPx, syncFlipCollapseLayoutEffect,
} from "../../packages/mini-app-frontend/components/animations/flipCollapse";
import type { FlipAnimatableElement, FlipClassList } from "../../packages/mini-app-frontend/components/animations/flipCollapse";
import { evaluateCubicBezierEase, runFrameMotion } from "../../packages/mini-app-frontend/components/animations/frameMotion";
import {
  computeRangeProgressPercent, interpolateSpringRangeValue, resolveAnimatedRangeStartValue,
} from "../../packages/mini-app-frontend/components/animations/useAnimatedRangeProgress";
import { mergeRetainedClosingWhitelistItems } from "../../packages/mini-app-frontend/components/IdentityListRows";
import {
  MINI_APP_FLIP_PX_PRECISION_SCALE, MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME, MINI_APP_INLINE_NOTICE_INNER_CLASS_NAME,
} from "../../packages/mini-app-frontend/consts/animation";
import {
  MINI_APP_BATCH_KICK_MAX_HOURS, MINI_APP_BATCH_KICK_MIN_HOURS, MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX,
  MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR, MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX, MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX,
  MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS, MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS,
  MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS, MINI_APP_FLIP_COLLAPSE_DURATION_MS, MINI_APP_FLIP_COLLAPSE_EASING_POINTS,
  MINI_APP_FOLLOW_SCROLL_ABORT_EVENTS, MINI_APP_FRAME_MOTION_MAX_LAG_MS, MINI_APP_FRAME_MOTION_MAX_STEP_MS,
  MINI_APP_RANGE_ADVANCE_REMAINING_THRESHOLD, MINI_APP_RANGE_PULLBACK_MAX_SPAN, MINI_APP_RANGE_PULLBACK_MIN_SPAN,
  MINI_APP_RANGE_SPRING_AMPLITUDE_MAX, MINI_APP_RANGE_SPRING_AMPLITUDE_MIN, MINI_APP_RANGE_SPRING_AMPLITUDE_RATIO,
  MINI_APP_RANGE_SPRING_BOUNDARY_DAMPING, MINI_APP_RANGE_SPRING_SPLIT_PROGRESS,
} from "../../packages/mini-app-frontend/consts/miniApp";

/** 测试逐帧推进的帧间隔毫秒数（整数且小于逐帧时钟的单帧推进上限，时钟与经过时间一致）。 */
const TEST_FRAME_MS: number = 16;

/** 测试用手动推进的逐帧调度桩。 */
interface FakeAnimationFrames {
  /** 以给定时间戳执行当前排队的全部帧回调（回调内新排的帧留到下一次 `flush`）。 */
  readonly flush: (now: number) => void;
  /** 从上一次 `flush` 的时间戳起按 `TEST_FRAME_MS` 逐帧推进，最后一帧落在给定时间戳。 */
  readonly advanceTo: (now: number) => void;
  /** 当前排队的帧回调数。 */
  readonly pending: () => number;
  /** 还原全局帧调度接口。 */
  readonly restore: () => void;
}

/** 在 `globalThis` 上安装可手动推进的 `requestAnimationFrame` / `cancelAnimationFrame`。 */
function installFakeAnimationFrames(): FakeAnimationFrames {
  const host = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  const prevRequest: unknown = host.requestAnimationFrame;
  const prevCancel: unknown = host.cancelAnimationFrame;
  let queue: Map<number, (now: number) => void> = new Map<number, (now: number) => void>();
  let nextHandle: number = 1;
  let lastNow: number = 0;
  const flush = (now: number): void => {
    lastNow = now;
    const current: Map<number, (now: number) => void> = queue;
    queue = new Map<number, (now: number) => void>();
    for (const callback of current.values()) callback(now);
  };
  host.requestAnimationFrame = (callback: (now: number) => void): number => {
    const handle: number = nextHandle;
    nextHandle += 1;
    queue.set(handle, callback);
    return handle;
  };
  host.cancelAnimationFrame = (handle: number): void => {
    queue.delete(handle);
  };
  return {
    flush,
    advanceTo: (now: number): void => {
      for (let frameTime: number = lastNow + TEST_FRAME_MS; frameTime < now; frameTime += TEST_FRAME_MS) {
        flush(frameTime);
      }
      flush(now);
    },
    pending: (): number => queue.size,
    restore: (): void => {
      host.requestAnimationFrame = prevRequest;
      host.cancelAnimationFrame = prevCancel;
    },
  };
}

/** 测试用视口宿主桩：记录 `scrollBy` 调用与用户输入监听。 */
interface FakeViewportHost {
  /** 已记录的 `scrollBy` 调用参数。 */
  readonly scrollCalls: ViewportScrollByParams[];
  /** 当前注册的用户输入监听（按事件名）。 */
  readonly listeners: Map<string, () => void>;
  /** 还原全局视口接口。 */
  readonly restore: () => void;
}

/** 在 `globalThis` 上安装 `innerHeight`、`scrollBy` 与输入监听桩。 */
function installFakeViewport(viewportHeight: number): FakeViewportHost {
  const host = globalThis as { innerHeight?: number; scrollBy?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
  const prevInnerHeight: number | undefined = host.innerHeight;
  const prevScrollBy: unknown = host.scrollBy;
  const prevAdd: unknown = host.addEventListener;
  const prevRemove: unknown = host.removeEventListener;
  const scrollCalls: ViewportScrollByParams[] = [];
  const listeners: Map<string, () => void> = new Map<string, () => void>();
  host.innerHeight = viewportHeight;
  host.scrollBy = (options: ViewportScrollByParams): void => { scrollCalls.push(options); };
  host.addEventListener = (type: string, listener: () => void): void => { listeners.set(type, listener); };
  host.removeEventListener = (type: string, listener: () => void): void => {
    if (listeners.get(type) === listener) listeners.delete(type);
  };
  return {
    scrollCalls,
    listeners,
    restore: (): void => {
      host.innerHeight = prevInnerHeight;
      host.scrollBy = prevScrollBy;
      host.addEventListener = prevAdd;
      host.removeEventListener = prevRemove;
    },
  };
}

/** 在 `globalThis` 上安装文档滚动位置与文档内容总高度桩，返回还原函数。 */
function installFakeScrollState(state: { scrollY: number; scrollHeight: number }): () => void {
  const host = globalThis as { scrollY?: number; document?: unknown };
  const prevScrollY: number | undefined = host.scrollY;
  const prevDocument: unknown = host.document;
  host.scrollY = state.scrollY;
  host.document = { documentElement: { scrollHeight: state.scrollHeight } };
  return (): void => {
    host.scrollY = prevScrollY;
    host.document = prevDocument;
  };
}

/** 构造顶部坐标可变的视口几何节点桩。 */
function createRectNode(geometry: { top: number; height: number }): ViewportRectElement {
  return { getBoundingClientRect: (): { readonly top: number; readonly height: number } => ({ top: geometry.top, height: geometry.height }) };
}

/** 构造模拟的 `FlipClassList`。 */
function createMockClassList(initial: readonly string[] = []): FlipClassList & { readonly tokens: Set<string> } {
  const tokens: Set<string> = new Set<string>(initial);
  return {
    tokens,
    add: (...items: string[]): void => { for (const item of items) tokens.add(item); },
    remove: (...items: string[]): void => { for (const item of items) tokens.delete(item); },
    contains: (token: string): boolean => tokens.has(token),
  };
}

/** 从 `height`、`margin` 或 `translate3d` 行内样式里取出像素数值（支持高 DPR 子像素小数）。 */
function readPx(text: string | undefined): number {
  const match: RegExpExecArray | null = /(-?\d+(?:\.\d+)?)px/u.exec(text ?? "");
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/** 按折叠引擎同一曲线换算线性进度。 */
function ease(linear: number): number {
  return evaluateCubicBezierEase(MINI_APP_FLIP_COLLAPSE_EASING_POINTS, linear);
}

describe("折叠动画引擎与同帧跟滚", () => {
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
    expect(
      computeExpandFollowScrollDelta({ blockTop: -40, bodyTop: 10, bodyHeight: 200 }, viewportHeight)
    ).toBe(-40 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
    expect(computePreviewCardScrollDelta(-120)).toBe(-120 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
    expect(computePreviewCardScrollDelta(20)).toBe(20 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
    expect(computePreviewCardScrollDelta(178)).toBe(178 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
  });

  test("缓动曲线与逐帧时钟：端点精确、单调不越界，首帧为起点、到时长落终点，取消后不再回调", () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(2)).toBe(1);
    expect(evaluateCubicBezierEase([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 5);
    expect(evaluateCubicBezierEase([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 5);
    // 起点斜率过小时退回二分法：x(t) = t³，y(t) = 3t² − 2t³。
    const flatStartT: number = Math.cbrt(1e-4);
    expect(evaluateCubicBezierEase([0, 0, 0, 1], 1e-4)).toBeCloseTo(
      3 * flatStartT * flatStartT - 2 * flatStartT * flatStartT * flatStartT,
      5
    );
    let previous: number = 0;
    for (let step: number = 1; step <= 20; step += 1) {
      const value: number = ease(step / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }

    // 宿主缺少帧调度接口时同步落到终点。
    const syncFrames: number[] = [];
    let syncFinished: number = 0;
    runFrameMotion({
      durationMs: MINI_APP_FLIP_COLLAPSE_DURATION_MS,
      onFrame: (progress: number): void => {
        syncFrames.push(progress);
      },
      onFinish: (): void => {
        syncFinished += 1;
      },
    })();
    expect(syncFrames).toEqual([1]);
    expect(syncFinished).toBe(1);

    const frames: FakeAnimationFrames = installFakeAnimationFrames();
    try {
      const progressLog: number[] = [];
      let finished: number = 0;
      const cancel: () => void = runFrameMotion({
        durationMs: MINI_APP_FLIP_COLLAPSE_DURATION_MS,
        onFrame: (progress: number): void => {
          progressLog.push(progress);
        },
        onFinish: (): void => {
          finished += 1;
        },
      });
      frames.flush(1_000);
      expect(progressLog).toEqual([0]);
      frames.advanceTo(1_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS / 2);
      expect(progressLog.at(-1)).toBe(ease(0.5));
      frames.advanceTo(1_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS + 5);
      expect(progressLog.at(-1)).toBe(1);
      expect(finished).toBe(1);
      expect(frames.pending()).toBe(0);
      cancel();

      const cancelledLog: number[] = [];
      const cancelMidway: () => void = runFrameMotion({
        durationMs: MINI_APP_FLIP_COLLAPSE_DURATION_MS,
        onFrame: (progress: number): void => {
          cancelledLog.push(progress);
        },
        onFinish: (): void => {
          finished += 1;
        },
      });
      frames.flush(2_000);
      cancelMidway();
      expect(frames.pending()).toBe(0);
      frames.flush(2_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(cancelledLog).toEqual([0]);
      expect(finished).toBe(1);

      let cancelInsideFrame: () => void = (): void => undefined;
      cancelInsideFrame = runFrameMotion({
        durationMs: MINI_APP_FLIP_COLLAPSE_DURATION_MS,
        onFrame: (): void => { cancelInsideFrame(); },
        onFinish: (): void => { finished += 1; },
      });
      frames.flush(3_000);
      expect(frames.pending()).toBe(0);
      expect(finished).toBe(1);
    } finally {
      frames.restore();
    }
  });

  test("逐帧时钟：长帧只推进单帧上限，上限随已观测最短帧间隔放宽（首个间隔不计），落后超过上限时追平", () => {
    const frames: FakeAnimationFrames = installFakeAnimationFrames();
    const durationMs: number = 1_000;
    try {
      const elapsedLog: number[] = [];
      let finished: number = 0;
      runFrameMotion({
        durationMs,
        onFrame: (progress: number): void => {
          elapsedLog.push(progress);
        },
        onFinish: (): void => {
          finished += 1;
        },
      });
      const expectElapsed = (elapsedMs: number): void => {
        expect(elapsedLog.at(-1)).toBe(ease(elapsedMs / durationMs));
      };
      // 起始帧之后的长帧（新内容首次绘制）只推进单帧上限。
      frames.flush(0);
      frames.flush(MINI_APP_FRAME_MOTION_MAX_STEP_MS + 30);
      let elapsedMs: number = MINI_APP_FRAME_MOTION_MAX_STEP_MS;
      expectElapsed(elapsedMs);
      // 第二个间隔仍未观测到正常帧间隔：同样截断。
      let now: number = MINI_APP_FRAME_MOTION_MAX_STEP_MS + 30 + MINI_APP_FRAME_MOTION_MAX_STEP_MS * 2;
      frames.flush(now);
      elapsedMs += MINI_APP_FRAME_MOTION_MAX_STEP_MS;
      expectElapsed(elapsedMs);
      // 已观测最短帧间隔（上一帧的两倍单帧上限）放宽上限：与之相等的帧间隔完整推进。
      now += MINI_APP_FRAME_MOTION_MAX_STEP_MS * 2;
      frames.flush(now);
      elapsedMs += MINI_APP_FRAME_MOTION_MAX_STEP_MS * 2;
      expectElapsed(elapsedMs);
      // 正常短帧完整推进，并把上限收回单帧上限。
      now += TEST_FRAME_MS;
      frames.flush(now);
      elapsedMs += TEST_FRAME_MS;
      expectElapsed(elapsedMs);
      now += MINI_APP_FRAME_MOTION_MAX_STEP_MS * 2;
      frames.flush(now);
      elapsedMs += MINI_APP_FRAME_MOTION_MAX_STEP_MS;
      expectElapsed(elapsedMs);
      // 长时间卡顿：时钟追平到「经过时间 − 落后上限」。
      now += durationMs / 2;
      frames.flush(now);
      expectElapsed(now - MINI_APP_FRAME_MOTION_MAX_LAG_MS);
      expect(finished).toBe(0);
      frames.flush(durationMs + MINI_APP_FRAME_MOTION_MAX_LAG_MS);
      expect(elapsedLog.at(-1)).toBe(1);
      expect(finished).toBe(1);
    } finally {
      frames.restore();
    }
  });

  test("收起时长按高度跨度延长并封顶，保留期覆盖最长收起、时钟落后上限与两帧余量", () => {
    expect(MINI_APP_FRAME_MOTION_MAX_STEP_MS).toBeGreaterThan(1_000 / 60);
    expect(MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS).toBeGreaterThanOrEqual(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
    expect(MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS).toBeGreaterThanOrEqual(
      MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS + MINI_APP_FRAME_MOTION_MAX_LAG_MS + (2 * 1_000) / 60
    );
    const baseSpanPx: number = MINI_APP_FLIP_COLLAPSE_DURATION_MS * MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS;
    expect(computeFlipCollapseDurationMs(baseSpanPx * 3, true)).toBe(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
    expect(computeFlipCollapseDurationMs(baseSpanPx / 2, false)).toBe(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
    expect(computeFlipCollapseDurationMs(baseSpanPx, false)).toBe(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
    expect(computeFlipCollapseDurationMs(baseSpanPx + 40, false)).toBe(
      Math.round((baseSpanPx + 40) / MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS)
    );
    expect(computeFlipCollapseDurationMs(baseSpanPx * 10, false)).toBe(MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS);
  });

  test("同帧跟滚：解析展开与图库预览目标，逐帧按锚点实时位置补偿滚动，用户触摸即停止", () => {
    const viewport: FakeViewportHost = installFakeViewport(800);
    const frames: FakeAnimationFrames = installFakeAnimationFrames();
    try {
      const anchorGeometry: { top: number; height: number } = { top: 500, height: 40 };
      const anchor: ViewportRectElement = createRectNode(anchorGeometry);
      const body: ViewportRectElement = createRectNode({ top: 550, height: 0 });
      const expectedDelta: number = Math.round(100 * MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR);
      expect(resolveExpandFollowScrollTarget(null, body, 100)).toBeNull();
      expect(resolveExpandFollowScrollTarget(anchor, body, 0)).toBeNull();
      expect(resolveExpandFollowScrollTarget(anchor, {}, 100)).toBeNull();
      expect(
        resolveExpandFollowScrollTarget(createRectNode({ top: 50, height: 40 }), createRectNode({ top: 100, height: 0 }), 100)
      ).toBeNull();
      const target: ViewportAnchorScrollTarget | null = resolveExpandFollowScrollTarget(anchor, body, 100);
      expect(target).toEqual({ anchor, fromTop: 500, toTop: 500 - expectedDelta });

      expect(resolvePreviewCardScrollTarget(null)).toBeNull();
      expect(resolvePreviewCardScrollTarget({})).toBeNull();
      expect(
        resolvePreviewCardScrollTarget(createRectNode({ top: MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX + 2, height: 450 }))
      ).toBeNull();
      const previewNode: ViewportRectElement = createRectNode({ top: -80, height: 450 });
      expect(resolvePreviewCardScrollTarget(previewNode)).toEqual({
        anchor: previewNode,
        fromTop: -80,
        toTop: MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX,
      });

      if (target === null) throw new Error("follow-scroll target missing");
      const scroll: ViewportAnchorScroll = startViewportAnchorScroll(target);
      expect([...viewport.listeners.keys()].sort()).toEqual([...MINI_APP_FOLLOW_SCROLL_ABORT_EVENTS].sort());
      scroll.step(0);
      expect(viewport.scrollCalls).toEqual([]);
      // 同帧上方面板收起后锚点上移 30px：滚动反向补偿，锚点保持在插值位置。
      anchorGeometry.top = 470;
      scroll.step(0);
      expect(viewport.scrollCalls).toEqual([{ top: -30, behavior: "auto" }]);
      anchorGeometry.top = 500;
      scroll.step(0.5);
      expect(viewport.scrollCalls.at(-1)).toEqual({ top: expectedDelta / 2, behavior: "auto" });
      viewport.listeners.get("touchstart")?.();
      expect(viewport.listeners.size).toBe(0);
      scroll.step(1);
      expect(viewport.scrollCalls).toHaveLength(2);
      scroll.dispose();

      viewport.scrollCalls.length = 0;
      const previewScrollTarget: ViewportAnchorScrollTarget = {
        anchor: previewNode, fromTop: -80, toTop: MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX,
      };
      const cancelScroll: () => void = animateViewportToAnchor(previewScrollTarget);
      frames.flush(0);
      frames.advanceTo(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(viewport.scrollCalls.at(-1)).toEqual({ top: -(80 + MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX), behavior: "auto" });
      expect(viewport.listeners.size).toBe(0);
      cancelScroll();

      const cancelEarly: () => void = animateViewportToAnchor(previewScrollTarget);
      expect(viewport.listeners.size).toBe(MINI_APP_FOLLOW_SCROLL_ABORT_EVENTS.length);
      cancelEarly();
      expect(viewport.listeners.size).toBe(0);
      expect(frames.pending()).toBe(0);
    } finally {
      frames.restore();
      viewport.restore();
    }
  });

  test("CollapseGrid 渲染展开态类名", () => {
    expect(
      renderToStaticMarkup(createElement(CollapseGrid, { expanded: true, gridClassName: "g", innerClassName: "i", children: null }))
    ).toContain('class="g expanded"');
  });

  test("单时钟折叠引擎：高度、位移、透明度与跟滚同帧派生，面板下沿贴住裁剪框，半途打断按进度续接", () => {
    expect(formatTranslate3dY(0)).toBe("translate3d(0, 0, 0)");
    expect(formatTranslate3dY(-180)).toBe("translate3d(0, -180px, 0)");
    const frames: FakeAnimationFrames = installFakeAnimationFrames();
    const viewport: FakeViewportHost = installFakeViewport(800);
    try {
      const sectionEl: FlipAnimatableElement = { tagName: "SECTION" };
      const cardEl: FlipAnimatableElement = { parentElement: sectionEl, classList: createMockClassList(["card"]) };
      const innerEl: FlipAnimatableElement = {
        style: { transform: "", willChange: "", opacity: "", pointerEvents: "" },
        dataset: {},
        getBoundingClientRect: () => ({ top: 100, height: 180 }),
      };
      let gridHeightPx: number = 180;
      const gridClassList = createMockClassList(["chat-targets-qa-collapse-grid"]);
      const gridEl: FlipAnimatableElement = {
        parentElement: cardEl, classList: gridClassList, dataset: {},
        style: { height: "", marginTop: "", transform: "", willChange: "" },
        getBoundingClientRect: () => ({ top: 100, height: gridHeightPx }),
      };
      expect(hasCollapsedFlipGridAncestor(gridEl)).toBeFalse();

      // 1. 展开：起始帧同步写入 0px / -180px / 透明，逐帧高度与位移同源，面板下沿贴住裁剪框下沿；同帧跟滚。
      const anchorGeometry: { top: number; height: number } = { top: 60, height: 40 };
      const anchor: ViewportRectElement = createRectNode(anchorGeometry);
      const resolvedHeights: number[] = [];
      const cleanupExpand = runFlipCollapseTransition({
        gridEl, innerEl, expanded: true, wasOneFrInDom: false,
        resolveFollowScroll: (el: FlipAnimatableElement, expandedHeightPx: number): ViewportAnchorScrollTarget => {
          expect(el).toBe(gridEl);
          resolvedHeights.push(expandedHeightPx);
          return { anchor, fromTop: 60, toTop: 20 };
        },
      });
      expect(resolvedHeights).toEqual([180]);
      expect(gridEl.style?.height).toBe("0px");
      expect(innerEl.style?.transform).toBe("translate3d(0, -180px, 0)");
      expect(innerEl.style?.opacity).toBe("0");
      expect(innerEl.style?.willChange).toBe("transform, opacity");
      expect(innerEl.dataset?.flipInFlight).toBe("1");
      frames.flush(0);
      expect(gridEl.style?.height).toBe("0px");
      frames.advanceTo(MINI_APP_FLIP_COLLAPSE_DURATION_MS / 2);
      const midHeight: number = readPx(gridEl.style?.height);
      expect(midHeight).toBe(Math.round(180 * ease(0.5)));
      expect(readPx(innerEl.style?.transform)).toBe(midHeight - 180);
      expect(Number(innerEl.style?.opacity)).toBeCloseTo(ease(0.5), 2);
      expect(viewport.scrollCalls.at(-1)?.top).toBeCloseTo(40 * ease(0.5), 5);
      frames.advanceTo(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(viewport.scrollCalls.at(-1)?.top).toBe(40);
      expect(gridEl.style?.height).toBe("");
      expect(innerEl.style?.transform).toBe("");
      expect(innerEl.style?.willChange).toBe("");
      expect(innerEl.dataset?.flipInFlight).toBeUndefined();
      expect(viewport.listeners.size).toBe(0);
      expect(frames.pending()).toBe(0);
      cleanupExpand?.();

      // 2. 收起：从完全展开起步，逐帧缩到 0px，结束时移除 `.flip-closing` 并通知；收起不调用展开跟滚解析。
      let closingClearedCount: number = 0;
      viewport.scrollCalls.length = 0;
      const cleanupCollapse = runFlipCollapseTransition({
        gridEl, innerEl, expanded: false, wasOneFrInDom: true,
        onClosingCleared: (): void => { closingClearedCount += 1; },
        resolveFollowScroll: (): ViewportAnchorScrollTarget => { throw new Error("collapse must not follow-scroll"); },
      });
      expect(gridClassList.contains("flip-closing")).toBeTrue();
      expect(gridEl.style?.height).toBe("180px");
      expect(innerEl.style?.transform).toBe("translate3d(0, 0, 0)");
      expect(innerEl.style?.pointerEvents).toBe("none");
      frames.flush(10);
      frames.advanceTo(10 + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(closingClearedCount).toBe(1);
      expect(gridClassList.contains("flip-closing")).toBeFalse();
      expect(gridEl.style?.height).toBe("");
      expect(innerEl.style?.opacity).toBe("");
      expect(viewport.scrollCalls).toEqual([]);
      cleanupCollapse?.();

      // 3. 半途打断：收起到一半时取消并记录进度，重新展开从该进度续接，时长按剩余进度折算。
      const cleanupMidFlight = runFlipCollapseTransition({ gridEl, innerEl, expanded: false, wasOneFrInDom: true });
      frames.flush(100);
      frames.advanceTo(100 + MINI_APP_FLIP_COLLAPSE_DURATION_MS / 2);
      const interruptedProgress: number = 1 - ease(0.5);
      cleanupMidFlight?.();
      expect(Number(innerEl.dataset?.flipInterruptedProgress)).toBeCloseTo(interruptedProgress, 10);
      expect(gridEl.style?.height).toBe("");
      expect(frames.pending()).toBe(0);

      const cleanupReExpand = runFlipCollapseTransition({ gridEl, innerEl, expanded: true, wasOneFrInDom: true });
      expect(innerEl.dataset?.flipInterruptedProgress).toBeUndefined();
      const resumedHeight: number = readPx(gridEl.style?.height);
      expect(resumedHeight).toBe(Math.round(180 * interruptedProgress));
      expect(readPx(innerEl.style?.transform)).toBe(resumedHeight - 180);
      const remainingMs: number = Math.round(MINI_APP_FLIP_COLLAPSE_DURATION_MS * (1 - interruptedProgress));
      frames.flush(500);
      frames.advanceTo(500 + remainingMs - 1);
      expect(gridEl.style?.height).not.toBe("");
      frames.flush(500 + remainingMs);
      expect(gridEl.style?.height).toBe("");
      cleanupReExpand?.();

      // 4. 内容高度为 0：不播放动画，收起时直接清理。
      gridHeightPx = 0;
      let emptyClearedCount: number = 0;
      const emptyInnerEl: FlipAnimatableElement = {
        style: { transform: "", willChange: "" }, dataset: {}, getBoundingClientRect: () => ({ top: 100, height: 0 }),
      };
      expect(
        runFlipCollapseTransition({
          gridEl, innerEl: emptyInnerEl, expanded: false, wasOneFrInDom: true,
          onClosingCleared: (): void => { emptyClearedCount += 1; },
        })
      ).toBeUndefined();
      expect(emptyClearedCount).toBe(1);
      expect(gridClassList.contains("flip-closing")).toBeFalse();
      gridHeightPx = 180;

      // 5. 外层折叠网格同批收起：内层维持布局，保留期结束后才移除 `.flip-closing`。
      const nestedGridClassList = createMockClassList(["id-add-collapse-grid"]);
      const nestedGridEl: FlipAnimatableElement = {
        parentElement: {
          parentElement: cardEl,
          getAttribute: (name: string): string | null => (name === "aria-hidden" ? "true" : null),
        },
        classList: nestedGridClassList,
        style: { height: "", transform: "", willChange: "" },
        getBoundingClientRect: () => ({ top: 100, height: 60 }),
      };
      expect(hasCollapsedFlipGridAncestor(nestedGridEl)).toBeTrue();
      const cleanupNested = runFlipCollapseTransition({ gridEl: nestedGridEl, innerEl, expanded: false, wasOneFrInDom: true });
      expect(nestedGridClassList.contains("flip-closing")).toBeTrue();
      cleanupNested?.();
      expect(nestedGridClassList.contains("flip-closing")).toBeFalse();
      expect(
        runFlipCollapseTransition({ gridEl: nestedGridEl, innerEl, expanded: true, wasOneFrInDom: false })
      ).toBeUndefined();

      // 6. 配对 TriggerCollapseGrid + CollapseGrid：marginTop 重叠、46px ↔ 180px，按钮与表单同进度交叉渐变。
      const triggerInnerEl: FlipAnimatableElement = {
        style: { transform: "", willChange: "", opacity: "" }, getBoundingClientRect: () => ({ top: 100, height: 46 }),
      };
      const triggerClassList = createMockClassList(["totp-trigger-collapse-grid"]);
      const triggerEl: FlipAnimatableElement = {
        classList: triggerClassList, dataset: { flipTrigger: "1" }, firstElementChild: triggerInnerEl,
        getBoundingClientRect: () => ({ top: 100, height: 46 }),
      };
      const pairedGridEl: FlipAnimatableElement = {
        parentElement: cardEl, previousElementSibling: triggerEl,
        classList: createMockClassList(["totp-setup-collapse-grid"]), dataset: {},
        style: { height: "", marginTop: "", transform: "", willChange: "" },
        getBoundingClientRect: () => ({ top: 100, height: 180 }),
      };
      expect(findPairedTriggerElement(pairedGridEl)).toBe(triggerEl);

      const cleanupPairedExpand = runFlipCollapseTransition({
        gridEl: pairedGridEl, innerEl, expanded: true, wasOneFrInDom: false,
      });
      expect(triggerClassList.contains("flip-closing")).toBeTrue();
      expect(triggerEl.dataset?.flipTriggerClosing).toBe("1");
      expect(pairedGridEl.style?.marginTop).toBe("-46px");
      expect(pairedGridEl.style?.height).toBe("46px");
      expect(triggerInnerEl.style?.opacity).toBe("1");
      expect(innerEl.style?.opacity).toBe("0");
      expect(innerEl.style?.transform).toBe("translate3d(0, -16px, 0)");
      frames.flush(1_000);
      frames.advanceTo(1_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS / 2);
      const pairedMid: number = ease(0.5);
      expect(readPx(pairedGridEl.style?.height)).toBe(Math.round(46 + 134 * pairedMid));
      expect(Number(triggerInnerEl.style?.opacity)).toBeCloseTo(1 - pairedMid, 2);
      expect(Number(innerEl.style?.opacity)).toBeCloseTo(pairedMid, 2);
      frames.advanceTo(1_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(triggerClassList.contains("flip-closing")).toBeFalse();
      expect(triggerEl.dataset?.flipTriggerClosing).toBeUndefined();
      expect(pairedGridEl.style?.marginTop).toBe("");
      expect(pairedGridEl.style?.height).toBe("");
      expect(triggerInnerEl.style?.opacity).toBe("");
      cleanupPairedExpand?.();

      // 7. 布局副作用：收起维护 closingActiveRef，展开调用跟滚解析，重置键变化不播放动画并清除打断进度。
      const prevExpandedRef = { current: true };
      const prevResetKeyRef = { current: "qa" as string | null };
      const closingActiveRef = { current: true };
      const syncRefs = { gridRef: { current: pairedGridEl }, innerRef: { current: innerEl }, prevExpandedRef, prevResetKeyRef, closingActiveRef };
      const syncCleanup = syncFlipCollapseLayoutEffect({ expanded: false, resetKey: "qa", ...syncRefs });
      expect(closingActiveRef.current).toBeTrue();
      expect(pairedGridEl.style?.height).toBe("180px");
      frames.flush(2_000);
      frames.advanceTo(2_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(pairedGridEl.style?.height).toBe("");
      expect(closingActiveRef.current).toBeFalse();
      syncCleanup?.();

      const syncResolved: FlipAnimatableElement[] = [];
      const syncExpandCleanup = syncFlipCollapseLayoutEffect({
        expanded: true,
        resetKey: "qa",
        ...syncRefs,
        resolveFollowScroll: (el: FlipAnimatableElement): ViewportAnchorScrollTarget | null => {
          syncResolved.push(el);
          return null;
        },
      });
      expect(syncResolved).toEqual([pairedGridEl]);
      frames.flush(3_000);
      syncExpandCleanup?.();
      expect(innerEl.dataset?.flipInterruptedProgress).toBe("0");

      expect(syncFlipCollapseLayoutEffect({ expanded: false, resetKey: "deleteMessage", ...syncRefs })).toBeUndefined();
      expect(innerEl.dataset?.flipInterruptedProgress).toBeUndefined();
      expect(syncFlipCollapseLayoutEffect({ expanded: false, resetKey: "deleteMessage", ...syncRefs })).toBeUndefined();
      expect(
        syncFlipCollapseLayoutEffect({ expanded: true, resetKey: "deleteMessage", ...syncRefs, gridRef: { current: null } })
      ).toBeUndefined();
      expect(closingActiveRef.current).toBeFalse();
    } finally {
      viewport.restore();
      frames.restore();
    }
  });

  test("共享跟滚槽位：后一次展开接管视口，先前展开的跟滚停止，结束后槽位清空", () => {
    const frames: FakeAnimationFrames = installFakeAnimationFrames();
    const viewport: FakeViewportHost = installFakeViewport(800);
    try {
      const slotRef: { current: ViewportAnchorScroll | null } = { current: null };
      const createPanel = (): { gridEl: FlipAnimatableElement; innerEl: FlipAnimatableElement } => ({
        gridEl: {
          classList: createMockClassList(["cap-collapse-wrap"]),
          style: { height: "", marginTop: "", transform: "", willChange: "" },
          getBoundingClientRect: () => ({ top: 300, height: 120 }),
        },
        innerEl: {
          style: { transform: "", willChange: "", pointerEvents: "" }, dataset: {},
          getBoundingClientRect: () => ({ top: 300, height: 120 }),
        },
      });
      const first = createPanel();
      const second = createPanel();
      const firstAnchor: ViewportRectElement = createRectNode({ top: 260, height: 40 });
      const secondAnchor: ViewportRectElement = createRectNode({ top: 500, height: 40 });
      runFlipCollapseTransition({
        ...first, expanded: true, wasOneFrInDom: false, followScrollSlotRef: slotRef,
        resolveFollowScroll: (): ViewportAnchorScrollTarget => ({ anchor: firstAnchor, fromTop: 260, toTop: 200 }),
      });
      const firstScroll: ViewportAnchorScroll | null = slotRef.current;
      expect(firstScroll).not.toBeNull();
      frames.flush(0);
      runFlipCollapseTransition({
        ...second, expanded: true, wasOneFrInDom: false, followScrollSlotRef: slotRef,
        resolveFollowScroll: (): ViewportAnchorScrollTarget => ({ anchor: secondAnchor, fromTop: 500, toTop: 300 }),
      });
      expect(slotRef.current).not.toBe(firstScroll);
      // 第一项继续展开但其跟滚已停止；第二项以本帧为起始帧。
      frames.flush(TEST_FRAME_MS);
      expect(viewport.scrollCalls).toEqual([]);
      frames.advanceTo(TEST_FRAME_MS + MINI_APP_FLIP_COLLAPSE_DURATION_MS / 2);
      expect(viewport.scrollCalls.at(-1)?.top).toBeCloseTo(200 * ease(0.5), 5);
      frames.advanceTo(TEST_FRAME_MS + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(viewport.scrollCalls.at(-1)?.top).toBe(200);
      expect(slotRef.current).toBeNull();
      expect(frames.pending()).toBe(0);
    } finally {
      viewport.restore();
      frames.restore();
    }
  });

  test("收起视口回落：仅在滚动位置会被截断时解析目标，按二次缓出在截断线到达终点的进度落地；引擎收起按跨度延长并传入收掉的高度", () => {
    const viewport: FakeViewportHost = installFakeViewport(700);
    const frames: FakeAnimationFrames = installFakeAnimationFrames();
    const resolveWith = (
      state: { scrollY: number; scrollHeight: number },
      gridElement: ViewportRectElement,
      removedHeightPx: number
    ): ViewportAnchorScrollTarget | null => {
      const restoreScroll: () => void = installFakeScrollState(state);
      try {
        return resolveCollapseClampScrollTarget(gridElement, removedHeightPx);
      } finally {
        restoreScroll();
      }
    };
    try {
      const gridNode: ViewportRectElement = createRectNode({ top: 72, height: 520 });
      // 收起后仍可滚到当前位置：不回落。
      expect(resolveWith({ scrollY: 88, scrollHeight: 2_000 }, gridNode, 520)).toBeNull();
      // 回落量不超过最小位移、收掉高度非正、节点缺少几何接口：不回落。
      expect(
        resolveWith({ scrollY: 2 + MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX, scrollHeight: 700 + 520 + 2 }, gridNode, 520)
      ).toBeNull();
      expect(resolveWith({ scrollY: 88, scrollHeight: 1_024 }, gridNode, 0)).toBeNull();
      expect(resolveWith({ scrollY: 88, scrollHeight: 1_024 }, {}, 520)).toBeNull();
      // 收起后文档短于视口：回落到 0，在最大滚动距离降到 0 的进度落地。
      expect(resolveWith({ scrollY: 88, scrollHeight: 1_024 }, gridNode, 520)).toEqual({
        anchor: gridNode, fromTop: 72, toTop: 72 + 88, settleProgress: (1_024 - 700) / 520,
      });
      // 位于底部：回落量等于收掉的高度，到收起结束才落地。
      expect(resolveWith({ scrollY: 600, scrollHeight: 1_300 }, gridNode, 520)).toEqual({
        anchor: gridNode, fromTop: 72, toTop: 72 + 520, settleProgress: 1,
      });

      const fixedAnchor: ViewportRectElement = createRectNode({ top: 0, height: 0 });
      const settleScroll: ViewportAnchorScroll = startViewportAnchorScroll({
        anchor: fixedAnchor, fromTop: 0, toTop: 100, settleProgress: 0.5,
      });
      settleScroll.step(0.25);
      expect(viewport.scrollCalls.at(-1)?.top).toBe(-75);
      settleScroll.step(0.5);
      expect(viewport.scrollCalls.at(-1)?.top).toBe(-100);
      settleScroll.step(0.9);
      expect(viewport.scrollCalls.at(-1)?.top).toBe(-100);
      settleScroll.dispose();
      viewport.scrollCalls.length = 0;

      const tallSpanPx: number = 520;
      const tallDurationMs: number = computeFlipCollapseDurationMs(tallSpanPx, false);
      expect(tallDurationMs).toBeGreaterThan(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      const innerEl: FlipAnimatableElement = {
        style: { transform: "", willChange: "", opacity: "", pointerEvents: "" }, dataset: {},
        getBoundingClientRect: () => ({ top: 72, height: tallSpanPx }),
      };
      const gridEl: FlipAnimatableElement = {
        classList: createMockClassList(["gallery-preview-collapse-grid"]),
        style: { height: "", marginTop: "", transform: "", willChange: "" },
        getBoundingClientRect: () => ({ top: 72, height: tallSpanPx }),
      };
      const removedLog: number[] = [];
      const cleanup = runFlipCollapseTransition({
        gridEl, innerEl, expanded: false, wasOneFrInDom: true,
        resolveFollowScroll: (): ViewportAnchorScrollTarget => { throw new Error("collapse must not follow-scroll"); },
        resolveCollapseScroll: (el: FlipAnimatableElement, removedHeightPx: number): ViewportAnchorScrollTarget => {
          expect(el).toBe(gridEl);
          removedLog.push(removedHeightPx);
          return { anchor: fixedAnchor, fromTop: 0, toTop: 88, settleProgress: 0.5 };
        },
      });
      expect(removedLog).toEqual([tallSpanPx]);
      expect(viewport.listeners.size).toBe(MINI_APP_FOLLOW_SCROLL_ABORT_EVENTS.length);
      frames.flush(0);
      frames.advanceTo(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(gridEl.style?.height).not.toBe("");
      expect(viewport.scrollCalls.at(-1)?.top).toBe(-88);
      frames.advanceTo(tallDurationMs - 1);
      expect(gridEl.style?.height).not.toBe("");
      frames.advanceTo(tallDurationMs);
      expect(gridEl.style?.height).toBe("");
      expect(viewport.listeners.size).toBe(0);
      cleanup?.();

      // 半途打断后再收起：收掉的高度按剩余进度折算，时长按完整收起时长乘以剩余进度。
      if (innerEl.dataset !== undefined) innerEl.dataset.flipInterruptedProgress = "0.5";
      const resumedCleanup = runFlipCollapseTransition({
        gridEl, innerEl, expanded: false, wasOneFrInDom: true,
        resolveCollapseScroll: (_el: FlipAnimatableElement, removedHeightPx: number): ViewportAnchorScrollTarget | null => {
          removedLog.push(removedHeightPx);
          return null;
        },
      });
      expect(removedLog.at(-1)).toBe(tallSpanPx / 2);
      frames.flush(1_000);
      frames.advanceTo(1_000 + Math.round(tallDurationMs / 2));
      expect(gridEl.style?.height).toBe("");
      resumedCleanup?.();
      expect(frames.pending()).toBe(0);
    } finally {
      frames.restore();
      viewport.restore();
    }
  });

  test("滑块快出推进与机械卡位插值：前段按新粗野主义曲线干脆抵达定点，后段做有界阻尼卡位回弹，连续点击与快速回撤归一化起点", () => {
    expect(computeRangeProgressPercent(MINI_APP_BATCH_KICK_MIN_HOURS)).toBe("0.00%");
    expect(computeRangeProgressPercent(MINI_APP_BATCH_KICK_MAX_HOURS)).toBe("100.00%");
    const midHours: number = (MINI_APP_BATCH_KICK_MIN_HOURS + MINI_APP_BATCH_KICK_MAX_HOURS) / 2;
    expect(computeRangeProgressPercent(midHours)).toBe("50.00%");

    const fromHours: number = 2;
    const toHours: number = 12;
    expect(interpolateSpringRangeValue(fromHours, toHours, 0)).toBe(fromHours);
    expect(interpolateSpringRangeValue(fromHours, toHours, 1)).toBe(toHours);

    // 前段按 MINI_APP_FLIP_COLLAPSE_EASING_POINTS 快出急停曲线采样，在分界点精确落到目标值
    const halfApproachProgress: number = MINI_APP_RANGE_SPRING_SPLIT_PROGRESS * 0.5;
    expect(interpolateSpringRangeValue(fromHours, toHours, halfApproachProgress)).toBeCloseTo(
      fromHours + (toHours - fromHours) * ease(0.5),
      6
    );
    expect(interpolateSpringRangeValue(fromHours, toHours, MINI_APP_RANGE_SPRING_SPLIT_PROGRESS)).toBeCloseTo(toHours, 6);

    // 后段做有界阻尼微幅过冲并收敛回目标值；两端边界过冲向内侧按 MINI_APP_RANGE_SPRING_BOUNDARY_DAMPING 折返
    const tailMidProgress: number = (MINI_APP_RANGE_SPRING_SPLIT_PROGRESS + 1) / 2;
    const clampAmp = (span: number): number =>
      Math.min(MINI_APP_RANGE_SPRING_AMPLITUDE_MAX, Math.max(MINI_APP_RANGE_SPRING_AMPLITUDE_MIN, span * MINI_APP_RANGE_SPRING_AMPLITUDE_RATIO));
    expect(interpolateSpringRangeValue(fromHours, toHours, tailMidProgress)).toBeCloseTo(
      toHours + clampAmp(Math.abs(toHours - fromHours)) * 0.25,
      6
    );
    const maxEdgeValue: number = interpolateSpringRangeValue(12, MINI_APP_BATCH_KICK_MAX_HOURS, tailMidProgress);
    const maxEdgeAmp: number = clampAmp(Math.abs(MINI_APP_BATCH_KICK_MAX_HOURS - 12));
    expect(maxEdgeValue).toBeLessThan(MINI_APP_BATCH_KICK_MAX_HOURS);
    expect(maxEdgeValue).toBeCloseTo(
      MINI_APP_BATCH_KICK_MAX_HOURS - maxEdgeAmp * 0.25 * MINI_APP_RANGE_SPRING_BOUNDARY_DAMPING,
      6
    );
    expect(interpolateSpringRangeValue(6, MINI_APP_BATCH_KICK_MIN_HOURS, tailMidProgress)).toBeGreaterThan(
      MINI_APP_BATCH_KICK_MIN_HOURS
    );

    // 连续同向步进向前垫进起点；快速回撤至原目标附近时朝上一目标方向预留回拉行程
    const currentMidway: number = 6 - (MINI_APP_RANGE_ADVANCE_REMAINING_THRESHOLD + 0.45);
    expect(resolveAnimatedRangeStartValue(currentMidway, 6, 12)).toBeCloseTo(
      currentMidway + (6 - currentMidway) * MINI_APP_RANGE_PULLBACK_MAX_SPAN,
      6
    );
    const nearPrevTarget: number = 3 + MINI_APP_RANGE_PULLBACK_MIN_SPAN * 0.2;
    expect(resolveAnimatedRangeStartValue(nearPrevTarget, 6, 3)).toBeCloseTo(
      3 + MINI_APP_RANGE_PULLBACK_MAX_SPAN,
      6
    );
  });

  test("高 DPR 物理像素对齐与底边 1:1 锁死、首次展开动画及 InlineNoticeCollapse 渐隐/Flex 间距补偿", () => {
    const host = globalThis as { devicePixelRatio?: number; getComputedStyle?: unknown };
    const prevDpr: number | undefined = host.devicePixelRatio;
    const prevComputed: unknown = host.getComputedStyle;
    const frames: FakeAnimationFrames = installFakeAnimationFrames();
    try {
      // 1. DPR=2 与 DPR=3 子像素测量：起止高度按物理像素网格对齐，逐帧裁剪高度与内层底边 1:1 锁死，负半像素舍入与位移同源。
      host.devicePixelRatio = 2;
      expect(snapFlipPx(210.5)).toBe(210.5);
      expect(formatFlipPx(210.5)).toBe("210.5px");
      expect(snapFlipPx(-0.0001)).toBe(0);
      expect(formatTranslate3dY(-5.25)).toBe(`translate3d(0, ${snapFlipPx(-5.25)}px, 0)`);
      let subpixelH: number = 210.5;
      const innerEl: FlipAnimatableElement = {
        style: { transform: "", willChange: "", opacity: "", pointerEvents: "" }, dataset: {},
        getBoundingClientRect: () => ({ top: 40, height: subpixelH }),
      };
      const gridEl: FlipAnimatableElement = {
        classList: createMockClassList(["cap-collapse-wrap"]),
        style: { height: "", marginTop: "", marginBottom: "", transform: "", willChange: "" },
        getBoundingClientRect: () => ({ top: 40, height: subpixelH }),
      };
      runFlipCollapseTransition({ gridEl, innerEl, expanded: false, wasOneFrInDom: true });
      expect(gridEl.style?.height).toBe("210.5px");
      expect(innerEl.style?.transform).toBe("translate3d(0, 0, 0)");
      frames.flush(0);
      for (let t: number = TEST_FRAME_MS; t < MINI_APP_FLIP_COLLAPSE_DURATION_MS; t += TEST_FRAME_MS) {
        frames.flush(t);
        expect(snapFlipPx(subpixelH + readPx(innerEl.style?.transform))).toBe(readPx(gridEl.style?.height));
      }
      frames.flush(MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(gridEl.style?.height).toBe("");

      host.devicePixelRatio = 3;
      subpixelH = 210 + 1 / 3;
      const snappedDpr3: number = snapFlipPx(subpixelH);
      expect(snappedDpr3).toBe(Math.round(subpixelH * MINI_APP_FLIP_PX_PRECISION_SCALE) / MINI_APP_FLIP_PX_PRECISION_SCALE);
      runFlipCollapseTransition({ gridEl, innerEl, expanded: true, wasOneFrInDom: false });
      expect(gridEl.style?.height).toBe("0px");
      expect(innerEl.style?.transform).toBe(`translate3d(0, -${snappedDpr3}px, 0)`);
      frames.flush(1_000);
      for (let t: number = 1_000 + TEST_FRAME_MS; t < 1_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS; t += TEST_FRAME_MS) {
        frames.flush(t);
        expect(snapFlipPx(snappedDpr3 + readPx(innerEl.style?.transform))).toBe(readPx(gridEl.style?.height));
      }
      frames.flush(1_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(gridEl.style?.height).toBe("");

      // 2. animateOnInitialExpand：默认初始展开不播动画；开启时首次挂载从 0px 展开，后续重跑不重复触发。
      host.devicePixelRatio = 1;
      subpixelH = 160;
      const initialMountRef = { current: true };
      const prevExpandedRef = { current: true };
      const prevResetKeyRef = { current: null as string | null };
      const closingActiveRef = { current: false };
      const syncBase = { gridRef: { current: gridEl }, innerRef: { current: innerEl }, prevExpandedRef, prevResetKeyRef, closingActiveRef };
      expect(syncFlipCollapseLayoutEffect({ expanded: true, resetKey: null, ...syncBase })).toBeUndefined();
      const cancelInitExpand = syncFlipCollapseLayoutEffect({
        expanded: true, resetKey: null, animateOnInitialExpand: true, initialMountRef, ...syncBase,
      });
      expect(initialMountRef.current).toBeFalse();
      expect(gridEl.style?.height).toBe("0px");
      frames.flush(2_000);
      frames.advanceTo(2_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(gridEl.style?.height).toBe("");
      cancelInitExpand?.();
      expect(
        syncFlipCollapseLayoutEffect({ expanded: true, resetKey: null, animateOnInitialExpand: true, initialMountRef, ...syncBase })
      ).toBeUndefined();

      // 3. InlineNoticeCollapse SSR 渲染（支持数值 resetKey）、自动渐隐与纵向 Flex row-gap 负边距同步插值。
      const closedHtml: string = renderToStaticMarkup(
        createElement(InlineNoticeCollapse<string>, { activeValue: null, resetKey: 1, children: (v: string) => createElement("span", null, v) })
      );
      expect(closedHtml).toContain(`class="${MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME} "`);
      expect(closedHtml).toContain('aria-hidden="true"');
      expect(closedHtml).toContain(`class="${MINI_APP_INLINE_NOTICE_INNER_CLASS_NAME}"></div>`);
      const openHtml: string = renderToStaticMarkup(
        createElement(InlineNoticeCollapse<string>, { activeValue: "ok", resetKey: 2, children: (v: string) => createElement("span", null, v) })
      );
      expect(openHtml).toContain(`class="${MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME} expanded"`);
      expect(openHtml).toContain("<span>ok</span>");

      const flexParent: FlipAnimatableElement = { tagName: "DIV" };
      const visibleSibling: FlipAnimatableElement = { tagName: "BUTTON" };
      host.getComputedStyle = (el: FlipAnimatableElement) =>
        el === flexParent ? { display: "flex", flexDirection: "column", rowGap: "10px" } : { display: "block" };
      const noticeGridEl: FlipAnimatableElement = {
        parentElement: flexParent, previousElementSibling: visibleSibling,
        classList: createMockClassList([MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME]),
        style: { height: "", marginTop: "", marginBottom: "", transform: "", willChange: "" },
        getBoundingClientRect: () => ({ top: 80, height: 52 }),
      };
      expect(shouldFadeInnerPanel(noticeGridEl)).toBeTrue();
      runFlipCollapseTransition({ gridEl: noticeGridEl, innerEl, expanded: true, wasOneFrInDom: false });
      expect(noticeGridEl.style?.marginTop).toBe("-10px");
      expect(innerEl.style?.opacity).toBe("0");
      frames.flush(3_000);
      frames.flush(3_000 + TEST_FRAME_MS);
      const earlyLinear: number = TEST_FRAME_MS / MINI_APP_FLIP_COLLAPSE_DURATION_MS;
      expect(readPx(noticeGridEl.style?.marginTop)).toBe(snapFlipPx(-10 * (1 - ease(earlyLinear))));
      frames.advanceTo(3_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(noticeGridEl.style?.marginTop).toBe("");

      const leadingNoticeEl: FlipAnimatableElement = {
        parentElement: flexParent, nextElementSibling: visibleSibling,
        classList: createMockClassList([MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME]),
        style: { height: "", marginTop: "", marginBottom: "", transform: "", willChange: "" },
        getBoundingClientRect: () => ({ top: 20, height: 52 }),
      };
      runFlipCollapseTransition({ gridEl: leadingNoticeEl, innerEl, expanded: true, wasOneFrInDom: false });
      expect(leadingNoticeEl.style?.marginBottom).toBe("-10px");
      frames.flush(4_000);
      frames.advanceTo(4_000 + MINI_APP_FLIP_COLLAPSE_DURATION_MS);
      expect(leadingNoticeEl.style?.marginBottom).toBe("");

      // 4. 白名单展开行移出保留快照：同 contextKey 原位回插，跨页夹紧等 contextKey 变化时不跨页回插。
      const rowA = { id: 1, displayName: "A" } as never;
      const rowB = { id: 2, displayName: "B" } as never;
      const livePage2 = [rowB];
      const page2Snapshot = { contextKey: "whitelist:2:10:", index: 0, entry: rowB };
      expect(mergeRetainedClosingWhitelistItems([], page2Snapshot, "whitelist:2:10:")).toEqual([rowB]);
      expect(mergeRetainedClosingWhitelistItems(livePage2, page2Snapshot, "whitelist:2:10:")).toBe(livePage2);
      expect(mergeRetainedClosingWhitelistItems([rowA], page2Snapshot, "whitelist:1:10:")).toEqual([rowA]);
    } finally {
      frames.restore();
      host.devicePixelRatio = prevDpr;
      host.getComputedStyle = prevComputed;
    }
  });
});
