/**
 * Mini App 前端状态看板页（分离四象限拼块、中性底粉脊出站与内存卡、白黑名单与会话防溢出胶囊、双主题样式令牌、原样能力折叠卡）、顶部 Toast 定位与权限胶囊选中样式、身份策略页、消息列表、入群清理卡片与目标成员面板交互测试。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewportAnchorScroll } from "../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import { CapabilityBlock } from "../../packages/mini-app-frontend/components/CapabilityBlock";
import { ChatJoinCleanCard } from "../../packages/mini-app-frontend/components/ChatJoinCleanCard";
import {
  ChatTargetsMemberAddForm,
  ChatTargetsMemberPanels,
} from "../../packages/mini-app-frontend/components/ChatTargetsMemberPanels";
import { ChatTargetsModal } from "../../packages/mini-app-frontend/components/ChatTargetsModal";
import { MessagesView } from "../../packages/mini-app-frontend/components/MessagesView";
import { StatusSkeleton } from "../../packages/mini-app-frontend/components/skeletons/StatusSkeleton";
import { StatusOverviewCard } from "../../packages/mini-app-frontend/components/StatusOverviewCard";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_PRESET_HOURS,
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_LANGUAGES,
  MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES,
  MINI_APP_TRANSLATE_LANGUAGES,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { STATUS_QUAD_OVERLAP_X_PX, STATUS_QUAD_OVERLAP_Y_PX } from "../../packages/mini-app-frontend/consts/statusMosaic";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { IdentitiesPage } from "../../packages/mini-app-frontend/pages/IdentitiesPage";
import { StatusPage } from "../../packages/mini-app-frontend/pages/StatusPage";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import type {
  MiniAppChatsStore,
  MiniAppChatsStoreState,
} from "../../packages/mini-app-frontend/store/chats";
import { isValidChatTargetNumericInput } from "../../packages/mini-app-frontend/store/chatTargetsActions";
import type { WhitelistPermissionKey } from "../../packages/mini-app-frontend/types/identityPolicy";
import type {
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppChatTargetsView,
  MiniAppStatusView,
} from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  collectNodeText,
  findButtonByText,
  findElements,
  hasClass,
  installMiniDom,
} from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";
import {
  extractCssBlockBody,
  parseCssVariables,
  readStrippedCss,
} from "./helpers/cssInspect";
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

function sampleChatDetail(overrides: Partial<MiniAppChatDetail> = {}): Readonly<MiniAppChatDetail> {
  return {
    chatId: -1001,
    title: "Doro群",
    isLockdownActive: false,
    quietRemainingMs: 0,
    lockdownRemainingMs: 0,
    activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
    hotMessageCount: 3,
    hotMessageMax: VERBATIM_CONTEXT_MAX,
    qaPairCount: 1,
    deleteMessageTargetCount: 1,
    translateTargetCount: 1,
    joinedCountsByHour: [5, 10, 12, 15, 20, 30],
    batchKickRunning: false,
    lastBatchKickCompletion: null,
    features: { init: true, aiChat: true, translation: true, adDetect: false, floodControl: false, antiRaid: false, proxySend: false },
    botPermissions: { canDeleteMessages: true, canRestrictMembers: true, canChangeInfo: false, grantedLabels: [] },
    ...overrides,
  };
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

/** 校验状态概览卡 `.status-overview-card` 内的 `.grid-2`、`.stat-quad-mosaic` 与四象限拼块 `.stat-quad-q1..q4` 结构契约。 */
function assertQuadMosaicStructure(container: MiniDomNode, expectSkeleton: boolean): readonly MiniDomNode[] {
  const overviewCards: MiniDomNode[] = findElements(container, (node: MiniDomNode): boolean => hasClass(node, "status-overview-card"));
  expect(overviewCards).toHaveLength(1);
  const grids: MiniDomNode[] = findElements(overviewCards[0]!, (node: MiniDomNode): boolean => hasClass(node, "grid-2"));
  expect(grids).toHaveLength(1);

  const gridChildren: readonly MiniDomNode[] = grids[0]!.childNodes.filter((node: MiniDomNode): boolean => node.nodeType === 1);
  expect(gridChildren).toHaveLength(3);
  const [mosaic, outboundBox, memoryBox]: readonly [MiniDomNode, MiniDomNode, MiniDomNode] = [gridChildren[0]!, gridChildren[1]!, gridChildren[2]!];
  expect(hasClass(mosaic, "stat-quad-mosaic")).toBeTrue();
  expect(hasClass(mosaic, "stat-quad-mosaic-skeleton")).toBe(expectSkeleton);
  expect(hasClass(outboundBox, "stat-box") && hasClass(outboundBox, "stat-box-outbound")).toBeTrue();
  expect(hasClass(memoryBox, "stat-box") && hasClass(memoryBox, "stat-box-memory")).toBeTrue();

  const tiles: readonly MiniDomNode[] = mosaic.childNodes.filter((node: MiniDomNode): boolean => node.nodeType === 1);
  expect(tiles).toHaveLength(4);
  const expectedQuadClasses: readonly string[] = ["stat-quad-q1", "stat-quad-q2", "stat-quad-q3", "stat-quad-q4"];
  for (let index: number = 0; index < expectedQuadClasses.length; index += 1) {
    const tile: MiniDomNode = tiles[index]!;
    expect(hasClass(tile, "stat-box") && hasClass(tile, "stat-quad-tile") && hasClass(tile, expectedQuadClasses[index]!)).toBeTrue();
  }
  expect(hasClass(tiles[1]!, "stat-box-cpu")).toBeTrue();
  return tiles;
}

beforeEach((): void => {
  resetMiniAppStoreForTest();
  routes.clear();
  seedTestMiniAppSession("c".repeat(64), Date.now() + 600_000);
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

describe("Mini App 页面与面板组件", () => {
  test("IdentitiesPage 覆盖首屏骨架、白名单列表与切换黑名单空提示", async () => {
    const initialMarkup: string = renderToStaticMarkup(createElement(IdentitiesPage));
    expect(initialMarkup).toContain("identity-list-card");
    expect(initialMarkup).toContain("loading-box");

    route("GET /api/identities/whitelist", (): Response => jsonResponse({
      items: [{
        id: 101, isChannel: false, displayName: "Alice", username: "alice",
        permissions: Object.fromEntries(WHITELIST_PERMISSION_KEYS.map((key: WhitelistPermissionKey): readonly [WhitelistPermissionKey, boolean] => [
          key, key === WHITELIST_PERMISSION_KEYS[0] || key === WHITELIST_PERMISSION_KEYS[2],
        ])) as Record<WhitelistPermissionKey, boolean>,
      }],
      page: 1, pageSize: MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE, total: 1, totalPages: 1, whitelistTotal: 1, blocklistTotal: 0, nextAfterId: null,
    }));
    route("GET /api/identities/blocklist", (): Response => jsonResponse({
      items: [], page: 1, pageSize: MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE, total: 0, totalPages: 1, whitelistTotal: 1, blocklistTotal: 0, nextAfterId: null,
    }));

    await withMountedElement(createElement(IdentitiesPage), async (container, flushMinLoading): Promise<void> => {
      await flushMinLoading();
      expect(collectNodeText(container)).toContain("Alice");

      const blocklistButton: MiniDomNode | null = findButtonByText(container, zh.identities.blocklistTab);
      expect(blocklistButton).not.toBeNull();
      await act(async (): Promise<void> => {
        blocklistButton!.triggerClick();
      });
      await flushMinLoading();
      expect(collectNodeText(container)).toContain(zh.identities.emptyListHint("blocklist"));
    });
  });

  test("StatusPage 覆盖分离四象限骨架、原样能力卡片及失败错误态", async () => {
    const initialStatusMarkup: string = renderToStaticMarkup(createElement(StatusPage));
    expect(initialStatusMarkup).toContain(zh.status.loadingText);
    for (const cls of ["status-overview-card", "stat-quad-mosaic-skeleton"]) expect(initialStatusMarkup).toContain(cls);
    expect(initialStatusMarkup).not.toContain("status-caps-card");

    route("GET /api/mood", (): Response => jsonResponse({ ok: true, available: true, currentMood: "happy" }));
    route("GET /api/status", (): Response => jsonResponse(sampleStatusView()));

    await withMountedElement(createElement(StatusPage), async (container: MiniDomNode, flushMinLoading: () => Promise<void>): Promise<void> => {
      assertQuadMosaicStructure(container, true);
      expect(findElements(container, (node: MiniDomNode): boolean => hasClass(node, "card"))).toHaveLength(2);
      expect(findElements(container, (node: MiniDomNode): boolean => hasClass(node, "status-caps-card"))).toHaveLength(0);
      await flushMinLoading();
      assertQuadMosaicStructure(container, false);
      expect(findElements(container, (node: MiniDomNode): boolean => hasClass(node, "card"))).toHaveLength(2);
      for (const removed of ["status-caps-card", "cap-ready", "cap-warn"]) expect(findElements(container, (node: MiniDomNode): boolean => hasClass(node, removed))).toHaveLength(0);
      const text: string = collectNodeText(container);
      expect(text).toContain(zh.status.capabilitiesSectionTitle);
      expect(text).toContain("happy");
    });

    route("GET /api/status", (): Response => jsonResponse({ error: "status unavailable" }, 500));
    await withMountedElement(createElement(StatusPage), async (container: MiniDomNode, flushMinLoading: () => Promise<void>): Promise<void> => {
      await flushMinLoading();
      expect(collectNodeText(container)).toContain("status unavailable");
    });
  });

  test("StatusOverviewCard 与 StatusSkeleton 覆盖四象限拼块、出站激活态、防溢出胶囊与大数值完整渲染", async () => {
    const defaultStatus: Readonly<MiniAppStatusView> = sampleStatusView();
    const overviewMarkup: string = renderToStaticMarkup(createElement(StatusOverviewCard, { status: defaultStatus, language: "zh", t: zh }));
    const skeletonMarkup: string = renderToStaticMarkup(createElement(StatusSkeleton));
    for (const cls of ["status-overview-card", "stat-quad-mosaic", "stat-quad-q1", "stat-quad-q2", "stat-quad-q3", "stat-quad-q4"]) {
      expect(overviewMarkup).toContain(cls);
      expect(skeletonMarkup).toContain(cls);
    }
    expect(skeletonMarkup).toContain("stat-quad-mosaic-skeleton");
    expect(skeletonMarkup).not.toContain("status-caps-card");

    const largeStatus: Readonly<MiniAppStatusView> = sampleStatusView({
      managedChatCount: 1_116_110, whitelistCount: 128_456, blocklistCount: 987_654,
      activeSessions: { total: 12_345, gag: 1_234, wed: 2_345, verify: 3_456, qaSet: 5_310 },
      telegramOutbound: { inFlight: 2, retryWaiting: 1, retryQueueMax: 10 },
    });
    const chipTexts = (tile: MiniDomNode, grid: boolean): readonly string[] => {
      const wraps: MiniDomNode[] = findElements(tile, (n: MiniDomNode): boolean => hasClass(n, "stat-sub-chips") && (!grid || hasClass(n, "stat-sub-grid")));
      expect(wraps).toHaveLength(1);
      return findElements(wraps[0]!, (n: MiniDomNode): boolean => hasClass(n, "stat-sub-chip")).map((c: MiniDomNode): string => collectNodeText(c));
    };
    for (const sample of [defaultStatus, largeStatus]) {
      await withMountedElement(createElement(StatusOverviewCard, { status: sample, language: "zh", t: zh }), async (container: MiniDomNode): Promise<void> => {
        const tiles: readonly MiniDomNode[] = assertQuadMosaicStructure(container, false);
        [zh.status.uptimeLabel, zh.status.cpuLoadLabel, zh.status.managedChatsLabel, zh.status.activeSessionsLabel]
          .forEach((label: string, idx: number): void => { expect(collectNodeText(tiles[idx]!)).toContain(label); });
        const q3Texts: readonly string[] = chipTexts(tiles[2]!, false);
        expect(q3Texts).toEqual([...zh.status.managedChatsSub(sample.whitelistCount, sample.blocklistCount)]);
        expect(q3Texts[0]).toContain(String(sample.whitelistCount));
        expect(q3Texts[1]).toContain(String(sample.blocklistCount));
        expect(chipTexts(tiles[3]!, true)).toEqual([...zh.status.activeSessionsSub(sample.activeSessions)]);
        const outboundBox: MiniDomNode = findElements(container, (n: MiniDomNode): boolean => hasClass(n, "stat-box-outbound"))[0]!;
        const activeSpans: MiniDomNode[] = findElements(outboundBox, (n: MiniDomNode): boolean => n.tagName === "SPAN" && hasClass(n, "stat-value-active"));
        expect(activeSpans).toHaveLength(sample.telegramOutbound.inFlight > 0 ? 1 : 0);
        if (sample.telegramOutbound.inFlight > 0) expect(collectNodeText(activeSpans[0]!)).toBe(String(sample.telegramOutbound.inFlight));
        expect(collectNodeText(outboundBox)).toContain(zh.status.outboundGateSub(sample.telegramOutbound.retryWaiting, sample.telegramOutbound.retryQueueMax));
        expect(collectNodeText(outboundBox)).not.toContain(`/ ${sample.telegramOutbound.retryQueueMax}`);
      });
    }
    for (const lang of MINI_APP_LANGUAGES) {
      const dict: Readonly<MiniAppTranslations> = getMiniAppTranslations(lang);
      const managedPair: readonly [string, string] = dict.status.managedChatsSub(largeStatus.whitelistCount, largeStatus.blocklistCount);
      const html: string = renderToStaticMarkup(createElement(StatusOverviewCard, { status: largeStatus, language: lang, t: dict }));
      expect(managedPair).toHaveLength(2);
      for (const chipText of managedPair) expect(html).toContain(chipText);
      expect(html).toContain(`<span class="stat-value-active">${largeStatus.telegramOutbound.inFlight}</span>`);
      expect(html).not.toContain("...");
    }

    await withMountedElement(createElement(StatusSkeleton), async (container: MiniDomNode): Promise<void> => {
      assertQuadMosaicStructure(container, true);
      expect(findElements(container, (node: MiniDomNode): boolean => hasClass(node, "card"))).toHaveLength(2);
      expect(findElements(container, (node: MiniDomNode): boolean => hasClass(node, "status-caps-card"))).toHaveLength(0);
      expect(findElements(container, (node: MiniDomNode): boolean => hasClass(node, "skeleton-cap-row"))).toHaveLength(MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES.length);
    });
  });

  test("CapabilityBlock 保持原样 .cap-block 类名而不附加 cap-ready/cap-warn", async () => {
    const followScrollSlotRef: React.RefObject<ViewportAnchorScroll | null> = { current: null };
    const readyCap: Readonly<MiniAppCapabilityStatus> = { key: "aiChat", label: "AI Chat", ready: true, detail: "ready", items: [{ label: "Model", value: "gemini" }] };
    const warnCap: Readonly<MiniAppCapabilityStatus> = { key: "antiRaid", label: "Anti Raid", ready: false, detail: "missing", items: [] };
    const cases: readonly (readonly [Readonly<MiniAppCapabilityStatus>, boolean])[] = [[readyCap, false], [readyCap, true], [warnCap, false], [warnCap, true]];

    await withMountedElement(
      createElement("div", null, cases.map(([capability, isExpanded]: readonly [Readonly<MiniAppCapabilityStatus>, boolean], idx: number): React.JSX.Element =>
        createElement(CapabilityBlock, { key: `${capability.key}-${idx}`, capability, t: zh, isExpanded, onToggleCapability: (): void => {}, currentMood: null, switchingMood: false, onSwitchMood: (): void => {}, followScrollSlotRef })
      )),
      async (container: MiniDomNode): Promise<void> => {
        const blocks: MiniDomNode[] = findElements(container, (node: MiniDomNode): boolean => hasClass(node, "cap-block"));
        expect(blocks).toHaveLength(cases.length);
        cases.forEach(([capability, isExpanded]: readonly [Readonly<MiniAppCapabilityStatus>, boolean], index: number): void => {
          const block: MiniDomNode = blocks[index]!;
          expect(hasClass(block, "cap-ready")).toBeFalse();
          expect(hasClass(block, "cap-warn")).toBeFalse();
          expect(hasClass(block, "expanded")).toBe(isExpanded);
          expect(collectNodeText(block)).toContain(capability.ready ? zh.status.capabilityReadyBadge : zh.status.capabilityMissingBadge);
          expect(findElements(block, (node: MiniDomNode): boolean => hasClass(node, "cap-status-dot") && hasClass(node, capability.ready ? "ok" : "warn"))).toHaveLength(1);
        });
      }
    );
  });

  test("status.css、overlays.css 与 identities.css 定义分离四象限拼块、中性底粉脊出站/内存卡、防溢出胶囊、主题色板、原样能力区、顶部 Toast 与权限胶囊选中态", async () => {
    const expectContainsAll = (text: string, expected: readonly string[]): void => { for (const item of expected) expect(text).toContain(item); };
    const strippedStatusCss: string = await readStrippedCss("packages/mini-app-frontend/styles/status.css");
    for (const removed of ["status-caps-card", "cap-ready", "cap-warn", "--cap-c1", "--cap-c6", "--stat-mosaic-seam", "--mem-rss-bg", "--mem-heap-bg", "minmax(0, 1fr) 18px minmax(0, 1fr)", "auto 16px auto", "minmax(0, 1fr) 22px minmax(0, 1fr)", "auto 20px auto", "minmax(0, 1fr) 34px minmax(0, 1fr)", "auto 30px auto", ".card-title::before", "--stat-outbound-bg", "--stat-outbound-hover-bg", "--stat-outbound-track-stripe", "--stat-memory-bg", "--stat-memory-hover-bg", "--stat-memory-stripe", "--mem-peak-bg", "--mem-peak-shadow", "--mem-track-stripe"]) expect(strippedStatusCss).not.toContain(removed);

    const cssRules: readonly (readonly [RegExp, readonly string[]])[] = [
      [/(?:^|\n)\.stat-quad-mosaic\s*\{/u, ["grid-column: 1 / -1;", "display: grid;", `grid-template-columns: minmax(0, 1fr) ${STATUS_QUAD_OVERLAP_X_PX}px minmax(0, 1fr);`, `grid-template-rows: minmax(104px, auto) ${STATUS_QUAD_OVERLAP_Y_PX}px minmax(104px, auto);`, "background: transparent;", "border: none;", "overflow: visible;"]],
      [/(?:^|\n)\.stat-quad-mosaic\s*>\s*\.stat-box\.stat-quad-tile\s*\{/u, ["position: relative;", "isolation: isolate;", "background: transparent;", "border: none;", "drop-shadow(3px 3px 0 var(--stat-quad-shadow))"]],
      [/(?:^|\n)\.stat-quad-mosaic\s*>\s*\.stat-box\.stat-quad-tile::before\s*\{/u, ["clip-path: var(--stat-quad-clip);", "background: var(--stat-quad-border);"]],
      [/(?:^|\n)\.stat-quad-mosaic\s*>\s*\.stat-box\.stat-quad-tile::after\s*\{/u, ["inset: var(--border-w);", "clip-path: var(--stat-quad-clip);", "background: var(--stat-quad-fill);"]],
      [/(?:^|\n)\.stat-sub-chips\s*\{/u, ["display: flex;", "flex-wrap: wrap;", "min-width: 0;"]],
      [/(?:^|\n)\.stat-sub-chip\s*\{/u, ["flex-wrap: wrap;", "max-width: 100%;", "min-width: 0;", "white-space: normal;", "overflow-wrap: anywhere;", "word-break: break-word;"]],
      [/(?:^|\n)\.stat-box\.stat-box-outbound\s*\{/u, ["grid-column: 1 / -1;", "border: var(--border-w-sm) solid var(--border);", "border-left: 5px solid var(--stat-outbound-spine);"]],
      [/(?:^|\n)\.stat-value-active\s*\{/u, ["color: var(--accent);"]],
      [/(?:^|\n)\.stat-box-outbound\s+\.stat-value-active\s*\{/u, ["color: var(--accent);"]],
      [/(?:^|\n)\[data-theme="dark"\]\s+\.stat-box-outbound\s+\.stat-value-active\s*\{/u, ["color: var(--accent-light);"]],
      [/(?:^|\n)\.cpu-ring-fill\s*\{/u, ["stroke: var(--accent);"]], [/(?:^|\n)\.cpu-ring-fill\.high\s*\{/u, ["stroke: var(--danger);"]],
      [/(?:^|\n)\.stat-bar-fill\s*\{/u, ["background: var(--accent);"]], [/(?:^|\n)\.memory-seg-proc\s*\{/u, ["background: var(--accent);"]],
      [/(?:^|\n)\.memory-metric-card:nth-child\(1\),\s*\.memory-metric-card:nth-child\(3\)\s*\{/u, ["border-left: 3px solid var(--accent-light);"]],
      [/(?:^|\n)\.memory-metric-card:nth-child\(2\),\s*\.memory-metric-card\.peak\s*\{/u, ["border-color: var(--accent-border);", "border-left: 3px solid var(--accent);", "box-shadow: 2px 2px 0 var(--accent);"]],
      [/(?:^|\n)\.memory-metric-card\.peak\s+\.memory-metric-label\s*\{/u, ["color: var(--accent);"]], [/(?:^|\n)\.memory-metric-card\.peak\s+\.memory-metric-value\s*\{/u, ["color: var(--accent);"]],
      [/(?:^|\n)\[data-theme="dark"\]\s+\.memory-metric-card\.peak\s+\.memory-metric-label\s*\{/u, ["color: #ff9ec0;"]], [/(?:^|\n)\[data-theme="dark"\]\s+\.memory-metric-card\.peak\s+\.memory-metric-value\s*\{/u, ["color: #ffd1e2;"]],
      [/(?:^|\n)\.memory-legend-item\s*\{/u, ["border: var(--border-w-sm) solid var(--border);"]],
    ];
    for (const [pattern, decls] of cssRules) expectContainsAll(extractCssBlockBody(strippedStatusCss, pattern), decls);
    const hoverMediaCss: string = Array.from(strippedStatusCss.matchAll(/(?:^|\n)@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{/gu), (m: RegExpExecArray): string => extractCssBlockBody(strippedStatusCss.slice(m.index), /^[\s\S]*?\{/u)).join("\n");
    for (const [pattern, decls] of [
      [/(?:^|\n)\s*\.stat-quad-mosaic:not\(\.stat-quad-mosaic-skeleton\)\s*>\s*\.stat-box\.stat-quad-tile:hover\s*\{/u, ["--stat-quad-border: var(--border-strong);", "drop-shadow(4px 4px 0 var(--stat-quad-shadow))"]],
      [/(?:^|\n)\s*\.stat-quad-mosaic:not\(\.stat-quad-mosaic-skeleton\)\s*>\s*\.stat-box\.stat-quad-tile:hover::after\s*\{/u, ["background: var(--stat-quad-hover-fill);"]],
    ] as const) expectContainsAll(extractCssBlockBody(hoverMediaCss, pattern), decls);
    expect(strippedStatusCss.match(/\.stat-quad-mosaic:not\(\.stat-quad-mosaic-skeleton\)\s*>\s*\.stat-box\.stat-quad-tile:hover\s*\{/gu)).toHaveLength(1);
    for (const [kind, spine, extra] of [["outbound", "--stat-outbound-spine", []], ["memory", "--stat-memory-spine", ["var(--memory-total)", "var(--memory-other)", "border-top"]]] as const) {
      for (const [header, decl] of [
        [new RegExp(`(?:^|\\n)\\.stat-box\\.stat-box-${kind}\\s*\\{`, "u"), `border-left: 5px solid var(${spine});`],
        [new RegExp(`(?:^|\\n)\\[data-theme="dark"\\]\\s+\\.stat-box\\.stat-box-${kind}\\s*\\{`, "u"), `border-left: 5px solid var(${spine});`],
        [new RegExp(`\\n\\s*\\.stat-box\\.stat-box-${kind}:hover\\s*\\{`, "u"), `border-left-color: var(${spine});`],
        [new RegExp(`\\n\\s*\\[data-theme="dark"\\]\\s+\\.stat-box\\.stat-box-${kind}:hover\\s*\\{`, "u"), `border-left-color: var(${spine});`],
      ] as const) {
        const boxBody: string = extractCssBlockBody(strippedStatusCss, header);
        expectContainsAll(boxBody, decl.startsWith("border-left:") ? ["border: var(--border-w-sm) solid var(--border);", decl] : [decl]);
        for (const forbidden of ["background", "background-color", "repeating-linear-gradient", ...extra]) expect(boxBody).not.toContain(forbidden);
      }
    }
    for (const [trackHeader, expectedBg] of [[/(?:^|\n)\.stat-bar-track\s*\{/u, "background: var(--card);"], [/(?:^|\n)\.memory-bar-track\s*\{/u, "background: var(--card);"], [/(?:^|\n)\[data-theme="dark"\]\s+\.memory-bar-track,\s*\[data-theme="dark"\]\s+\.stat-bar-track\s*\{/u, "background: var(--input-bg);"]] as const) {
      const trackBody: string = extractCssBlockBody(strippedStatusCss, trackHeader);
      expect(trackBody).toContain(expectedBg);
      expect(trackBody).not.toContain("repeating-linear-gradient");
    }
    const peakBody: string = extractCssBlockBody(strippedStatusCss, /(?:^|\n)\.memory-metric-card:nth-child\(2\),\s*\.memory-metric-card\.peak\s*\{/u);
    for (const forbidden of ["background", "--mem-peak-bg", "--mem-peak-shadow"]) expect(peakBody).not.toContain(forbidden);
    expect(extractCssBlockBody(strippedStatusCss, /(?:^|\n)\.memory-legend-item\s*\{/u)).not.toContain("border-left");
    const subChipBody: string = extractCssBlockBody(strippedStatusCss, /(?:^|\n)\.stat-sub-chip\s*\{/u);
    for (const forbidden of ["text-overflow: ellipsis", "overflow: hidden", "white-space: nowrap"]) expect(subChipBody).not.toContain(forbidden);
    expect(strippedStatusCss).not.toMatch(/@media\s*\(min-width:\s*720px\)[\s\S]*?\.stat-box-outbound/u);

    const mobile360Body: string = extractCssBlockBody(strippedStatusCss, /(?:^|\n)@media\s*\(max-width:\s*360px\)\s*\{/u);
    expectContainsAll(mobile360Body, [".stat-quad-mosaic > .stat-quad-tile.stat-quad-q1", ".skeleton-line.skeleton-cpu-ring", "width: 40px;", "height: 40px;"]);
    expect(mobile360Body).not.toMatch(/\.stat-quad-mosaic\s*\{[^}]*grid-template-columns\s*:\s*1fr/u);

    const quadContracts: readonly { readonly id: "q1" | "q2" | "q3" | "q4"; readonly col: string; readonly row: string }[] = [
      { id: "q1", col: "1 / 3", row: "1 / 3" }, { id: "q2", col: "2 / 4", row: "1 / 3" },
      { id: "q3", col: "1 / 3", row: "2 / 4" }, { id: "q4", col: "2 / 4", row: "2 / 4" },
    ];
    for (const quad of quadContracts) {
      const ruleBody: string = extractCssBlockBody(strippedStatusCss, new RegExp(`(?:^|\\n)\\.stat-quad-mosaic\\s*>\\s*\\.stat-quad-tile\\.stat-quad-${quad.id}\\s*\\{`, "u"));
      expectContainsAll(ruleBody, [`grid-column: ${quad.col};`, `grid-row: ${quad.row};`, `--stat-quad-fill: var(--stat-${quad.id}-bg);`, `--stat-quad-hover-fill: var(--stat-${quad.id}-hover-bg);`]);
      const polygonMatch: RegExpExecArray | null = /--stat-quad-clip:\s*polygon\(([^;]+)\);/u.exec(ruleBody);
      expect(polygonMatch).not.toBeNull();
      expect(polygonMatch![1]!.split(",").length).toBeGreaterThanOrEqual(6);
      const skelBody: string = extractCssBlockBody(strippedStatusCss, new RegExp(`(?:^|\\n)\\.stat-quad-mosaic\\.stat-quad-mosaic-skeleton\\s*>\\s*\\.stat-quad-tile\\.stat-quad-${quad.id}\\s*\\{`, "u"));
      expectContainsAll(skelBody, [`--stat-quad-fill: var(--stat-${quad.id}-skel-bg);`, `--stat-quad-hover-fill: var(--stat-${quad.id}-skel-bg);`]);
    }

    const lightVars: ReadonlyMap<string, string> = parseCssVariables(extractCssBlockBody(strippedStatusCss, /(?:^|\n):root,\s*\[data-theme="light"\]\s*\{/u));
    const darkVars: ReadonlyMap<string, string> = parseCssVariables(extractCssBlockBody(strippedStatusCss, /(?:^|\n)\[data-theme="dark"\]\s*\{/u));
    const requiredTokens: readonly string[] = [
      "--stat-quad-border", "--stat-quad-shadow", "--stat-outbound-spine", "--stat-memory-spine", "--stat-chip-bg", "--stat-chip-border", "--stat-chip-ink", "--stat-chip-shadow",
      ...quadContracts.flatMap((q: { readonly id: string }): readonly string[] => [`--stat-${q.id}-bg`, `--stat-${q.id}-hover-bg`, `--stat-${q.id}-skel-bg`]),
    ];
    const sharedTokens: ReadonlySet<string> = new Set<string>(["--stat-quad-border", "--stat-quad-shadow", "--stat-chip-ink", "--stat-outbound-spine", "--stat-memory-spine"]);
    for (const token of requiredTokens) {
      expect(lightVars.has(token) && darkVars.has(token)).toBeTrue();
      if (!sharedTokens.has(token)) expect(lightVars.get(token)).not.toBe(darkVars.get(token));
    }
    for (const [token, expectedValue] of [["--stat-quad-border", "var(--border)"], ["--stat-quad-shadow", "var(--shadow-ink)"], ["--stat-outbound-spine", "var(--accent)"], ["--stat-memory-spine", "var(--accent)"]] as const) expect([lightVars.get(token), darkVars.get(token)]).toEqual([expectedValue, expectedValue]);

    const capSection: string = strippedStatusCss.slice(strippedStatusCss.indexOf(".cap-list {"));
    expect(capSection.length).toBeGreaterThan(0);
    expect(capSection).not.toContain("--stat-");
    const capRules: readonly (readonly [RegExp, readonly string[]])[] = [
      [/(?:^|\n)\.cap-block\s*\{/u, ["box-shadow: var(--shadow-xs);"]], [/(?:^|\n)\.cap-header-btn\s*\{/u, ["var(--dropdown-board-bg)"]],
      [/(?:^|\n)\.cap-item\s*\{/u, ["background: var(--dropdown-item-bg);", "border-left: 4px solid var(--accent);"]], [/(?:^|\n)\.cap-tag\s*\{/u, ["background: var(--accent-soft);"]],
    ];
    for (const [pattern, decls] of capRules) expectContainsAll(extractCssBlockBody(capSection, pattern), decls);

    const strippedOverlaysCss: string = await readStrippedCss("packages/mini-app-frontend/styles/overlays.css");
    const toastBody: string = extractCssBlockBody(strippedOverlaysCss, /(?:^|\n)\.toast\s*\{/u);
    expect(toastBody).toMatch(/\btop:\s*calc\(/u);
    expectContainsAll(toastBody, ["--tg-safe-area-inset-top", "--tg-content-safe-area-inset-top"]);
    expect(toastBody).not.toMatch(/\bbottom\s*:/u);
    expectContainsAll(extractCssBlockBody(strippedOverlaysCss, /(?:^|\n)@keyframes\s+miniapp-toast-in\s*\{/u), ["translate3d(0, -14px, 0)", "translate(0, 0)"]);
    expectContainsAll(extractCssBlockBody(strippedOverlaysCss, /(?:^|\n)@keyframes\s+miniapp-toast-out\s*\{/u), ["translate3d(0, 0, 0)", "translate3d(0, -14px, 0)"]);

    const strippedIdentitiesCss: string = await readStrippedCss("packages/mini-app-frontend/styles/identities.css");
    const checkedPermChipBody: string = extractCssBlockBody(strippedIdentitiesCss, /(?:^|\n)\.perm-chip:has\(input:checked\)\s*\{/u);
    expectContainsAll(checkedPermChipBody, ["background: #fff3f7;", "border-color: var(--accent-border);", "box-shadow: 2px 2px 0 var(--accent);"]);
    expect(checkedPermChipBody).not.toContain("var(--accent-soft)");
    const darkCheckedPermChipBody: string = extractCssBlockBody(strippedIdentitiesCss, /(?:^|\n)\[data-theme="dark"\]\s+\.perm-chip:has\(input:checked\)\s*\{/u);
    expectContainsAll(darkCheckedPermChipBody, ["background: #312135;", "border-color: var(--accent);", "color: #fff5f8;", "box-shadow: 2px 2px 0 var(--accent);"]);
    expect(darkCheckedPermChipBody).not.toContain("#3d1a2e");
  });

  test("MessagesView 覆盖引用转发、空媒体占位及空消息提示", async () => {
    const skeletonMarkup: string = renderToStaticMarkup(createElement(MessagesView, { chatId: -1001, onBack: (): void => {} }));
    expect(skeletonMarkup).toContain(zh.messages.headerMeta(-1001));
    expect(skeletonMarkup).toContain(String(MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE));

    route("GET /api/chats/messages", (url: URL): Response => {
      expect(url.searchParams.get("chatId")).toBe("-1001");
      return jsonResponse({
        chatId: -1001,
        title: "Doro群",
        total: 2,
        maxCapacity: VERBATIM_CONTEXT_MAX,
        page: 1,
        pageSize: MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
        totalPages: 1,
        items: [
          {
            index: 0,
            userId: 7,
            name: "  doro ",
            username: "doro_bot",
            text: "hello",
            at: "2026/01/01 12:00:00",
            messageId: 11,
            forwardedFrom: "NewsChannel",
            replyToMessageId: 10,
            replyToName: "Alice",
            replyToPreview: "prev text",
          },
          {
            index: 1,
            userId: 8,
            name: "   ",
            text: "",
            at: "2026/01/01 12:01:00",
            messageId: 12,
          },
        ],
      });
    });

    await withMountedElement(
      createElement(MessagesView, { chatId: -1001, onBack: (): void => {} }),
      async (container, flushMinLoading): Promise<void> => {
        await flushMinLoading();
        const text: string = collectNodeText(container);
        expect(text).toContain("Ddoro@doro_bot");
        expect(text).toContain("NewsChannel");
        expect(text).toContain("prev text");
        expect(text).toContain(zh.messages.emptyMediaPlaceholder);
      }
    );

    route("GET /api/chats/messages", (url: URL): Response => {
      expect(url.searchParams.get("chatId")).toBe("-1001");
      return jsonResponse({
        chatId: -1001,
        title: "Empty群",
        total: 0,
        maxCapacity: VERBATIM_CONTEXT_MAX,
        page: 1,
        pageSize: MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
        totalPages: 1,
        items: [],
      });
    });

    await withMountedElement(
      createElement(MessagesView, { chatId: -1001, onBack: (): void => {} }),
      async (container, flushMinLoading): Promise<void> => {
        await flushMinLoading();
        expect(collectNodeText(container)).toContain(zh.messages.emptyHint);
      }
    );
  });

  test("ChatJoinCleanCard 覆盖边界小时禁用、运行徽章与最近完成汇总", () => {
    const store: MiniAppChatsStore = createChatsStore();
    const snapshotStore: MiniAppChatsStore = {
      ...store,
      getInitialState: (): MiniAppChatsStoreState => store.getState(),
    };
    store.setState({ batchKickHours: MINI_APP_BATCH_KICK_MIN_HOURS, loadingWindowJoined: false });
    const idleHtml: string = renderToStaticMarkup(createElement(ChatJoinCleanCard, {
      chatDetail: sampleChatDetail({
        lastBatchKickCompletion: {
          hours: MINI_APP_BATCH_KICK_MIN_HOURS,
          recordCount: 10,
          scanned: 8,
          kicked: 6,
          absent: 1,
          protected: 1,
          blocked: 0,
          forbidden: 0,
          failed: 0,
          aborted: false,
          unmanaged: false,
          completedAt: 1_700_000_000_000,
        },
      }),
      store: snapshotStore,
    }));
    expect(idleHtml).toContain(zh.chats.batchKickTriggerButton(MINI_APP_BATCH_KICK_MIN_HOURS));
    expect(idleHtml).toContain(zh.chats.windowJoinedValue(5));
    expect(idleHtml).toContain("join-clean-result-box");
    expect(idleHtml).toContain(`${MINI_APP_BATCH_KICK_PRESET_HOURS[0]}h`);

    store.setState({ batchKickHours: MINI_APP_BATCH_KICK_MAX_HOURS, loadingWindowJoined: true });
    const runningHtml: string = renderToStaticMarkup(createElement(ChatJoinCleanCard, {
      chatDetail: sampleChatDetail({ batchKickRunning: true }),
      store: snapshotStore,
    }));
    expect(runningHtml).toContain(zh.chats.batchKickRunningBadge);
    expect(runningHtml).toContain(zh.chats.batchKickRunningButton);
    expect(runningHtml).toContain('aria-busy="true"');
  });

  test("ChatTargetsMemberPanels 与 ChatTargetsMemberAddForm 覆盖加载、空态、列表与前置权限警告", () => {
    const store: MiniAppChatsStore = createChatsStore();
    const loadingHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "deleteMessage",
      chatDetail: sampleChatDetail(),
      state: store.getState(),
      t: zh,
    }));
    expect(loadingHtml).toContain("chat-targets-member-panel");

    const targets: MiniAppChatTargetsView = {
      chatId: -1001,
      qaItems: [],
      qaMax: CHAT_QA_MAX_PER_CHAT,
      qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
      qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
      deleteMessageTargets: [{ id: -10099, isChannel: true, displayName: "SpamCh", username: "spam_ch" }],
      deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
      translateTargets: [{ id: 505, isChannel: false, displayName: "Bob", language: MINI_APP_TRANSLATE_LANGUAGES[0]! }],
      translateMax: TRANSLATE_CHAT_USER_LIMIT,
      isTranslationEnabled: false,
    };
    store.setState({
      loadingTargets: false,
      chatTargets: targets,
      targetAddMenuOpen: true,
      targetIdFormOpen: true,
      translateLangMenuOpen: true,
      translateTargetInput: "505",
    });

    const deleteWarnHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "deleteMessage",
      chatDetail: sampleChatDetail({
        botPermissions: { canDeleteMessages: false, canRestrictMembers: true, canChangeInfo: false, grantedLabels: [] },
      }),
      state: store.getState(),
      t: zh,
    }));
    expect(deleteWarnHtml).toContain(zh.serverNotice("DELETE_TARGET_MISSING_BOT_PERMISSION"));
    expect(deleteWarnHtml).toContain("SpamCh");
    expect(deleteWarnHtml).toContain(zh.identities.channelBadge);

    const translateWarnHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "translate",
      chatDetail: sampleChatDetail({ features: { ...sampleChatDetail().features, translation: false } }),
      state: store.getState(),
      t: zh,
    }));
    expect(translateWarnHtml).toContain(zh.serverNotice("TRANSLATE_FEATURE_DISABLED"));
    expect(translateWarnHtml).toContain("Bob");

    store.setState({ chatTargets: { ...targets, deleteMessageTargets: [], translateTargets: [] } });
    expect(renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "deleteMessage",
      chatDetail: sampleChatDetail(),
      state: store.getState(),
      t: zh,
    }))).toContain(zh.chats.deleteTargetEmptyHint);
    expect(renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "translate",
      chatDetail: sampleChatDetail(),
      state: store.getState(),
      t: zh,
    }))).toContain(zh.chats.translateTargetEmptyHint);

    const translateFormHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberAddForm, {
      kind: "translate",
      state: store.getState(),
      t: zh,
    }));
    expect(translateFormHtml).toContain('role="listbox"');
    expect(translateFormHtml).toContain(MINI_APP_TRANSLATE_LANGUAGES[0]!.toUpperCase());

    const deleteFormHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberAddForm, {
      kind: "deleteMessage",
      state: store.getState(),
      t: zh,
    }));
    expect(deleteFormHtml).toContain(zh.chats.deleteTargetAddButton);
  });

  test("IdentitiesPage 与 ChatTargetsModal 点击按联系人/按频道准备选择器期间，全部模式按钮禁用且仅被点击项播放三点加载动画", async () => {
    const drainAsync = async (): Promise<void> => {
      await act(async (): Promise<void> => {
        for (let tick: number = 0; tick < 8; tick += 1) {
          Bun.sleepSync(2);
          await new Promise<void>((resolve: () => void): void => {
            setImmediate(resolve);
          });
        }
      });
    };

    const assertPickerCardsIdle = (container: MiniDomNode): void => {
      const cards: MiniDomNode[] = findElements(
        container,
        (element: MiniDomNode): boolean => element.tagName === "BUTTON" && hasClass(element, "add-mode-card")
      );
      expect(cards).toHaveLength(3);
      for (const card of cards) {
        expect(card.getAttribute("disabled")).toBeNull();
        expect(hasClass(card, "is-loading")).toBeFalse();
        expect(card.getAttribute("aria-busy")).toBeNull();
        expect(findElements(card, (el: MiniDomNode): boolean => hasClass(el, "loading-dot-block"))).toHaveLength(0);
      }
    };

    const assertPickerCardLoading = (
      container: MiniDomNode,
      expectedButtonText: string
    ): void => {
      const cards: MiniDomNode[] = findElements(
        container,
        (element: MiniDomNode): boolean => element.tagName === "BUTTON" && hasClass(element, "add-mode-card")
      );
      expect(cards).toHaveLength(3);
      let loadingCount: number = 0;
      for (const card of cards) {
        expect(card.getAttribute("disabled")).not.toBeNull();
        const isExpected: boolean = collectNodeText(card).includes(expectedButtonText);
        if (isExpected) {
          loadingCount += 1;
          expect(hasClass(card, "is-loading")).toBeTrue();
          expect(card.getAttribute("aria-busy")).toBe("true");
          expect(findElements(card, (el: MiniDomNode): boolean => hasClass(el, "add-mode-loading-overlay"))).toHaveLength(1);
          expect(findElements(card, (el: MiniDomNode): boolean => hasClass(el, "loading-dot-block"))).toHaveLength(3);
        } else {
          expect(hasClass(card, "is-loading")).toBeFalse();
          expect(card.getAttribute("aria-busy")).toBeNull();
          expect(findElements(card, (el: MiniDomNode): boolean => hasClass(el, "loading-dot-block"))).toHaveLength(0);
        }
      }
      expect(loadingCount).toBe(1);
    };

    const requestedPreparedIds: string[] = [];
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: {
        requestChat: (preparedButtonId: string, _callback: (accepted: boolean) => void): void => {
          requestedPreparedIds.push(preparedButtonId);
        },
      },
    };

    route("GET /api/identities/whitelist", (): Response =>
      jsonResponse({
        items: [],
        page: 1,
        pageSize: MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
        total: 0,
        totalPages: 1,
        whitelistTotal: 0,
        blocklistTotal: 0,
        nextAfterId: null,
      })
    );

    await withMountedElement(createElement(IdentitiesPage), async (container, flushMinLoading): Promise<void> => {
      await flushMinLoading();
      const foldTrigger: MiniDomNode | null = findButtonByText(container, zh.identities.addFoldButton);
      expect(foldTrigger).not.toBeNull();
      await act(async (): Promise<void> => {
        foldTrigger!.triggerClick();
      });
      assertPickerCardsIdle(container);

      const usersGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      route("POST /api/picker/prepare", async (): Promise<Response> => {
        await usersGate.promise;
        return jsonResponse({ ok: true, requestId: 101, preparedButtonId: "btn-id-users" });
      });

      const usersBtn: MiniDomNode | null = findButtonByText(container, zh.identities.addModes.users);
      expect(usersBtn).not.toBeNull();
      await act(async (): Promise<void> => {
        usersBtn!.triggerClick();
      });
      assertPickerCardLoading(container, zh.identities.addModes.users);

      usersGate.resolve();
      await drainAsync();
      expect(requestedPreparedIds).toEqual(["btn-id-users"]);
      expect(foldTrigger!.getAttribute("disabled")).toBeNull();

      await act(async (): Promise<void> => {
        foldTrigger!.triggerClick();
      });
      assertPickerCardsIdle(container);

      const channelGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      route("POST /api/picker/prepare", async (): Promise<Response> => {
        await channelGate.promise;
        return jsonResponse({ error: "prepare failed" }, 500);
      });

      const channelBtn: MiniDomNode | null = findButtonByText(container, zh.identities.addModes.channel);
      expect(channelBtn).not.toBeNull();
      await act(async (): Promise<void> => {
        channelBtn!.triggerClick();
      });
      assertPickerCardLoading(container, zh.identities.addModes.channel);

      channelGate.resolve();
      await drainAsync();
      assertPickerCardsIdle(container);
    });

    const chatsStore: MiniAppChatsStore = createChatsStore();
    const targets: MiniAppChatTargetsView = {
      chatId: -1001,
      qaItems: [],
      qaMax: CHAT_QA_MAX_PER_CHAT,
      qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
      qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
      deleteMessageTargets: [],
      deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
      translateTargets: [],
      translateMax: TRANSLATE_CHAT_USER_LIMIT,
      isTranslationEnabled: true,
    };
    chatsStore.setState({
      selectedChatId: -1001,
      chatDetail: sampleChatDetail(),
      chatTargets: targets,
      loadingTargets: false,
      activeTargetsModal: "deleteMessage",
      targetAddMenuOpen: true,
    });

    await withMountedElement(
      createElement(ChatTargetsModal, { store: chatsStore }),
      async (container): Promise<void> => {
        assertPickerCardsIdle(container);

        const chatUsersGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
        route("POST /api/picker/prepare", async (): Promise<Response> => {
          await chatUsersGate.promise;
          return jsonResponse({ ok: true, requestId: 201, preparedButtonId: "btn-chat-users" });
        });

        const chatUsersBtn: MiniDomNode | null = findButtonByText(container, zh.identities.addModes.users);
        expect(chatUsersBtn).not.toBeNull();
        await act(async (): Promise<void> => {
          chatUsersBtn!.triggerClick();
        });
        assertPickerCardLoading(container, zh.identities.addModes.users);

        chatUsersGate.resolve();
        await drainAsync();
        expect(requestedPreparedIds).toEqual(["btn-id-users", "btn-chat-users"]);
        expect(chatsStore.getState().preparingPickerMode).toBeNull();
        expect(chatsStore.getState().mutatingTargets).toBeFalse();

        const reopenDeleteMenuBtn: MiniDomNode | null = findButtonByText(container, zh.chats.deleteTargetAddButton);
        expect(reopenDeleteMenuBtn).not.toBeNull();
        await act(async (): Promise<void> => {
          reopenDeleteMenuBtn!.triggerClick();
        });
        assertPickerCardsIdle(container);

        await act(async (): Promise<void> => {
          chatsStore.getState().switchTargetsModalTab("translate");
        });
        const openTranslateMenuBtn: MiniDomNode | null = findButtonByText(container, zh.chats.translateTargetAddButton);
        expect(openTranslateMenuBtn).not.toBeNull();
        await act(async (): Promise<void> => {
          openTranslateMenuBtn!.triggerClick();
        });
        assertPickerCardsIdle(container);

        const chatChannelGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
        route("POST /api/picker/prepare", async (): Promise<Response> => {
          await chatChannelGate.promise;
          return jsonResponse({ ok: true, requestId: 202, preparedButtonId: "btn-chat-channel" });
        });

        const chatChannelBtn: MiniDomNode | null = findButtonByText(container, zh.identities.addModes.channel);
        expect(chatChannelBtn).not.toBeNull();
        await act(async (): Promise<void> => {
          chatChannelBtn!.triggerClick();
        });
        assertPickerCardLoading(container, zh.identities.addModes.channel);

        chatChannelGate.resolve();
        await drainAsync();
        expect(requestedPreparedIds).toEqual(["btn-id-users", "btn-chat-users", "btn-chat-channel"]);
        expect(chatsStore.getState().preparingPickerMode).toBeNull();
        expect(chatsStore.getState().mutatingTargets).toBeFalse();

        await act(async (): Promise<void> => {
          openTranslateMenuBtn!.triggerClick();
        });
        assertPickerCardsIdle(container);
      }
    );
  });

  test("submitDeleteTarget 与 submitTranslateTarget 仅放行正整数用户 ID 与 -100... 频道 ID，拒绝用户名与非法数字输入", async () => {
    expect(isValidChatTargetNumericInput("7001")).toBeTrue();
    expect(isValidChatTargetNumericInput("-1009400099")).toBeTrue();
    expect(isValidChatTargetNumericInput("-1001")).toBeTrue();
    expect(isValidChatTargetNumericInput("9007199254740991")).toBeTrue();
    expect(isValidChatTargetNumericInput("9007199254740992")).toBeFalse();
    expect(isValidChatTargetNumericInput("@username")).toBeFalse();
    expect(isValidChatTargetNumericInput("bare_user")).toBeFalse();
    expect(isValidChatTargetNumericInput("-500")).toBeFalse();
    expect(isValidChatTargetNumericInput("-100")).toBeFalse();
    expect(isValidChatTargetNumericInput("-1000")).toBeFalse();
    expect(isValidChatTargetNumericInput("-10005")).toBeFalse();
    expect(isValidChatTargetNumericInput("0123")).toBeFalse();
    expect(isValidChatTargetNumericInput("0")).toBeFalse();
    expect(isValidChatTargetNumericInput("-0")).toBeFalse();

    const store: MiniAppChatsStore = createChatsStore();
    const sentPayloads: { readonly action: string; readonly target?: string; readonly language?: string }[] = [];
    route("POST /api/chats/targets", (_url: URL, init?: RequestInit): Response => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        readonly action: string;
        readonly target?: string;
        readonly language?: string;
      };
      sentPayloads.push(body);
      return jsonResponse({
        ok: true,
        message: body.action === "addDeleteTarget" ? "DELETE_TARGET_ADDED" : "TRANSLATE_TARGET_ADDED",
        detail: sampleChatDetail(),
        targets: {
          chatId: -1001,
          qaItems: [],
          qaMax: CHAT_QA_MAX_PER_CHAT,
          qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
          qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
          deleteMessageTargets: [],
          deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
          translateTargets: [],
          translateMax: TRANSLATE_CHAT_USER_LIMIT,
          isTranslationEnabled: true,
        },
      });
    });

    store.setState({ selectedChatId: -1001, chatDetail: sampleChatDetail() });

    for (const emptyInput of ["", "   "]) {
      useMiniAppStore.getState().clearToast();
      store.getState().setDeleteTargetInput(emptyInput);
      await store.getState().submitDeleteTarget();
      expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("TARGET_REQUIRED"));
      expect(useMiniAppStore.getState().toastTone).toBe("warning");

      useMiniAppStore.getState().clearToast();
      store.getState().setTranslateTargetInput(emptyInput);
      await store.getState().submitTranslateTarget();
      expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("TARGET_REQUIRED"));
      expect(useMiniAppStore.getState().toastTone).toBe("warning");
    }

    const invalidInputs: readonly string[] = [
      "@username",
      "bare_user",
      "-500",
      "-100",
      "-1000",
      "-1000123",
      "0123",
    ];
    for (const invalidInput of invalidInputs) {
      useMiniAppStore.getState().clearToast();
      store.getState().setDeleteTargetInput(invalidInput);
      await store.getState().submitDeleteTarget();
      expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("TARGET_INVALID"));
      expect(useMiniAppStore.getState().toastTone).toBe("warning");

      useMiniAppStore.getState().clearToast();
      store.getState().setTranslateTargetInput(invalidInput);
      await store.getState().submitTranslateTarget();
      expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("TARGET_INVALID"));
      expect(useMiniAppStore.getState().toastTone).toBe("warning");
    }
    expect(sentPayloads).toEqual([]);

    store.getState().setDeleteTargetInput(" 7001 ");
    await store.getState().submitDeleteTarget();
    store.getState().setDeleteTargetInput(" -1009400099 ");
    await store.getState().submitDeleteTarget();

    store.getState().setTranslateTargetInput(" 7002 ");
    await store.getState().submitTranslateTarget();
    store.getState().setTranslateTargetInput(" -1009400099 ");
    await store.getState().submitTranslateTarget();

    expect(sentPayloads).toEqual([
      { chatId: -1001, action: "addDeleteTarget", target: "7001" } as never,
      { chatId: -1001, action: "addDeleteTarget", target: "-1009400099" } as never,
      { chatId: -1001, action: "addTranslateTarget", target: "7002", language: "ja" } as never,
      { chatId: -1001, action: "addTranslateTarget", target: "-1009400099", language: "ja" } as never,
    ]);
  });
});
