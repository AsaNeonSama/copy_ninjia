/**
 * Mini App 侧边栏切页帧调度与首屏合并提交测试：覆盖 `AppShell` 抽屉收起双帧解耦切页、
 * 图库最短骨架时长与同批次缩略图合并回执、状态看板骨架期间情绪暂存与乱序情绪响应保护、
 * 以及受管群列表与验证器状态请求的单次合并落定。`fetch` 按「方法 + 路径」路由到测试夹具。
 */

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_TAB_KEYS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import { createStatusStore } from "../../packages/mini-app-frontend/store/status";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppTabKey } from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

mock.module("../../packages/mini-app-frontend/pages/StatusPage", () => ({
  StatusPage: (): ReturnType<typeof createElement> => createElement("section", { "data-page": "status" }),
}));
mock.module("../../packages/mini-app-frontend/pages/ChatsPage", () => ({
  ChatsPage: (): ReturnType<typeof createElement> => createElement("section", { "data-page": "chats" }),
}));
mock.module("../../packages/mini-app-frontend/pages/IdentitiesPage", () => ({
  IdentitiesPage: (): ReturnType<typeof createElement> => createElement("section", { "data-page": "identities" }),
}));

const { AppShell, syncSidebarTabRenderEffect } = await import(
  "../../packages/mini-app-frontend/components/AppShell"
);

/** 一条路由夹具：按请求返回响应。 */
type RouteHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
const originalFetch: typeof fetch = globalThis.fetch;
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

/** 登记 `方法 路径` 的 JSON 响应夹具。 */
function route(key: string, handler: RouteHandler): void {
  routes.set(key, handler);
}

/** 构造 JSON 响应。 */
function json(payload: unknown, status: number = 200): Response {
  return Response.json(payload, { status });
}

beforeEach((): void => {
  routes.clear();
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url: URL = new URL(String(input), "http://mini.test/");
    const key: string = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    const handler: RouteHandler | undefined = routes.get(key);
    if (handler === undefined) return json({ error: `no route ${key}` }, 404);
    return handler(url, init);
  }) as typeof fetch;
  resetMiniAppStoreForTest();
  useMiniAppStore.getState().setLanguage("zh");
});

afterEach((): void => {
  jest.useRealTimers();
  (globalThis as { Telegram?: unknown }).Telegram = undefined;
  globalThis.fetch = originalFetch;
  resetMiniAppStoreForTest();
  clearMiniAppSessionToken();
});

describe("侧边栏切页帧调度与首屏合并提交", () => {
  test("AppShell 各标签页 SSR 同步渲染，且侧边栏收起切页经双帧解耦、连点切换取消前序排期、无帧接口时同步回退", () => {
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initDataUnsafe: { user: { id: 10086 } } },
    };
    useMiniAppStore.setState({
      sidebarOpen: true,
      sessionExpiresAt: Date.now() + 60_000,
      statusReady: true,
    });
    for (const tabKey of MINI_APP_TAB_KEYS) {
      useMiniAppStore.setState({ activeTab: tabKey });
      const html: string = renderToStaticMarkup(createElement(AppShell));
      expect(html).toContain(`<h1 class="topbar-title">${zh.tabs[tabKey]}</h1>`);
      expect(html).toContain(
        tabKey === "totp"
          ? "skeleton-totp-btn"
          : tabKey === "gallery"
            ? "gallery-upload-btn"
            : `data-page="${tabKey}"`
      );
      expect(html).toContain("SuperAdmin #10086");
      expect(html).toContain(zh.lockButton);
    }
    (globalThis as { Telegram?: unknown }).Telegram = undefined;
    useMiniAppStore.setState({
      sidebarOpen: false,
      sessionExpiresAt: 0,
      statusReady: false,
      activeTab: "status",
    });
    const guestHtml: string = renderToStaticMarkup(createElement(AppShell));
    expect(guestHtml).toContain(zh.superAdminBadge);
    expect(guestHtml).not.toContain(zh.lockButton);

    const host = globalThis as {
      requestAnimationFrame?: (cb: (now: number) => void) => number;
      cancelAnimationFrame?: (handle: number) => void;
    };
    const prevRequest: typeof host.requestAnimationFrame = host.requestAnimationFrame;
    const prevCancel: typeof host.cancelAnimationFrame = host.cancelAnimationFrame;
    let frameQueue: Map<number, (now: number) => void> = new Map<number, (now: number) => void>();
    let nextHandle: number = 1;
    const flushOneFrame = (now: number): void => {
      const current: Map<number, (now: number) => void> = frameQueue;
      frameQueue = new Map<number, (now: number) => void>();
      for (const cb of current.values()) {
        cb(now);
      }
    };
    host.requestAnimationFrame = (cb: (now: number) => void): number => {
      const id: number = nextHandle;
      nextHandle += 1;
      frameQueue.set(id, cb);
      return id;
    };
    host.cancelAnimationFrame = (id: number): void => {
      frameQueue.delete(id);
    };

    try {
      const wasSidebarOpenRef: { current: boolean } = { current: false };
      const prevActiveTabRef: { current: MiniAppTabKey } = { current: "status" };
      const deferPendingRef: { current: boolean } = { current: false };
      const committedTabs: MiniAppTabKey[] = [];
      const renderedState: { tab: MiniAppTabKey } = { tab: "status" };
      const setRenderedTab = (nextTab: MiniAppTabKey): void => {
        renderedState.tab = nextTab;
        committedTabs.push(nextTab);
      };

      // 初次挂载与仅打开侧边栏：renderedTab === activeTab 时无排期。
      expect(
        syncSidebarTabRenderEffect({
          activeTab: "status",
          sidebarOpen: true,
          renderedTab: renderedState.tab,
          wasSidebarOpenRef,
          prevActiveTabRef,
          deferPendingRef,
          setRenderedTab,
        })
      ).toBeUndefined();
      expect(wasSidebarOpenRef.current).toBeTrue();
      expect(committedTabs).toEqual([]);

      // 从展开侧边栏切到 chats：第 0 帧与第 1 帧均不挂载新页，第 2 帧才提交。
      const cleanupChats: (() => void) | undefined = syncSidebarTabRenderEffect({
        activeTab: "chats",
        sidebarOpen: false,
        renderedTab: renderedState.tab,
        wasSidebarOpenRef,
        prevActiveTabRef,
        deferPendingRef,
        setRenderedTab,
      });
      expect(typeof cleanupChats).toBe("function");
      expect(deferPendingRef.current).toBeTrue();
      expect(committedTabs).toEqual([]);
      flushOneFrame(16);
      expect(committedTabs).toEqual([]);
      flushOneFrame(32);
      expect(committedTabs).toEqual(["chats"]);
      expect(renderedState.tab).toBe("chats");
      expect(deferPendingRef.current).toBeFalse();
      cleanupChats?.();

      // 落地后再次对齐：无额外更新。
      expect(
        syncSidebarTabRenderEffect({
          activeTab: "chats",
          sidebarOpen: false,
          renderedTab: renderedState.tab,
          wasSidebarOpenRef,
          prevActiveTabRef,
          deferPendingRef,
          setRenderedTab,
        })
      ).toBeUndefined();

      // 侧边栏未展开时的切页（如宽屏常驻侧边栏）：立即同步切换，不走双帧延迟。
      expect(
        syncSidebarTabRenderEffect({
          activeTab: "identities",
          sidebarOpen: false,
          renderedTab: renderedState.tab,
          wasSidebarOpenRef,
          prevActiveTabRef,
          deferPendingRef,
          setRenderedTab,
        })
      ).toBeUndefined();
      expect(committedTabs).toEqual(["chats", "identities"]);

      // 快速连点切页：展开侧栏 -> 点 gallery -> 第 1 帧后改点 totp -> 前序 gallery 被取消且不挂载，2 帧后直接挂载 totp。
      syncSidebarTabRenderEffect({
        activeTab: "identities",
        sidebarOpen: true,
        renderedTab: renderedState.tab,
        wasSidebarOpenRef,
        prevActiveTabRef,
        deferPendingRef,
        setRenderedTab,
      });
      const cleanupGallery: (() => void) | undefined = syncSidebarTabRenderEffect({
        activeTab: "gallery",
        sidebarOpen: false,
        renderedTab: renderedState.tab,
        wasSidebarOpenRef,
        prevActiveTabRef,
        deferPendingRef,
        setRenderedTab,
      });
      flushOneFrame(48);
      expect(committedTabs).toEqual(["chats", "identities"]);
      cleanupGallery?.();
      expect(frameQueue.size).toBe(0);

      const cleanupTotp: (() => void) | undefined = syncSidebarTabRenderEffect({
        activeTab: "totp",
        sidebarOpen: false,
        renderedTab: renderedState.tab,
        wasSidebarOpenRef,
        prevActiveTabRef,
        deferPendingRef,
        setRenderedTab,
      });
      expect(deferPendingRef.current).toBeTrue();
      flushOneFrame(64);
      expect(committedTabs).toEqual(["chats", "identities"]);
      // 在落地前切回当前已挂载的 identities：取消排期且重置 deferPendingRef。
      cleanupTotp?.();
      expect(
        syncSidebarTabRenderEffect({
          activeTab: "identities",
          sidebarOpen: false,
          renderedTab: renderedState.tab,
          wasSidebarOpenRef,
          prevActiveTabRef,
          deferPendingRef,
          setRenderedTab,
        })
      ).toBeUndefined();
      expect(deferPendingRef.current).toBeFalse();
      expect(committedTabs).toEqual(["chats", "identities"]);

      // 排期尚未落地前重新展开侧边栏：撤销待执行帧并立即同步目标标签。
      syncSidebarTabRenderEffect({
        activeTab: "identities",
        sidebarOpen: true,
        renderedTab: renderedState.tab,
        wasSidebarOpenRef,
        prevActiveTabRef,
        deferPendingRef,
        setRenderedTab,
      });
      const cleanupBeforeReopen: (() => void) | undefined = syncSidebarTabRenderEffect({
        activeTab: "gallery",
        sidebarOpen: false,
        renderedTab: renderedState.tab,
        wasSidebarOpenRef,
        prevActiveTabRef,
        deferPendingRef,
        setRenderedTab,
      });
      expect(deferPendingRef.current).toBeTrue();
      cleanupBeforeReopen?.();
      expect(
        syncSidebarTabRenderEffect({
          activeTab: "gallery",
          sidebarOpen: true,
          renderedTab: renderedState.tab,
          wasSidebarOpenRef,
          prevActiveTabRef,
          deferPendingRef,
          setRenderedTab,
        })
      ).toBeUndefined();
      expect(deferPendingRef.current).toBeFalse();
      expect(committedTabs).toEqual(["chats", "identities", "gallery"]);

      // 无 requestAnimationFrame 环境：从展开侧栏切页也立即回退同步更新。
      host.requestAnimationFrame = undefined;
      host.cancelAnimationFrame = undefined;
      wasSidebarOpenRef.current = true;
      expect(
        syncSidebarTabRenderEffect({
          activeTab: "totp",
          sidebarOpen: false,
          renderedTab: renderedState.tab,
          wasSidebarOpenRef,
          prevActiveTabRef,
          deferPendingRef,
          setRenderedTab,
        })
      ).toBeUndefined();
      expect(committedTabs).toEqual(["chats", "identities", "gallery", "totp"]);
    } finally {
      host.requestAnimationFrame = prevRequest;
      host.cancelAnimationFrame = prevCancel;
    }
  });

  test("图库：loadGallery 保证最短骨架时长并单次合并提交，同批次多张缩略图回执合并为单次更新且跨批次丢弃", async () => {
    jest.useFakeTimers();
    const drain = async (): Promise<void> => {
      for (let turn: number = 0; turn < 20; turn += 1) await Promise.resolve();
    };
    const advance = async (ms: number): Promise<void> => {
      jest.advanceTimersByTime(ms);
      await drain();
    };

    const store = createGalleryStore();
    let notifications: number = 0;
    const unsubscribe: () => void = store.subscribe((): void => {
      notifications += 1;
    });
    route("GET /api/gallery", (url: URL): Response =>
      json({ page: Number(url.searchParams.get("page") ?? "1"), items: [], exists: true }));

    // 初始批次（epoch = 0）缩略图回执同样可正常合并落定。
    store.getState().markThumbLoaded("boot.png", 0);
    await advance(MINI_APP_MIN_LOADING_MS);
    expect(store.getState().loadedImages).toEqual({ "boot.png": true });
    expect(notifications).toBe(1);
    notifications = 0;

    const firstLoad: Promise<void> = store.getState().loadGallery(1, 10);
    expect(notifications).toBe(1);
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS - 1);
    expect(store.getState().loading).toBeTrue();
    expect(store.getState().galleryPage).toBeNull();
    expect(notifications).toBe(1);

    await advance(1);
    await firstLoad;
    expect(store.getState().loading).toBeFalse();
    expect(store.getState().batchEpoch).toBe(1);
    expect(notifications).toBe(2);

    // 同一批次内连续完成多张缩略图（含重复文件名）：只在最短时长后触发 1 次合并写入。
    notifications = 0;
    store.getState().markThumbLoaded("1.png", 1);
    store.getState().markThumbLoaded("1.png", 1);
    store.getState().markThumbLoaded("2.png", 1);
    store.getState().markThumbLoaded("3.png", 1);
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS - 1);
    expect(store.getState().loadedImages).toEqual({});
    expect(notifications).toBe(0);
    await advance(1);
    expect(store.getState().loadedImages).toEqual({
      "1.png": true,
      "2.png": true,
      "3.png": true,
    });
    expect(notifications).toBe(1);

    // 最短展示时长已过后，同一事件循环内懒加载完成的多张缩略图经微任务合并为 1 次写入且后续回执不丢项。
    notifications = 0;
    store.getState().markThumbLoaded("late-1.png", 1);
    store.getState().markThumbLoaded("late-2.png", 1);
    store.getState().markThumbLoaded("late-3.png", 1);
    await drain();
    expect(notifications).toBe(1);
    expect(store.getState().loadedImages).toEqual({
      "1.png": true,
      "2.png": true,
      "3.png": true,
      "late-1.png": true,
      "late-2.png": true,
      "late-3.png": true,
    });
    store.getState().markThumbLoaded("late-4.png", 1);
    await drain();
    expect(notifications).toBe(2);
    expect(store.getState().loadedImages["late-4.png"]).toBeTrue();

    // 旧批次在途缩略图回执在开启新批次后被丢弃；并发 loadGallery 只采纳最后一次。
    const staleLoad: Promise<void> = store.getState().loadGallery(1, 10);
    await advance(20);
    const freshLoad: Promise<void> = store.getState().loadGallery(2, 10);
    await advance(MINI_APP_MIN_LOADING_MS);
    await Promise.allSettled([staleLoad, freshLoad]);
    expect(store.getState().page).toBe(2);
    expect(store.getState().batchEpoch).toBe(2);

    store.getState().markThumbLoaded("stale.png", 2);
    route("GET /api/gallery", (): Response => json({ page: 1, items: [], exists: true }));
    const reload: Promise<void> = store.getState().loadGallery(1, 10);
    await advance(MINI_APP_MIN_LOADING_MS);
    await reload;
    expect(store.getState().batchEpoch).toBe(3);
    expect(store.getState().loadedImages).toEqual({});
    // 新批次刚落地（pageRenderAt = 当前时刻）先发起下一页加载、再登记当前批次缩略图：新批次先结算递增 epoch，旧批次回调唤醒后命中跨批次丢弃。
    const nextBatchLoad: Promise<void> = store.getState().loadGallery(2, 10);
    store.getState().markThumbLoaded("discarded.png", 3);
    await advance(MINI_APP_MIN_LOADING_MS);
    await nextBatchLoad;
    expect(store.getState().batchEpoch).toBe(4);
    expect(store.getState().loadedImages).toEqual({});

    // 错误分支同样等待最短骨架时长且可被新请求作废。
    route("GET /api/gallery", (): Response => json({ error: "gallery fail" }, 500));
    const supersededErr: Promise<void> = store.getState().loadGallery(1, 10);
    await advance(10);
    const finalErr: Promise<void> = store.getState().loadGallery(1, 10);
    await advance(MINI_APP_MIN_LOADING_MS - 1);
    expect(store.getState().loading).toBeTrue();
    await advance(1);
    await Promise.allSettled([supersededErr, finalErr]);
    expect(store.getState().loading).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe("gallery fail");
    unsubscribe();
  });

  test("状态看板、受管群与验证器：骨架期间情绪暂存与覆盖竞态归零，列表与状态请求单次落定", async () => {
    jest.useFakeTimers();
    const drain = async (): Promise<void> => {
      for (let turn: number = 0; turn < 20; turn += 1) await Promise.resolve();
    };
    const advance = async (ms: number): Promise<void> => {
      jest.advanceTimersByTime(ms);
      await drain();
    };

    const statusStore = createStatusStore();
    let statusNotifications: number = 0;
    const unsubStatus: () => void = statusStore.subscribe((): void => {
      statusNotifications += 1;
    });
    route("GET /api/mood", (): Response => json({ ok: true, available: true, currentMood: "cozy" }));
    route("GET /api/status", (): Response => json({ generatedAt: 101 }));

    const moodLoad: Promise<void> = statusStore.getState().loadMood();
    const firstStatus: Promise<void> = statusStore.getState().loadStatus(false);
    await drain();
    await moodLoad;
    // 抽屉收起与骨架展示期间情绪已先返回，但不提前触发中间态重渲染。
    expect(statusStore.getState().currentMood).toBeNull();
    expect(statusNotifications).toBe(0);

    await advance(MINI_APP_MIN_LOADING_MS);
    await firstStatus;
    expect(statusStore.getState().status?.generatedAt).toBe(101);
    expect(statusStore.getState().currentMood).toBe("cozy");
    expect(statusStore.getState().loading).toBeFalse();
    expect(statusNotifications).toBe(1);

    // 已有快照后发起手动刷新（置 skeletonLoadReqId）并被非最短等待轮询覆盖：结算后 skeletonLoadReqId 归零，后续独立 loadMood 立即写入。
    route("GET /api/status", (): Response => json({ generatedAt: 102 }));
    const manualRefresh: Promise<void> = statusStore.getState().loadStatus(true);
    const pollRefresh: Promise<void> = statusStore.getState().loadStatus(false);
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS);
    await Promise.allSettled([manualRefresh, pollRefresh]);
    expect(statusStore.getState().status?.generatedAt).toBe(102);
    expect(statusStore.getState().refreshing).toBeFalse();
    route("GET /api/mood", (): Response => json({ ok: true, available: true, currentMood: "energetic" }));
    await statusStore.getState().loadMood();
    expect(statusStore.getState().currentMood).toBe("energetic");

    // 错误结算分支同样无条件归零被覆盖的 skeletonLoadReqId。
    route("GET /api/status", (): Response => json({ error: "status err" }, 500));
    const manualRefreshErr: Promise<void> = statusStore.getState().loadStatus(true);
    const pollRefreshErr: Promise<void> = statusStore.getState().loadStatus(false);
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS);
    await Promise.allSettled([manualRefreshErr, pollRefreshErr]);
    expect(statusStore.getState().refreshing).toBeFalse();
    route("GET /api/mood", (): Response => json({ ok: true, available: true, currentMood: "calm" }));
    await statusStore.getState().loadMood();
    expect(statusStore.getState().currentMood).toBe("calm");

    // 乱序 loadMood 与 switchMood 保护：先发起的慢查询不得覆盖后发起的新查询或已成功的情绪切换结果。
    let resolveSlowMood: ((res: Response) => void) | undefined;
    let moodCallCount: number = 0;
    route("GET /api/mood", (): Response | Promise<Response> => {
      moodCallCount += 1;
      if (moodCallCount === 1) {
        return new Promise<Response>((resolve: (res: Response) => void): void => {
          resolveSlowMood = resolve;
        });
      }
      return json({ ok: true, available: true, currentMood: "bright" });
    });
    const slowMoodLoad: Promise<void> = statusStore.getState().loadMood();
    const fastMoodLoad: Promise<void> = statusStore.getState().loadMood();
    await fastMoodLoad;
    expect(statusStore.getState().currentMood).toBe("bright");
    resolveSlowMood?.(json({ ok: true, available: true, currentMood: "outdated" }));
    await slowMoodLoad;
    expect(statusStore.getState().currentMood).toBe("bright");

    let resolvePreSwitchMood: ((res: Response) => void) | undefined;
    route("GET /api/mood", (): Promise<Response> =>
      new Promise<Response>((resolve: (res: Response) => void): void => {
        resolvePreSwitchMood = resolve;
      }));
    route("POST /api/mood/switch", (): Response =>
      json({ ok: true, currentMood: "sparkling", message: "MOOD_SWITCHED" }));
    const preSwitchMoodLoad: Promise<void> = statusStore.getState().loadMood();
    const switchingPromise: Promise<void> = statusStore.getState().switchMood();
    await drain();
    resolvePreSwitchMood?.(json({ ok: true, available: true, currentMood: "stale-before-switch" }));
    await preSwitchMoodLoad;
    expect(statusStore.getState().currentMood).toBe("bright");
    await advance(MINI_APP_MIN_LOADING_MS);
    await switchingPromise;
    expect(statusStore.getState().currentMood).toBe("sparkling");
    expect(statusStore.getState().switchingMood).toBeFalse();
    unsubStatus();

    const chatsStore = createChatsStore();
    let chatNotifications: number = 0;
    const unsubChats: () => void = chatsStore.subscribe((): void => {
      chatNotifications += 1;
    });
    route("GET /api/chats", (): Response => json({ items: [{ chatId: -1 }] }));
    const staleChats: Promise<void> = chatsStore.getState().loadChatList();
    const freshChats: Promise<void> = chatsStore.getState().loadChatList();
    chatNotifications = 0;
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS);
    await Promise.allSettled([staleChats, freshChats]);
    expect(chatsStore.getState().loadingList).toBeFalse();
    expect(chatsStore.getState().chats).toHaveLength(1);
    expect(chatNotifications).toBe(1);
    route("GET /api/chats", (): Response => json({ error: "chats err" }, 500));
    const staleChatsErr: Promise<void> = chatsStore.getState().loadChatList();
    const freshChatsErr: Promise<void> = chatsStore.getState().loadChatList();
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS);
    await Promise.allSettled([staleChatsErr, freshChatsErr]);
    expect(chatsStore.getState().loadingList).toBeFalse();
    unsubChats();

    const totpStore = createTotpStore();
    let totpNotifications: number = 0;
    const unsubTotp: () => void = totpStore.subscribe((): void => {
      totpNotifications += 1;
    });
    route("GET /api/totp", (): Response => json({ enabled: false, createdAt: null, maskedSecret: null }));
    const staleTotp: Promise<void> = totpStore.getState().loadTotpStatus();
    const freshTotp: Promise<void> = totpStore.getState().loadTotpStatus();
    totpNotifications = 0;
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS);
    await Promise.allSettled([staleTotp, freshTotp]);
    expect(totpStore.getState().loadingStatus).toBeFalse();
    expect(totpNotifications).toBe(1);
    route("GET /api/totp", (): Response => json({ error: "totp err" }, 500));
    const staleTotpErr: Promise<void> = totpStore.getState().loadTotpStatus();
    const freshTotpErr: Promise<void> = totpStore.getState().loadTotpStatus();
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS);
    await Promise.allSettled([staleTotpErr, freshTotpErr]);
    expect(totpStore.getState().loadingStatus).toBeFalse();
    unsubTotp();
  });
});
