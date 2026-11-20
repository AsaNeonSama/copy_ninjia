/**
 * Mini App 实时状态页顶部随机四象限折线拼块的几何约束、多轮历史滑动排重、状态仓库刷新策略、
 * 全站骨架屏与成卡盒模型对齐及 `GalleryPage` 单卡双骨架（元数据与图片骨架独立切换与连续播放）渲染测试。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatDetailSkeleton } from "../../packages/mini-app-frontend/components/skeletons/ChatDetailSkeleton";
import { StatusSkeleton } from "../../packages/mini-app-frontend/components/skeletons/StatusSkeleton";
import {
  MINI_APP_GALLERY_DEFAULT_PAGE_SIZE,
  MINI_APP_GALLERY_PAGE_SIZE_OPTIONS,
  MINI_APP_MIN_LOADING_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  STATUS_QUAD_CHECK_BOX_HEIGHTS_PX,
  STATUS_QUAD_CHECK_BOX_WIDTHS_PX,
  STATUS_QUAD_HALF_GAP_PX,
  STATUS_QUAD_HISTORY_MAX,
  STATUS_QUAD_MIN_BEND_TURN_DEG,
  STATUS_QUAD_MIN_INTERIOR_ANGLE_DEG,
  STATUS_QUAD_MIN_LAYOUT_DELTA_PX,
  STATUS_QUAD_MIN_SEGMENT_PX,
  STATUS_QUAD_MIN_TOTAL_BENDS,
  STATUS_QUAD_OVERLAP_X_PX,
  STATUS_QUAD_OVERLAP_Y_PX,
} from "../../packages/mini-app-frontend/consts/statusMosaic";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { formatGalleryFileSize } from "../../packages/mini-app-frontend/libs/formatters";
import {
  computeGeometryDeltaPx,
  evaluateStatusQuadPolygon,
  materializeGeometryPolygons,
} from "../../packages/mini-app-frontend/libs/statusQuadGeometry";
import {
  DEFAULT_STATUS_QUAD_MOSAIC,
  generateStatusQuadMosaic,
} from "../../packages/mini-app-frontend/libs/statusQuadMosaic";
import { GalleryPage } from "../../packages/mini-app-frontend/pages/GalleryPage";
import { StatusPage } from "../../packages/mini-app-frontend/pages/StatusPage";
import { resetMiniAppStoreForTest } from "../../packages/mini-app-frontend/store/app";
import { createGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import type { MiniAppGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import { createStatusStore } from "../../packages/mini-app-frontend/store/status";
import type { MiniAppStatusStore } from "../../packages/mini-app-frontend/store/status";
import type {
  MiniAppGalleryItem,
  MiniAppStatusView,
} from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import type {
  StatusQuadMosaicLayout,
  StatusQuadMosaicPoint,
  StatusQuadMosaicPolygons,
  StatusQuadPolygonMetrics,
} from "../../packages/mini-app-frontend/types/statusMosaic";
import {
  collectNodeText,
  findButtonByText,
  findElements,
  hasClass,
  installMiniDom,
} from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";
import { extractCssBlockBody, readStrippedCss } from "./helpers/cssInspect";
import {
  seedTestMiniAppSession,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

type RouteHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
const originalFetch: typeof fetch = globalThis.fetch;
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

function route(key: string, handler: RouteHandler): void {
  routes.set(key, handler);
}

function jsonResponse(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function flushFakeMinLoading(task?: Promise<void>): Promise<void> {
  for (let tick: number = 0; tick < 6; tick += 1) {
    Bun.sleepSync(2);
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
  }
  jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS);
  for (let tick: number = 0; tick < 6; tick += 1) {
    Bun.sleepSync(2);
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
  }
  if (task !== undefined) {
    await task;
  }
}

async function withMountedElement(
  element: React.JSX.Element,
  run: (container: MiniDomNode, flushMinLoading: () => Promise<void>) => Promise<void>
): Promise<void> {
  jest.useFakeTimers();
  const environment: MiniDomEnvironment = installMiniDom();
  try {
    const container: MiniDomNode = environment.document.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    const flushMinLoading = async (): Promise<void> => {
      await act(async (): Promise<void> => {
        await flushFakeMinLoading();
      });
    };

    try {
      await act(async (): Promise<void> => {
        root.render(element);
      });
      await run(container, flushMinLoading);
    } finally {
      await act(async (): Promise<void> => {
        root.unmount();
      });
    }
  } finally {
    jest.useRealTimers();
    environment.restore();
  }
}

function sampleStatusView(overrides: Partial<MiniAppStatusView> = {}): Readonly<MiniAppStatusView> {
  return {
    generatedAt: 1_700_000_000_000,
    uptimeMs: 60_000,
    cpuAveragePercent: 12.5,
    memoryPeakRssBytes: 64 * 1024 * 1024,
    memoryCurrentRssBytes: 48 * 1024 * 1024,
    memoryOtherBytes: 16 * 1024 * 1024,
    memoryTotalBytes: 32 * 1024 * 1024,
    memoryHeapUsedBytes: 24 * 1024 * 1024,
    managedChatCount: 2,
    whitelistCount: 3,
    blocklistCount: 1,
    activeSessions: { total: 0, gag: 0, wed: 0, verify: 0, qaSet: 0 },
    telegramOutbound: { inFlight: 0, retryWaiting: 0, retryQueueMax: 10 },
    capabilities: [
      { key: "mood", label: "Mood", ready: true, detail: "ok", items: [{ label: "Current", value: "calm" }] },
    ],
    ...overrides,
  };
}

/** 校验单段 `--stat-quad-clip` 为直线 `polygon(...)`（可含 `calc(...)`）、无圆角/弧线原语且保留指定外角顶点。 */
function assertStraightPolygonClip(clip: string, expectedOuterCorner: string): void {
  expect(clip).toMatch(/^polygon\((?:[^()]+|\([^()]+\))+\)$/u);
  expect(clip).not.toMatch(/\b(?:circle|ellipse|inset|path|round|arc)\b/iu);
  const vertices: readonly string[] = clip.slice("polygon(".length, -1).split(", ");
  expect(vertices.length).toBeGreaterThanOrEqual(4);
  expect(vertices).toContain(expectedOuterCorner);
}

/** 校验一组四象限布局在所有参考视口盒尺寸下的内角、转角、最短边长、总折点数与均匀 `2 * STATUS_QUAD_HALF_GAP_PX` 缝隙。 */
function assertMosaicGeometry(layout: Readonly<StatusQuadMosaicLayout>): void {
  assertStraightPolygonClip(layout.q1Clip, "0 0");
  assertStraightPolygonClip(layout.q2Clip, "100% 0");
  assertStraightPolygonClip(layout.q3Clip, "0 100%");
  assertStraightPolygonClip(layout.q4Clip, "100% 100%");

  const topLen: number = layout.topSeam.knots.length;
  const botLen: number = layout.bottomSeam.knots.length;
  const leftLen: number = layout.leftSeam.knots.length;
  const rightLen: number = layout.rightSeam.knots.length;
  expect(topLen + botLen + leftLen + rightLen).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_TOTAL_BENDS);

  const pairCount: number = Math.min(
    STATUS_QUAD_CHECK_BOX_WIDTHS_PX.length,
    STATUS_QUAD_CHECK_BOX_HEIGHTS_PX.length
  );
  const maxReflexAllowed: number = 360 - STATUS_QUAD_MIN_INTERIOR_ANGLE_DEG;
  const expectedGap: number = 2 * STATUS_QUAD_HALF_GAP_PX;

  for (let boxIdx: number = 0; boxIdx < pairCount; boxIdx += 1) {
    const widthPx: number = STATUS_QUAD_CHECK_BOX_WIDTHS_PX[boxIdx]!;
    const heightPx: number = STATUS_QUAD_CHECK_BOX_HEIGHTS_PX[boxIdx]!;
    const polygons: StatusQuadMosaicPolygons = materializeGeometryPolygons(layout, widthPx, heightPx);

    for (const poly of [polygons.q1, polygons.q2, polygons.q3, polygons.q4]) {
      const metrics: StatusQuadPolygonMetrics = evaluateStatusQuadPolygon(poly);
      expect(metrics.valid).toBeTrue();
      expect(metrics.minConvexAngleDeg).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_INTERIOR_ANGLE_DEG);
      expect(metrics.maxReflexAngleDeg).toBeLessThanOrEqual(maxReflexAllowed);
      expect(metrics.minBendTurnDeg).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_BEND_TURN_DEG);
      expect(metrics.minSegmentPx).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_SEGMENT_PX);
    }

    const offsetX: number = widthPx - STATUS_QUAD_OVERLAP_X_PX;
    const offsetY: number = heightPx - STATUS_QUAD_OVERLAP_Y_PX;
    const { q1, q2, q3, q4 }: StatusQuadMosaicPolygons = polygons;

    const q1Hub: Readonly<StatusQuadMosaicPoint> = q1[2 + topLen]!;
    const q2Hub: Readonly<StatusQuadMosaicPoint> = q2[3 + rightLen]!;
    const q3Hub: Readonly<StatusQuadMosaicPoint> = q3[1 + leftLen]!;
    const q4Hub: Readonly<StatusQuadMosaicPoint> = q4[0]!;

    // 上、下、左、右外端与中心十字枢纽在统一网格坐标下的留白间距均须为 2 * STATUS_QUAD_HALF_GAP_PX。
    expect(offsetX + q2[0]!.x - q1[1]!.x).toBeCloseTo(expectedGap, 6);
    expect(q2[0]!.y).toBeCloseTo(q1[1]!.y, 6);
    expect(offsetX + q2Hub.x - q1Hub.x).toBeCloseTo(expectedGap, 6);
    expect(q2Hub.y).toBeCloseTo(q1Hub.y, 6);

    expect(offsetY + q3[0]!.y - q1[q1.length - 1]!.y).toBeCloseTo(expectedGap, 6);
    expect(q3[0]!.x).toBeCloseTo(q1[q1.length - 1]!.x, 6);
    expect(offsetY + q3Hub.y - q1Hub.y).toBeCloseTo(expectedGap, 6);
    expect(q3Hub.x).toBeCloseTo(q1Hub.x, 6);

    const q4RightOuter: Readonly<StatusQuadMosaicPoint> = q4[1 + rightLen]!;
    expect(offsetY + q4RightOuter.y - q2[2]!.y).toBeCloseTo(expectedGap, 6);
    expect(q4RightOuter.x).toBeCloseTo(q2[2]!.x, 6);
    expect(offsetY + q4Hub.y - q2Hub.y).toBeCloseTo(expectedGap, 6);
    expect(q4Hub.x).toBeCloseTo(q2Hub.x, 6);

    const q4BotOuter: Readonly<StatusQuadMosaicPoint> = q4[3 + rightLen]!;
    const q3BotOuter: Readonly<StatusQuadMosaicPoint> = q3[q3.length - 2]!;
    expect(offsetX + q4BotOuter.x - q3BotOuter.x).toBeCloseTo(expectedGap, 6);
    expect(q4BotOuter.y).toBeCloseTo(q3BotOuter.y, 6);
    expect(offsetX + q4Hub.x - q3Hub.x).toBeCloseTo(expectedGap, 6);
    expect(q4Hub.y).toBeCloseTo(q3Hub.y, 6);

    expect(offsetX + q4Hub.x - q1Hub.x).toBeCloseTo(expectedGap, 6);
    expect(offsetY + q4Hub.y - q1Hub.y).toBeCloseTo(expectedGap, 6);

    const knotMismatches: string[] = [];
    const checkKnotPair = (label: string, gap: number, alongDiff: number): void => {
      if (Math.abs(gap - expectedGap) > 1e-6 || Math.abs(alongDiff) > 1e-6) {
        knotMismatches.push(`${label} gap=${gap.toFixed(4)} alongDiff=${alongDiff.toFixed(4)}`);
      }
    };
    for (let k: number = 0; k < topLen; k += 1) {
      checkKnotPair(`top[${k}]`, offsetX + q2[q2.length - 1 - k]!.x - q1[2 + k]!.x, q2[q2.length - 1 - k]!.y - q1[2 + k]!.y);
    }
    for (let k: number = 0; k < leftLen; k += 1) {
      checkKnotPair(`left[${k}]`, offsetY + q3[1 + k]!.y - q1[q1.length - 2 - k]!.y, q3[1 + k]!.x - q1[q1.length - 2 - k]!.x);
    }
    for (let k: number = 0; k < rightLen; k += 1) {
      checkKnotPair(`right[${k}]`, offsetY + q4[1 + k]!.y - q2[3 + rightLen - 1 - k]!.y, q4[1 + k]!.x - q2[3 + rightLen - 1 - k]!.x);
    }
    for (let k: number = 0; k < botLen; k += 1) {
      checkKnotPair(`bottom[${k}]`, offsetX + q4[q4.length - 1 - k]!.x - q3[2 + leftLen + k]!.x, q4[q4.length - 1 - k]!.y - q3[2 + leftLen + k]!.y);
    }
    expect(knotMismatches).toEqual([]);
  }
}

/** 读取已挂载四象限拼块 `.stat-quad-q1..q4` 的行内 `--stat-quad-clip` 并校验形状合法性。 */
function readMountedQuadClips(
  container: MiniDomNode,
  expectSkeleton: boolean
): readonly [string, string, string, string] {
  const mosaics: MiniDomNode[] = findElements(
    container,
    (node: MiniDomNode): boolean => hasClass(node, "stat-quad-mosaic")
  );
  expect(mosaics).toHaveLength(1);
  expect(hasClass(mosaics[0]!, "stat-quad-mosaic-skeleton")).toBe(expectSkeleton);

  const specs: readonly (readonly [string, string])[] = [
    ["stat-quad-q1", "0 0"],
    ["stat-quad-q2", "100% 0"],
    ["stat-quad-q3", "0 100%"],
    ["stat-quad-q4", "100% 100%"],
  ];
  const clips: string[] = [];
  for (const [quadClass, outerCorner] of specs) {
    const tiles: MiniDomNode[] = findElements(
      mosaics[0]!,
      (node: MiniDomNode): boolean => hasClass(node, quadClass)
    );
    expect(tiles).toHaveLength(1);
    const clip: string = tiles[0]!.style.getPropertyValue("--stat-quad-clip");
    expect(clip.length).toBeGreaterThan(0);
    assertStraightPolygonClip(clip, outerCorner);
    clips.push(clip);
  }
  return [clips[0]!, clips[1]!, clips[2]!, clips[3]!];
}

function expectCssRules(
  css: string,
  specs: readonly (readonly [RegExp, readonly string[]])[]
): void {
  for (const [pattern, declarations] of specs) {
    const body: string = extractCssBlockBody(css, pattern);
    expect(body.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(body).toContain(declaration);
    }
  }
}

beforeEach((): void => {
  resetMiniAppStoreForTest();
  routes.clear();
  seedTestMiniAppSession("e".repeat(64), Date.now() + 600_000);
  globalThis.fetch = wrapEncryptedTestFetch(
    (url: URL, init?: RequestInit): Response | Promise<Response> => {
      const method: string = (init?.method ?? "GET").toUpperCase();
      const handler: RouteHandler | undefined = routes.get(`${method} ${url.pathname}`);
      if (handler === undefined) return jsonResponse({ error: `Unexpected ${method} ${url.pathname}` }, 500);
      return handler(url, init);
    }
  );
});

afterEach((): void => {
  jest.useRealTimers();
  (globalThis as { Telegram?: unknown }).Telegram = undefined;
  globalThis.fetch = originalFetch;
  routes.clear();
  clearMiniAppSessionToken();
  resetMiniAppStoreForTest();
});

describe("实时状态页四象限随机折线拼块", () => {
  test("300 次随机抽样与默认兜底布局全部满足参考视口直线角度、折角、最短边长、总折点数与均匀缝隙约束", async () => {
    expect(STATUS_QUAD_CHECK_BOX_WIDTHS_PX.length).toBeGreaterThan(0);
    expect(STATUS_QUAD_CHECK_BOX_HEIGHTS_PX).toHaveLength(STATUS_QUAD_CHECK_BOX_WIDTHS_PX.length);

    assertMosaicGeometry(DEFAULT_STATUS_QUAD_MOSAIC);
    const statusCss: string = await readStrippedCss("packages/mini-app-frontend/styles/status.css");
    for (const [quadClass, expectedClip] of [
      ["stat-quad-q1", DEFAULT_STATUS_QUAD_MOSAIC.q1Clip],
      ["stat-quad-q2", DEFAULT_STATUS_QUAD_MOSAIC.q2Clip],
      ["stat-quad-q3", DEFAULT_STATUS_QUAD_MOSAIC.q3Clip],
      ["stat-quad-q4", DEFAULT_STATUS_QUAD_MOSAIC.q4Clip],
    ] as const) {
      const ruleBody: string = extractCssBlockBody(
        statusCss,
        new RegExp(`(?:^|\\n)\\.stat-quad-mosaic\\s*>\\s*\\.stat-quad-tile\\.${quadClass}\\s*\\{`, "u")
      );
      expect(ruleBody).toContain(`--stat-quad-clip: ${expectedClip};`);
    }

    const degenerate: StatusQuadPolygonMetrics = evaluateStatusQuadPolygon([
      { x: 0, y: 0, isBend: false },
      { x: 10, y: 0, isBend: false },
    ]);
    expect(degenerate.valid).toBeFalse();
    expect(degenerate.minSegmentPx).toBe(0);

    for (let draw: number = 0; draw < 300; draw += 1) {
      const layout: StatusQuadMosaicLayout = generateStatusQuadMosaic();
      assertMosaicGeometry(layout);
    }
  });

  test("previousHistory 滑动窗口、previous 合并与极端/重复随机数均保证多轮拓扑排重、最小像素位移及几何合法", () => {
    const firstSingle: StatusQuadMosaicLayout = generateStatusQuadMosaic();
    const secondSingle: StatusQuadMosaicLayout = generateStatusQuadMosaic({ previous: firstSingle });
    expect(secondSingle.signature).not.toBe(firstSingle.signature);
    expect(computeGeometryDeltaPx(secondSingle, firstSingle)).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_LAYOUT_DELTA_PX);
    assertMosaicGeometry(firstSingle);
    assertMosaicGeometry(secondSingle);

    const mergedNext: StatusQuadMosaicLayout = generateStatusQuadMosaic({
      previousHistory: [firstSingle],
      previous: secondSingle,
    });
    expect(mergedNext.signature).not.toBe(firstSingle.signature);
    expect(mergedNext.signature).not.toBe(secondSingle.signature);
    expect(computeGeometryDeltaPx(mergedNext, secondSingle)).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_LAYOUT_DELTA_PX);
    assertMosaicGeometry(mergedNext);

    const history: StatusQuadMosaicLayout[] = [];
    for (let step: number = 0; step < 24; step += 1) {
      const window: readonly Readonly<StatusQuadMosaicLayout>[] = history.slice(-STATUS_QUAD_HISTORY_MAX);
      const next: StatusQuadMosaicLayout = generateStatusQuadMosaic({ previousHistory: window });
      assertMosaicGeometry(next);
      for (const prev of window) {
        expect(next.signature).not.toBe(prev.signature);
      }
      const latest: Readonly<StatusQuadMosaicLayout> | undefined = window[window.length - 1];
      if (latest !== undefined) {
        expect(computeGeometryDeltaPx(next, latest)).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_LAYOUT_DELTA_PX);
      }
      history.push(next);
    }

    const assertSeamSignatureMatchesGeometry = (layout: Readonly<StatusQuadMosaicLayout>): void => {
      const [topMode, botMode, leftMode, rightMode]: readonly string[] = layout.signature.split("|");
      const topSign: string = layout.topSeam.outerCrossPx >= layout.hubX ? "+" : "-";
      const botSign: string = layout.bottomSeam.outerCrossPx >= layout.hubX ? "+" : "-";
      const leftSign: string = (layout.leftSeam.knots.length === 3 ? layout.leftSeam.knots[1]!.crossPx : layout.leftSeam.outerCrossPx) >= layout.hubY ? "+" : "-";
      const rightSign: string = (layout.rightSeam.knots.length === 3 ? layout.rightSeam.knots[1]!.crossPx : layout.rightSeam.outerCrossPx) >= layout.hubY ? "+" : "-";
      expect(topMode).toBe(`${layout.topSeam.knots.length}${topSign}`);
      expect(botMode).toBe(`${layout.bottomSeam.knots.length}${botSign}`);
      expect(leftMode).toBe(`${layout.leftSeam.knots.length}${leftSign}`);
      expect(rightMode).toBe(`${layout.rightSeam.knots.length}${rightSign}`);
    };

    for (const fixedRng of [(): number => 0, (): number => 0.999999]) {
      const draws: StatusQuadMosaicLayout[] = [];
      for (let step: number = 0; step < 6; step += 1) {
        const next: StatusQuadMosaicLayout = generateStatusQuadMosaic({
          random: fixedRng,
          previousHistory: draws,
        });
        assertMosaicGeometry(next);
        assertSeamSignatureMatchesGeometry(next);
        const latest: Readonly<StatusQuadMosaicLayout> | undefined = draws[draws.length - 1];
        if (latest !== undefined) {
          expect(next.signature).not.toBe(latest.signature);
          expect(computeGeometryDeltaPx(next, latest)).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_LAYOUT_DELTA_PX);
        }
        draws.push(next);
      }
      const firstFourSignatures: ReadonlySet<string> = new Set<string>(
        draws.slice(0, 4).map((item: Readonly<StatusQuadMosaicLayout>): string => item.signature)
      );
      expect(firstFourSignatures.size).toBe(4);
      expect(draws[4]!.signature).toBe(draws[0]!.signature);
      expect(draws[5]!.signature).toBe(draws[1]!.signature);
    }

    // 当自定义随机数稳定产出已出现在历史中的合法布局时，触发去重上限后平滑回落到预验证兜底布局。
    const repeatedValidRng = (): number => 0.7;
    const repeatedFirst: StatusQuadMosaicLayout = generateStatusQuadMosaic({ random: repeatedValidRng });
    assertMosaicGeometry(repeatedFirst);
    const repeatedSecond: StatusQuadMosaicLayout = generateStatusQuadMosaic({
      random: repeatedValidRng,
      previousHistory: [repeatedFirst],
    });
    assertMosaicGeometry(repeatedSecond);
    expect(repeatedSecond.signature).not.toBe(repeatedFirst.signature);
    expect(computeGeometryDeltaPx(repeatedSecond, repeatedFirst)).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_LAYOUT_DELTA_PX);
  });

  test("createStatusStore 保持后台轮询 quadMosaic 与 quadMosaicHistory 不变，并在连续手动刷新时累积至上限且规避近期签名", async () => {
    route("GET /api/mood", (): Response => jsonResponse({ ok: true, available: true, currentMood: "calm" }));
    route("GET /api/status", (): Response => jsonResponse(sampleStatusView()));

    jest.useFakeTimers();
    const store: MiniAppStatusStore = createStatusStore();
    const initialMosaic: Readonly<StatusQuadMosaicLayout> = store.getState().quadMosaic;
    const initialHistory: readonly Readonly<StatusQuadMosaicLayout>[] = store.getState().quadMosaicHistory;
    assertMosaicGeometry(initialMosaic);
    expect(initialHistory).toEqual([initialMosaic]);

    await flushFakeMinLoading(store.getState().loadStatus(false));
    await flushFakeMinLoading(store.getState().loadStatus(false));
    expect(store.getState().quadMosaic).toBe(initialMosaic);
    expect(store.getState().quadMosaic.signature).toBe(initialMosaic.signature);
    expect(store.getState().quadMosaicHistory).toBe(initialHistory);
    expect(store.getState().quadMosaicHistory).toEqual([initialMosaic]);

    const refreshCount: number = STATUS_QUAD_HISTORY_MAX + 2;
    for (let step: number = 1; step <= refreshCount; step += 1) {
      const prevMosaic: Readonly<StatusQuadMosaicLayout> = store.getState().quadMosaic;
      const prevHistory: readonly Readonly<StatusQuadMosaicLayout>[] = store.getState().quadMosaicHistory;

      await flushFakeMinLoading(store.getState().loadStatus(true));

      const nextMosaic: Readonly<StatusQuadMosaicLayout> = store.getState().quadMosaic;
      const nextHistory: readonly Readonly<StatusQuadMosaicLayout>[] = store.getState().quadMosaicHistory;
      expect(nextMosaic).not.toBe(prevMosaic);
      assertMosaicGeometry(nextMosaic);
      for (const entry of prevHistory) {
        expect(nextMosaic.signature).not.toBe(entry.signature);
      }
      expect(computeGeometryDeltaPx(nextMosaic, prevMosaic)).toBeGreaterThanOrEqual(STATUS_QUAD_MIN_LAYOUT_DELTA_PX);
      expect(nextHistory).toHaveLength(Math.min(step + 1, STATUS_QUAD_HISTORY_MAX));
      expect(nextHistory[nextHistory.length - 1]).toBe(nextMosaic);
      const historySignatures: ReadonlySet<string> = new Set<string>(
        nextHistory.map((entry: Readonly<StatusQuadMosaicLayout>): string => entry.signature)
      );
      expect(historySignatures.size).toBe(nextHistory.length);
    }

    const settledMosaic: Readonly<StatusQuadMosaicLayout> = store.getState().quadMosaic;
    const settledHistory: readonly Readonly<StatusQuadMosaicLayout>[] = store.getState().quadMosaicHistory;
    expect(settledHistory).toHaveLength(STATUS_QUAD_HISTORY_MAX);

    await flushFakeMinLoading(store.getState().loadStatus(false));
    expect(store.getState().quadMosaic).toBe(settledMosaic);
    expect(store.getState().quadMosaicHistory).toBe(settledHistory);
  });

  test("StatusPage 挂载时骨架与成卡共用同一 quadMosaic，手动刷新重抽并共享，重新挂载生成新随机布局", async () => {
    route("GET /api/mood", (): Response => jsonResponse({ ok: true, available: true, currentMood: "happy" }));
    route("GET /api/status", (): Response => jsonResponse(sampleStatusView()));

    await withMountedElement(
      createElement(StatusPage),
      async (container: MiniDomNode, flushMinLoading: () => Promise<void>): Promise<void> => {
        const initialSkeletonClips: readonly [string, string, string, string] = readMountedQuadClips(container, true);
        await flushMinLoading();
        const settledClips: readonly [string, string, string, string] = readMountedQuadClips(container, false);
        expect(settledClips).toEqual(initialSkeletonClips);

        const refreshButton: MiniDomNode | null = findButtonByText(container, zh.chats.refreshButton);
        expect(refreshButton).not.toBeNull();
        await act(async (): Promise<void> => {
          refreshButton!.triggerClick();
        });
        const refreshSkeletonClips: readonly [string, string, string, string] = readMountedQuadClips(container, true);
        expect(refreshSkeletonClips).not.toEqual(settledClips);

        await flushMinLoading();
        const refreshedCardClips: readonly [string, string, string, string] = readMountedQuadClips(container, false);
        expect(refreshedCardClips).toEqual(refreshSkeletonClips);
        expect(refreshedCardClips).not.toEqual(settledClips);
      }
    );

    await withMountedElement(
      createElement(StatusPage),
      async (container: MiniDomNode, flushMinLoading: () => Promise<void>): Promise<void> => {
        const secondSkeletonClips: readonly [string, string, string, string] = readMountedQuadClips(container, true);
        await flushMinLoading();
        const secondSettledClips: readonly [string, string, string, string] = readMountedQuadClips(container, false);
        expect(secondSettledClips).toEqual(secondSkeletonClips);
      }
    );
  });
});

describe("全站骨架屏与成卡盒模型及尺寸对齐核验", () => {
  test("status.css、chats.css、identities.css、skeletons.css、auth.css 与 gallery.css 定义全站骨架屏与成卡等高对齐规则", async () => {
    const gapPx: number = 2 * STATUS_QUAD_HALF_GAP_PX;
    const statusCss: string = await readStrippedCss("packages/mini-app-frontend/styles/status.css");
    expectCssRules(statusCss, [
      [/(?:^|\n)\.stat-quad-mosaic\s*\{/u, [
        `grid-template-columns: minmax(0, 1fr) ${STATUS_QUAD_OVERLAP_X_PX}px minmax(0, 1fr);`,
        `grid-template-rows: minmax(104px, auto) ${STATUS_QUAD_OVERLAP_Y_PX}px minmax(104px, auto);`,
      ]],
      [/(?:^|\n)@media\s*\(max-width:\s*360px\)\s*\{/u, [
        `grid-template-rows: minmax(96px, auto) ${STATUS_QUAD_OVERLAP_Y_PX}px minmax(96px, auto);`,
        "padding: 10px 33px 30px 9px;",
        "padding: 10px 9px 30px 33px;",
        "padding: 30px 33px 10px 9px;",
        "padding: 30px 9px 10px 33px;",
      ]],
      [/(?:^|\n)\.stat-quad-mosaic\.stat-quad-mosaic-skeleton\s*>\s*\.stat-box\.stat-quad-tile:not\(\.stat-box-cpu\),\s*\.stat-quad-mosaic\.stat-quad-mosaic-skeleton\s+\.stat-cpu-main\s*\{/u, [
        "display: flex;",
        "flex-direction: column;",
        "justify-content: center;",
        `gap: ${gapPx}px;`,
      ]],
      [/(?:^|\n)\.skeleton-detail-wrap\s+\.stat-box\.stat-box-outbound\s*\{/u, ["gap: 8px;"]],
      [/(?:^|\n)\.skeleton-line\.stat-skeleton-bar\s*\{/u, ["max-width: 100%;", "margin-left: 0;", "transform: none;", "height: 10px;"]],
      [/(?:^|\n)\.memory-bar-section\s*>\s*\.skeleton-line\.stat-skeleton-bar\s*\{/u, ["height: 14px;"]],
      [/(?:^|\n)\.skeleton-detail-wrap\s+\.memory-metric-card\s*\{/u, ["gap: 4px;"]],
    ]);

    const statusSkeletonHtml: string = renderToStaticMarkup(createElement(StatusSkeleton));
    expect(statusSkeletonHtml).toContain("stat-quad-mosaic-skeleton");
    expect(statusSkeletonHtml.match(/stat-skeleton-bar/gu)).toHaveLength(2);

    const chatsCss: string = await readStrippedCss("packages/mini-app-frontend/styles/chats.css");
    expectCssRules(chatsCss, [
      [/(?:^|\n)\.chat-detail-skeleton-overview\s+\.skeleton-sub-bar\s*\{/u, ["height: 14px;", "margin-bottom: 10px;"]],
      [/(?:^|\n)\.chat-detail-skeleton-overview\s+\.skeleton-perm-banner\s*\{/u, ["height: 48px;"]],
      [/(?:^|\n)\.chat-detail-skeleton-join\s+\.skeleton-section-bar,\s*\.chat-detail-skeleton-features\s+\.skeleton-section-bar\s*\{/u, ["height: 18px;", "margin-bottom: 10px;"]],
      [/(?:^|\n)\.chat-detail-skeleton-join\s+\.skeleton-perm-banner-spaced\s*\{/u, ["height: 57px;", "margin-bottom: 10px;"]],
      [/(?:^|\n)\.chat-detail-skeleton-join\s+\.skeleton-perm-banner:not\(\.skeleton-perm-banner-spaced\)\s*\{/u, ["height: 178px;"]],
    ]);

    const chatSkeletonHtml: string = renderToStaticMarkup(createElement(ChatDetailSkeleton));
    for (const cls of ["chat-detail-skeleton-overview", "chat-detail-skeleton-join", "chat-detail-skeleton-features", "skeleton-perm-banner-spaced"]) {
      expect(chatSkeletonHtml).toContain(cls);
    }

    const identitiesCss: string = await readStrippedCss("packages/mini-app-frontend/styles/identities.css");
    expectCssRules(identitiesCss, [
      [/(?:^|\n)\.identity-list-card\s*>\s*\.loading-box\s*\{/u, ["padding: 2px 0 4px;"]],
      [/(?:^|\n)\.identity-list-card\s+\.skeleton-card\s*\{/u, ["min-height: 53.5px;", "padding: 11px 12px;", "justify-content: center;"]],
    ]);

    const skeletonsCss: string = await readStrippedCss("packages/mini-app-frontend/styles/skeletons.css");
    expectCssRules(skeletonsCss, [
      [/(?:^|\n)\.skeleton-switch-row\s*\{/u, ["min-height: 62px;"]],
      [/(?:^|\n)\.chat-feature-row\s*\{/u, ["min-height: 62px;"]],
      [/(?:^|\n)\.skeleton-line\.skeleton-cpu-ring\s*\{/u, ["width: 48px;", "height: 48px;"]],
      [/(?:^|\n)\.skeleton-stat-value\s*\{/u, ["height: 22px;"]],
      [/(?:^|\n)\.skeleton-memory-value\s*\{/u, ["height: 16px;"]],
      [/(?:^|\n)\.skeleton-chevron-box\s*\{/u, ["width: 26px;", "height: 26px;"]],
      [/(?:^|\n)\.skeleton-cap-row,\s*\.cap-list\s*>\s*\.cap-block\.skeleton-cap-row\s*\{/u, ["padding: 10px 12px;", "min-height: 50px;"]],
      [/(?:^|\n)\.chat-targets-skeleton-list\s*\{/u, ["gap: 9px;", "padding-right: 3px;"]],
      [/(?:^|\n)\.chat-targets-skeleton-row\s*\{/u, ["min-height: 62px;"]],
      [/(?:^|\n)\.chat-targets-skeleton-action\s*\{/u, ["width: 64px;", "height: 30px;"]],
      [/(?:^|\n)\.loading-box:has\(\.msg-skeleton-card\)\s*\{/u, ["padding: 0;", "margin-bottom: 10px;"]],
      [/(?:^|\n)\.skeleton-stack:has\(>\s*\.msg-skeleton-card\)\s*\{/u, ["margin-top: 0;", "gap: 10px;"]],
      [/(?:^|\n)\.skeleton-line\.msg-skeleton-bubble\s*\{/u, ["max-width: 100%;", "margin: 0;", "height: 39px;", "transform: none;"]],
    ]);

    const authCss: string = await readStrippedCss("packages/mini-app-frontend/styles/auth.css");
    expectCssRules(authCss, [
      [/(?:^|\n)\.auth-gate-skeleton\s*>\s*\.skeleton-row-between\s*\{/u, ["margin-bottom: 10px;"]],
      [/(?:^|\n)\.skeleton-auth-desc\s*\{/u, ["display: flex;", "flex-direction: column;", "gap: 6px;", "margin: 5px 0 10px;"]],
      [/(?:^|\n)\.skeleton-auth-desc\s*>\s*\.skeleton-line\s*\{/u, ["height: 12px;"]],
    ]);

    const galleryCss: string = await readStrippedCss("packages/mini-app-frontend/styles/gallery.css");
    expectCssRules(galleryCss, [
      [/(?:^|\n)\.gallery-img-skeleton::after\s*\{/u, [
        "animation-duration: 0.92s;",
        "animation-delay: -0.24s;",
      ]],
      [/(?:^|\n)\.gallery-meta\s*\{/u, [
        "padding: 7px 8px;",
        "min-height: 47px;",
        "justify-content: center;",
        "gap: 3px;",
      ]],
      [/(?:^|\n)@keyframes\s+gallery-meta-reveal\s*\{/u, [
        "opacity: 0;",
        "opacity: 1;",
      ]],
      [/(?:^|\n)\.gallery-name\s*\{/u, [
        "line-height: 16px;",
        "animation: gallery-meta-reveal 0.14s var(--ease-brutal);",
      ]],
      [/(?:^|\n)\.gallery-sub\s*\{/u, [
        "line-height: 14px;",
        "animation: gallery-meta-reveal 0.14s var(--ease-brutal);",
      ]],
      [/(?:^|\n)\.gallery-card\.gallery-skeleton-item\s*\{/u, [
        "pointer-events: none;",
        "cursor: default;",
      ]],
      [/(?:^|\n)\.gallery-skeleton-meta\s*\{/u, [
        "gap: 5px;",
        "padding: 8px;",
      ]],
      [/(?:^|\n)\.gallery-skeleton-name\s*\{/u, [
        "width: 72%;",
        "height: 14px;",
        "margin-left: 0;",
      ]],
      [/(?:^|\n)\.gallery-skeleton-sub\s*\{/u, [
        "width: 88%;",
        "height: 12px;",
        "margin-left: 0;",
      ]],
    ]);
  });

  test("GalleryPage 始终复用单张 .gallery-content-card 与分页栏，元数据与图片骨架独立切换并在列表就绪后连续播放不重挂载", async () => {
    const byClass = (root: MiniDomNode, className: string): MiniDomNode[] =>
      findElements(root, (node: MiniDomNode): boolean => hasClass(node, className));

    const readSingleContentShell = (
      container: MiniDomNode,
      expectedBusy: string
    ): { readonly card: MiniDomNode; readonly pagination: MiniDomNode } => {
      const cards: MiniDomNode[] = findElements(
        container,
        (node: MiniDomNode): boolean =>
          hasClass(node, "card") && hasClass(node, "gallery-content-card")
      );
      expect(cards).toHaveLength(1);
      const card: MiniDomNode = cards[0]!;
      expect(card.getAttribute("aria-busy")).toBe(expectedBusy);
      expect(hasClass(card, "animate-fade-in")).toBeFalse();
      expect(byClass(container, "gallery-skeleton-grid-card")).toHaveLength(0);
      const paginationBars: MiniDomNode[] = byClass(card, "pagination-bar");
      expect(paginationBars).toHaveLength(1);
      return { card, pagination: paginationBars[0]! };
    };

    const assertSkeletonMetaSlots = (slots: readonly MiniDomNode[]): void => {
      for (const slot of slots) {
        expect(hasClass(slot, "gallery-skeleton-item")).toBeTrue();
        expect(
          findElements(
            slot,
            (node: MiniDomNode): boolean =>
              hasClass(node, "gallery-thumb-wrap") && hasClass(node, "loading")
          )
        ).toHaveLength(1);
        expect(byClass(slot, "gallery-img-skeleton")).toHaveLength(1);
        expect(
          findElements(slot, (node: MiniDomNode): boolean => node.tagName === "IMG")
        ).toHaveLength(0);
        expect(byClass(slot, "gallery-skeleton-meta")).toHaveLength(1);
        expect(byClass(slot, "gallery-skeleton-name")).toHaveLength(1);
        expect(byClass(slot, "gallery-skeleton-sub")).toHaveLength(1);
        expect(byClass(slot, "gallery-name")).toHaveLength(0);
        expect(byClass(slot, "gallery-sub")).toHaveLength(0);
      }
    };

    const sampleItems: readonly Readonly<MiniAppGalleryItem>[] = [
      {
        fileName: "alpha.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        updatedAt: "2026-01-01 10:00:00",
      },
      {
        fileName: "beta.png",
        mimeType: "image/png",
        sizeBytes: 4096,
        updatedAt: "2026-01-01 11:00:00",
      },
    ];
    let currentItems: readonly Readonly<MiniAppGalleryItem>[] = sampleItems;
    const requestedGalleryQueries: { readonly page: number; readonly pageSize: number }[] = [];
    const requestedFileNames: string[] = [];
    const pendingFileSettleCallbacks: (() => void)[] = [];

    route("GET /api/gallery", (url: URL): Response => {
      const requestedPage: number = Number(url.searchParams.get("page") ?? 1);
      const requestedSize: number = Number(
        url.searchParams.get("pageSize") ?? MINI_APP_GALLERY_DEFAULT_PAGE_SIZE
      );
      requestedGalleryQueries.push({ page: requestedPage, pageSize: requestedSize });
      return jsonResponse({
        directory: "/data/gallery",
        exists: true,
        total: currentItems.length,
        page: requestedPage,
        pageSize: requestedSize,
        totalPages: 1,
        items: currentItems,
      });
    });

    route("GET /api/gallery/file", (url: URL, init: RequestInit | undefined): Promise<Response> => {
      const fileName: string = url.searchParams.get("fileName") ?? "";
      requestedFileNames.push(fileName);
      return new Promise<Response>((resolve: (response: Response) => void): void => {
        const settle = (): void => {
          resolve(
            new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
              status: 200,
              headers: { "Content-Type": "image/png" },
            })
          );
        };
        if (init?.signal?.aborted === true) {
          settle();
          return;
        }
        init?.signal?.addEventListener("abort", settle, { once: true });
        pendingFileSettleCallbacks.push(settle);
      });
    });

    try {
      // Part A: 单卡复用 + 元数据骨架与图片骨架独立切换，以及刷新回到元数据骨架。
      let partAStore: MiniAppGalleryStore | null = null;
      const partAStoreFactory = (): MiniAppGalleryStore => {
        const store: MiniAppGalleryStore = createGalleryStore();
        partAStore = store;
        return store;
      };

      await withMountedElement(
        createElement(GalleryPage, { storeFactory: partAStoreFactory }),
        async (container: MiniDomNode, flushMinLoading: () => Promise<void>): Promise<void> => {
          expect(partAStore).not.toBeNull();

          // 1. 首次元数据加载中：单卡 aria-busy="true"，按默认 pageSize 渲染双骨架槽位且无 <img>。
          expect(partAStore!.getState().loading).toBeTrue();
          const shellBefore: { readonly card: MiniDomNode; readonly pagination: MiniDomNode } =
            readSingleContentShell(container, "true");
          const contentCardBefore: MiniDomNode = shellBefore.card;
          const paginationBefore: MiniDomNode = shellBefore.pagination;

          const slotsBefore: MiniDomNode[] = byClass(contentCardBefore, "gallery-card");
          expect(slotsBefore).toHaveLength(MINI_APP_GALLERY_DEFAULT_PAGE_SIZE);
          assertSkeletonMetaSlots(slotsBefore);

          const slot0Before: MiniDomNode = slotsBefore[0]!;
          const slot1Before: MiniDomNode = slotsBefore[1]!;
          const imgSkel0Before: MiniDomNode = byClass(slot0Before, "gallery-img-skeleton")[0]!;
          const imgSkel1Before: MiniDomNode = byClass(slot1Before, "gallery-img-skeleton")[0]!;

          // 2. 元数据落定后（图片尚未 markThumbLoaded）：复用同一容器/分页栏/槽位与同一 <GalleryImageSkeleton> 节点，并立即展示文件名与大小。
          await flushMinLoading();
          expect(partAStore!.getState().loading).toBeFalse();
          expect(requestedGalleryQueries).toEqual([
            { page: 1, pageSize: MINI_APP_GALLERY_DEFAULT_PAGE_SIZE },
          ]);
          expect([...requestedFileNames].sort()).toEqual(["alpha.png", "beta.png"]);

          const shellAfterMeta: { readonly card: MiniDomNode; readonly pagination: MiniDomNode } =
            readSingleContentShell(container, "false");
          expect(shellAfterMeta.card).toBe(contentCardBefore);
          expect(shellAfterMeta.pagination).toBe(paginationBefore);

          const slotsAfterMeta: MiniDomNode[] = byClass(contentCardBefore, "gallery-card");
          expect(slotsAfterMeta).toHaveLength(2);
          expect(slotsAfterMeta[0]).toBe(slot0Before);
          expect(slotsAfterMeta[1]).toBe(slot1Before);
          expect(byClass(contentCardBefore, "gallery-skeleton-item")).toHaveLength(0);
          expect(byClass(contentCardBefore, "gallery-skeleton-meta")).toHaveLength(0);
          expect(byClass(contentCardBefore, "gallery-skeleton-name")).toHaveLength(0);
          expect(byClass(contentCardBefore, "gallery-skeleton-sub")).toHaveLength(0);

          const slot0SubText: string = collectNodeText(byClass(slot0Before, "gallery-sub")[0]!);
          const slot1SubText: string = collectNodeText(byClass(slot1Before, "gallery-sub")[0]!);
          expect(collectNodeText(byClass(slot0Before, "gallery-name")[0]!)).toBe("alpha.png");
          expect(slot0SubText).toContain(formatGalleryFileSize(2048));
          expect(slot0SubText).toContain("01-01 10:00");
          expect(collectNodeText(byClass(slot1Before, "gallery-name")[0]!)).toBe("beta.png");
          expect(slot1SubText).toContain(formatGalleryFileSize(4096));
          expect(slot1SubText).toContain("01-01 11:00");

          const imgSkel0AfterMeta: MiniDomNode[] = byClass(slot0Before, "gallery-img-skeleton");
          const imgSkel1AfterMeta: MiniDomNode[] = byClass(slot1Before, "gallery-img-skeleton");
          expect(imgSkel0AfterMeta).toHaveLength(1);
          expect(imgSkel1AfterMeta).toHaveLength(1);
          expect(imgSkel0AfterMeta[0]).toBe(imgSkel0Before);
          expect(imgSkel1AfterMeta[0]).toBe(imgSkel1Before);

          const img0AfterMeta: MiniDomNode[] = findElements(
            slot0Before,
            (node: MiniDomNode): boolean => node.tagName === "IMG"
          );
          const img1AfterMeta: MiniDomNode[] = findElements(
            slot1Before,
            (node: MiniDomNode): boolean => node.tagName === "IMG"
          );
          expect(img0AfterMeta).toHaveLength(1);
          expect(img1AfterMeta).toHaveLength(1);
          expect(img0AfterMeta[0]!.getAttribute("alt")).toBe("alpha.png");
          expect(hasClass(img0AfterMeta[0]!, "gallery-thumb")).toBeTrue();
          expect(hasClass(img0AfterMeta[0]!, "loading")).toBeTrue();
          expect(hasClass(img0AfterMeta[0]!, "loaded")).toBeFalse();
          expect(img1AfterMeta[0]!.getAttribute("alt")).toBe("beta.png");
          expect(hasClass(img1AfterMeta[0]!, "gallery-thumb")).toBeTrue();
          expect(hasClass(img1AfterMeta[0]!, "loading")).toBeTrue();
          expect(hasClass(img1AfterMeta[0]!, "loaded")).toBeFalse();

          // 3. 仅槽位 0 完成缩略图加载：槽位 0 卸载图片骨架且切为 .gallery-thumb.loaded，槽位 1 仍复用原图片骨架节点。
          partAStore!.getState().markThumbLoaded("alpha.png", partAStore!.getState().batchEpoch);
          await flushMinLoading();
          expect(partAStore!.getState().loadedImages).toEqual({ "alpha.png": true });

          expect(byClass(slot0Before, "gallery-img-skeleton")).toHaveLength(0);
          expect(hasClass(byClass(slot0Before, "gallery-thumb-wrap")[0]!, "loaded")).toBeTrue();
          const img0Settled: MiniDomNode = findElements(
            slot0Before,
            (node: MiniDomNode): boolean => node.tagName === "IMG"
          )[0]!;
          expect(img0Settled.getAttribute("alt")).toBe("alpha.png");
          expect(hasClass(img0Settled, "gallery-thumb")).toBeTrue();
          expect(hasClass(img0Settled, "loaded")).toBeTrue();
          expect(hasClass(img0Settled, "loading")).toBeFalse();

          const imgSkel1AfterImg0: MiniDomNode[] = byClass(slot1Before, "gallery-img-skeleton");
          expect(imgSkel1AfterImg0).toHaveLength(1);
          expect(imgSkel1AfterImg0[0]).toBe(imgSkel1Before);
          expect(hasClass(byClass(slot1Before, "gallery-thumb-wrap")[0]!, "loading")).toBeTrue();
          const img1StillLoading: MiniDomNode = findElements(
            slot1Before,
            (node: MiniDomNode): boolean => node.tagName === "IMG"
          )[0]!;
          expect(hasClass(img1StillLoading, "gallery-thumb")).toBeTrue();
          expect(hasClass(img1StillLoading, "loading")).toBeTrue();

          // 4. 点击刷新按钮：在 2 张图片的当前页保持单卡与 2 个槽位不变，文字区切回 .gallery-skeleton-meta，随后完整落定。
          const refreshButton: MiniDomNode | null = findButtonByText(
            container,
            zh.gallery.refreshButton
          );
          expect(refreshButton).not.toBeNull();
          await act(async (): Promise<void> => {
            refreshButton!.triggerClick();
          });

          expect(partAStore!.getState().loading).toBeTrue();
          const shellDuringRefresh: { readonly card: MiniDomNode; readonly pagination: MiniDomNode } =
            readSingleContentShell(container, "true");
          expect(shellDuringRefresh.card).toBe(contentCardBefore);
          expect(shellDuringRefresh.pagination).toBe(paginationBefore);

          const slotsDuringRefresh: MiniDomNode[] = byClass(contentCardBefore, "gallery-card");
          expect(slotsDuringRefresh).toHaveLength(2);
          expect(slotsDuringRefresh[0]).toBe(slot0Before);
          expect(slotsDuringRefresh[1]).toBe(slot1Before);
          assertSkeletonMetaSlots(slotsDuringRefresh);
          expect(byClass(slot1Before, "gallery-img-skeleton")[0]).toBe(imgSkel1Before);

          await flushMinLoading();
          expect(partAStore!.getState().loading).toBeFalse();
          expect(partAStore!.getState().batchEpoch).toBe(2);
          const shellAfterRefresh: { readonly card: MiniDomNode; readonly pagination: MiniDomNode } =
            readSingleContentShell(container, "false");
          expect(shellAfterRefresh.card).toBe(contentCardBefore);
          expect(shellAfterRefresh.pagination).toBe(paginationBefore);
          expect(byClass(contentCardBefore, "gallery-skeleton-item")).toHaveLength(0);
          expect(byClass(contentCardBefore, "gallery-card")).toEqual([slot0Before, slot1Before]);
          expect(collectNodeText(byClass(slot0Before, "gallery-name")[0]!)).toBe("alpha.png");
          expect(collectNodeText(byClass(slot1Before, "gallery-name")[0]!)).toBe("beta.png");
          expect(byClass(slot0Before, "gallery-img-skeleton")).toHaveLength(1);
          expect(byClass(slot1Before, "gallery-img-skeleton")[0]).toBe(imgSkel1Before);
          expect(requestedGalleryQueries).toHaveLength(2);
        }
      );

      // Part B: 自定义 pageSize 与空图库场景，加载后同一 .card.gallery-content-card 切换为 .empty 并保留同一分页栏。
      currentItems = [];
      const customPageSize: number = MINI_APP_GALLERY_PAGE_SIZE_OPTIONS[1]!;
      let partBStore: MiniAppGalleryStore | null = null;
      const customStoreFactory = (): MiniAppGalleryStore => {
        const store: MiniAppGalleryStore = createGalleryStore();
        store.setState({ pageSize: customPageSize });
        partBStore = store;
        return store;
      };

      await withMountedElement(
        createElement(GalleryPage, { storeFactory: customStoreFactory }),
        async (container: MiniDomNode, flushMinLoading: () => Promise<void>): Promise<void> => {
          expect(partBStore).not.toBeNull();
          expect(partBStore!.getState().loading).toBeTrue();

          const shellBefore: { readonly card: MiniDomNode; readonly pagination: MiniDomNode } =
            readSingleContentShell(container, "true");
          const slotsBefore: MiniDomNode[] = byClass(shellBefore.card, "gallery-card");
          expect(slotsBefore).toHaveLength(customPageSize);
          assertSkeletonMetaSlots(slotsBefore);

          await flushMinLoading();

          expect(partBStore!.getState().loading).toBeFalse();
          const shellAfter: { readonly card: MiniDomNode; readonly pagination: MiniDomNode } =
            readSingleContentShell(container, "false");
          expect(shellAfter.card).toBe(shellBefore.card);
          expect(shellAfter.pagination).toBe(shellBefore.pagination);

          const emptyBoxes: MiniDomNode[] = byClass(shellAfter.card, "empty");
          expect(emptyBoxes).toHaveLength(1);
          expect(collectNodeText(emptyBoxes[0]!)).toBe(zh.gallery.emptyGalleryHint);
          expect(byClass(shellAfter.card, "gallery-skeleton-item")).toHaveLength(0);
          expect(byClass(shellAfter.card, "gallery-card")).toHaveLength(0);
        }
      );
    } finally {
      for (const settle of pendingFileSettleCallbacks) {
        settle();
      }
    }
  });
});
