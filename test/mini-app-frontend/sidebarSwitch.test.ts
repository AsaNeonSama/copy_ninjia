/**
 * Mini App 侧边栏切页帧调度、首屏合并提交与图库上传按钮交互复位测试：覆盖 `AppShell` 抽屉收起双帧解耦切页、
 * 图库最短骨架时长与同批次缩略图合并回执、状态看板骨架期间情绪暂存与乱序情绪响应保护、
 * 受管群列表与验证器状态请求的单次合并落定，以及图库上传按钮 85ms 延时按压复位、悬停抑制清理与焦点样式规则。
 * `fetch` 按「方法 + 路径」路由到测试夹具。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createElement } from "react";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppShell,
  syncSidebarTabRenderEffect,
} from "../../packages/mini-app-frontend/components/AppShell";
import {
  MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_PAGINATION_HOVER_DURATION_MS,
  MINI_APP_TAB_KEYS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { blurElement } from "../../packages/mini-app-frontend/libs/formatters";
import type { BlurCapableElement } from "../../packages/mini-app-frontend/libs/formatters";
import {
  buildGalleryUploadBtnClassName,
  createGalleryUploadController,
  GalleryPage,
} from "../../packages/mini-app-frontend/pages/GalleryPage";
import type { GalleryUploadController } from "../../packages/mini-app-frontend/pages/GalleryPage";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import { createStatusStore } from "../../packages/mini-app-frontend/store/status";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppTabKey } from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

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

/** 排空当前微任务队列。 */
async function drain(): Promise<void> {
  for (let turn: number = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

/** 推进假定时器并排空派生微任务。 */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await drain();
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
    const expectedPageMarkers: Readonly<Record<MiniAppTabKey, string>> = {
      status: "skeleton-cpu-ring",
      chats: zh.chats.sectionTitle(0),
      identities: zh.identities.whitelistTab,
      gallery: "gallery-upload-btn",
      totp: "skeleton-totp-btn",
    };
    for (const tabKey of MINI_APP_TAB_KEYS) {
      useMiniAppStore.setState({ activeTab: tabKey });
      const html: string = renderToStaticMarkup(createElement(AppShell));
      expect(html).toContain(`<h1 class="topbar-title">${zh.tabs[tabKey]}</h1>`);
      expect(html).toContain(expectedPageMarkers[tabKey]);
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
      for (const cb of current.values()) cb(now);
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
      const runSync = (
        activeTab: MiniAppTabKey,
        sidebarOpen: boolean
      ): (() => void) | undefined =>
        syncSidebarTabRenderEffect({
          activeTab,
          sidebarOpen,
          renderedTab: renderedState.tab,
          wasSidebarOpenRef,
          prevActiveTabRef,
          deferPendingRef,
          setRenderedTab,
        });

      // 初次挂载与仅打开侧边栏：renderedTab === activeTab 时无排期。
      expect(runSync("status", true)).toBeUndefined();
      expect(wasSidebarOpenRef.current).toBeTrue();
      expect(committedTabs).toEqual([]);

      // 从展开侧边栏切到 chats：第 0 帧与第 1 帧均不挂载新页，第 2 帧才提交。
      const cleanupChats: (() => void) | undefined = runSync("chats", false);
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

      // 落地后再次对齐：无额外更新；侧边栏未展开时的切页（如宽屏常驻侧边栏）立即同步切换。
      expect(runSync("chats", false)).toBeUndefined();
      expect(runSync("identities", false)).toBeUndefined();
      expect(committedTabs).toEqual(["chats", "identities"]);

      // 快速连点切页：展开侧栏 -> 点 gallery -> 第 1 帧后改点 totp -> 前序 gallery 被取消且不挂载。
      runSync("identities", true);
      const cleanupGallery: (() => void) | undefined = runSync("gallery", false);
      flushOneFrame(48);
      expect(committedTabs).toEqual(["chats", "identities"]);
      cleanupGallery?.();
      expect(frameQueue.size).toBe(0);

      const cleanupTotp: (() => void) | undefined = runSync("totp", false);
      expect(deferPendingRef.current).toBeTrue();
      flushOneFrame(64);
      expect(committedTabs).toEqual(["chats", "identities"]);
      // 在落地前切回当前已挂载的 identities：取消排期且重置 deferPendingRef。
      cleanupTotp?.();
      expect(runSync("identities", false)).toBeUndefined();
      expect(deferPendingRef.current).toBeFalse();
      expect(committedTabs).toEqual(["chats", "identities"]);

      // 排期尚未落地前重新展开侧边栏：撤销待执行帧并立即同步目标标签。
      runSync("identities", true);
      const cleanupBeforeReopen: (() => void) | undefined = runSync("gallery", false);
      expect(deferPendingRef.current).toBeTrue();
      cleanupBeforeReopen?.();
      expect(runSync("gallery", true)).toBeUndefined();
      expect(deferPendingRef.current).toBeFalse();
      expect(committedTabs).toEqual(["chats", "identities", "gallery"]);

      // 无 requestAnimationFrame 环境：从展开侧栏切页也立即回退同步更新。
      host.requestAnimationFrame = undefined;
      host.cancelAnimationFrame = undefined;
      wasSidebarOpenRef.current = true;
      expect(runSync("totp", false)).toBeUndefined();
      expect(committedTabs).toEqual(["chats", "identities", "gallery", "totp"]);
    } finally {
      host.requestAnimationFrame = prevRequest;
      host.cancelAnimationFrame = prevCancel;
    }
  });

  test("图库：loadGallery 保证最短骨架时长并单次合并提交，同批次多张缩略图回执合并为单次更新且跨批次丢弃", async () => {
    jest.useFakeTimers();
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
    expect(store.getState().loadedImages).toEqual({ "1.png": true, "2.png": true, "3.png": true });
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

    // 新批次刚落地先发起下一页加载、再登记当前批次缩略图：新批次先结算递增 epoch，旧批次回调命中跨批次丢弃。
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

    // 后台静默查询与轮询（loadMood、loadStatus(false)、pollRunningBatchKick）：普通 500 静默，401/403 立即锁定根门禁
    useMiniAppStore.setState({ gateState: "unlocked", toastText: "" });
    route("GET /api/mood", (): Response => json({ error: "mood transient" }, 500));
    await statusStore.getState().loadMood();
    expect(useMiniAppStore.getState().gateState).toBe("unlocked");
    expect(useMiniAppStore.getState().toastText).toBe("");

    route("GET /api/mood", (): Response => json({ code: "PASSWORD_REQUIRED", error: "expired" }, 401));
    await statusStore.getState().loadMood();
    expect(useMiniAppStore.getState().gateState).toBe("password");

    useMiniAppStore.setState({ gateState: "unlocked", toastText: "" });
    route("GET /api/status", (): Response => json({ code: "PASSWORD_LOCKED", error: "locked" }, 403));
    const pollLockPromise: Promise<void> = statusStore.getState().loadStatus(false);
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS);
    await pollLockPromise;
    expect(useMiniAppStore.getState().gateState).toBe("checking");

    useMiniAppStore.setState({ gateState: "unlocked", toastText: "" });
    chatsStore.setState({
      selectedChatId: -1001,
      chatDetail: { chatId: -1001, batchKickRunning: true } as never,
    });
    route("GET /api/chats/-1001", (): Response => json({ error: "transient" }, 500));
    await chatsStore.getState().pollRunningBatchKick();
    expect(useMiniAppStore.getState().gateState).toBe("unlocked");

    route("GET /api/chats/-1001", (): Response => json({ code: "PASSWORD_REQUIRED", error: "revoked" }, 401));
    await chatsStore.getState().pollRunningBatchKick();
    expect(useMiniAppStore.getState().gateState).toBe("password");
  });
});

describe("图库上传按钮 85ms 按压复位与悬停抑制", () => {
  test("点击立即置位 .is-pressing 与 .hover-suppressed 且不拦截默认行为，85ms 到期失焦并转入悬停抑制，移动/移出/再按下与禁用/卸载清理完备", () => {
    jest.useFakeTimers();

    blurElement(null);
    blurElement(undefined);
    blurElement({});

    let statePressing: boolean = false;
    let stateHoverSuppressed: boolean = false;
    let blurCount: number = 0;
    const inputEl: BlurCapableElement = {
      blur: (): void => {
        blurCount += 1;
      },
    };
    const ctrl: GalleryUploadController = createGalleryUploadController(
      (next: boolean): void => {
        statePressing = next;
      },
      (next: boolean): void => {
        stateHoverSuppressed = next;
      }
    );
    ctrl.setInputNode(inputEl);
    const currentClassName = (): string =>
      buildGalleryUploadBtnClassName(ctrl.disabled, statePressing, stateHoverSuppressed);

    // 1. 初始空闲态与禁用态类名精确一致，禁用态点击为无副作用空操作
    expect(currentClassName()).toBe("btn primary icon-btn gallery-upload-btn");
    ctrl.disabled = true;
    expect(currentClassName()).toBe("btn primary icon-btn gallery-upload-btn is-disabled");
    ctrl.onClick({ clientX: 120, clientY: 60 });
    expect(statePressing).toBeFalse();
    expect(stateHoverSuppressed).toBeFalse();
    expect(ctrl.timer).toBeNull();
    ctrl.disabled = false;

    // 2. 点击立即进入 .is-pressing + .hover-suppressed，不调用 preventDefault，且在 85ms 前不同步调用 blur()
    let preventDefaultCalled: boolean = false;
    const clickX: number = 180;
    const clickY: number = 96;
    ctrl.onClick({
      clientX: clickX,
      clientY: clickY,
      preventDefault: (): void => {
        preventDefaultCalled = true;
      },
    } as { readonly clientX: number; readonly clientY: number });
    expect(preventDefaultCalled).toBeFalse();
    expect(blurCount).toBe(0);
    expect(statePressing).toBeTrue();
    expect(stateHoverSuppressed).toBeTrue();
    expect({ x: ctrl.clickX, y: ctrl.clickY }).toEqual({ x: clickX, y: clickY });
    expect(ctrl.timer).not.toBeNull();
    expect(currentClassName()).toBe(
      "btn primary icon-btn gallery-upload-btn is-pressing hover-suppressed"
    );

    // 85ms 按压窗口内，系统文件选择器抢走焦点派发的合成 mouseleave 与 mousemove 均不会提前解除 .hover-suppressed
    ctrl.onMouseLeave();
    ctrl.onMouseMove({
      clientX: clickX + MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX + 20,
      clientY: clickY + MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX + 20,
    });
    expect(stateHoverSuppressed).toBeTrue();

    // 推进至到期前 1ms：仍保持 .is-pressing 且尚未失焦
    jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS - 1);
    expect(statePressing).toBeTrue();
    expect(blurCount).toBe(0);

    // 到期满 85ms：清除 .is-pressing、调用 input.blur()，并继续保留 .hover-suppressed
    jest.advanceTimersByTime(1);
    expect(ctrl.timer).toBeNull();
    expect(statePressing).toBeFalse();
    expect(blurCount).toBe(1);
    expect(stateHoverSuppressed).toBeTrue();
    expect(currentClassName()).toBe("btn primary icon-btn gallery-upload-btn hover-suppressed");

    // 3. 指针微颤 <= MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX 时保留 .hover-suppressed，超出阈值（X 或 Y）立即解除
    ctrl.onMouseMove({
      clientX: clickX + MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX,
      clientY: clickY - MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX,
    });
    expect(stateHoverSuppressed).toBeTrue();
    ctrl.onMouseMove({
      clientX: clickX + MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX + 1,
      clientY: clickY,
    });
    expect(stateHoverSuppressed).toBeFalse();
    expect(currentClassName()).toBe("btn primary icon-btn gallery-upload-btn");

    ctrl.onClick({ clientX: clickX, clientY: clickY });
    jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS);
    expect(stateHoverSuppressed).toBeTrue();
    ctrl.onMouseMove({
      clientX: clickX,
      clientY: clickY - (MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX + 1),
    });
    expect(stateHoverSuppressed).toBeFalse();

    // 4. 85ms 结束后 mouseleave 解除 .hover-suppressed（禁用期间忽略 mouseleave / mousemove / pointerdown）
    ctrl.onClick({ clientX: clickX, clientY: clickY });
    jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS);
    ctrl.disabled = true;
    ctrl.onMouseLeave();
    ctrl.onMouseMove({
      clientX: clickX + MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX + 10,
      clientY: clickY,
    });
    ctrl.onPointerDown();
    expect(stateHoverSuppressed).toBeTrue();
    ctrl.disabled = false;
    ctrl.onMouseLeave();
    expect(stateHoverSuppressed).toBeFalse();

    // 5. 原地再次点击：pointerdown 先清除 .hover-suppressed，使连续点击立即恢复原生 :active
    ctrl.onClick({ clientX: clickX, clientY: clickY });
    jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS);
    expect(stateHoverSuppressed).toBeTrue();
    ctrl.onPointerDown();
    expect(stateHoverSuppressed).toBeFalse();
    expect(currentClassName()).toBe("btn primary icon-btn gallery-upload-btn");

    // 6. 快速连续双击：第二次点击清理前序定时器并重新完整计时 85ms
    blurCount = 0;
    const halfWindowMs: number = Math.max(1, Math.floor(MINI_APP_PAGINATION_HOVER_DURATION_MS / 2));
    ctrl.onClick({ clientX: 50, clientY: 40 });
    jest.advanceTimersByTime(halfWindowMs);
    expect(statePressing).toBeTrue();
    ctrl.onPointerDown();
    ctrl.onClick({ clientX: 52, clientY: 41 });
    jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS - halfWindowMs);
    expect(statePressing).toBeTrue();
    expect(blurCount).toBe(0);
    jest.advanceTimersByTime(halfWindowMs);
    expect(statePressing).toBeFalse();
    expect(blurCount).toBe(1);

    // 7. 85ms 未到期时进入 disabled = true：立即清理定时器、复位 pressing 并失焦，不遗留回调
    expect(
      createGalleryUploadController((): void => undefined, (): void => undefined, true).disabled
    ).toBeTrue();
    blurCount = 0;
    ctrl.syncDisabled(false);
    expect(blurCount).toBe(0);
    ctrl.onClick({ clientX: 90, clientY: 30 });
    expect(ctrl.timer).not.toBeNull();
    ctrl.syncDisabled(true);
    expect(ctrl.disabled).toBeTrue();
    expect(ctrl.timer).toBeNull();
    expect(statePressing).toBeFalse();
    expect(blurCount).toBe(1);
    expect(currentClassName()).toBe("btn primary icon-btn gallery-upload-btn is-disabled");
    jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS * 2);
    expect(blurCount).toBe(1);

    // 8. 组件卸载时清理在途 85ms 定时器，无泄漏回调
    ctrl.syncDisabled(false);
    ctrl.onClick({ clientX: 90, clientY: 30 });
    expect(ctrl.timer).not.toBeNull();
    ctrl.clearTimer();
    expect(ctrl.timer).toBeNull();
    ctrl.clearTimer();
    jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS * 2);
    expect(blurCount).toBe(1);

    // 9. 文件选择变更：优先失焦 inputEl，未挂载时回退失焦 currentTarget，空选择不上传，非空选择重置 value 并触发上传
    const uploadedBatches: (readonly File[])[] = [];
    const mockUploadFiles = async (files: readonly File[]): Promise<void> => {
      uploadedBatches.push(files);
    };
    blurCount = 0;
    ctrl.selectFiles({ currentTarget: { value: "", files: [] } }, mockUploadFiles);
    expect(blurCount).toBe(1);
    expect(uploadedBatches).toHaveLength(0);

    let fallbackBlurred: boolean = false;
    const pickedFile: File = new File(["img"], "picked.png", { type: "image/png" });
    const fallbackTarget: { value: string; files: File[]; blur: () => void } = {
      value: "C:\\fakepath\\picked.png",
      files: [pickedFile],
      blur: (): void => {
        fallbackBlurred = true;
      },
    };
    ctrl.setInputNode(null);
    ctrl.selectFiles({ currentTarget: fallbackTarget }, mockUploadFiles);
    expect(fallbackBlurred).toBeTrue();
    expect(fallbackTarget.value).toBe("");
    expect(uploadedBatches).toEqual([[pickedFile]]);
  });

  test("GalleryPage 组件上传按钮节点事件绑定与 gallery.css 焦点/按压/悬停抑制样式规则核验", async () => {
    jest.useFakeTimers();

    const uploadedBatches: (readonly File[])[] = [];
    const galleryStore = createGalleryStore();
    (galleryStore as { getInitialState: typeof galleryStore.getState }).getInitialState =
      galleryStore.getState;
    galleryStore.setState({
      loading: false,
      uploading: false,
      galleryPage: {
        directory: "/data/gallery",
        exists: true,
        total: 0,
        page: 1,
        pageSize: 10,
        totalPages: 1,
        items: [],
      },
      uploadFiles: async (files: readonly File[]): Promise<void> => {
        uploadedBatches.push(files);
      },
    });

    interface CapturedUploadElements {
      readonly uploadBtnProps: {
        readonly className: string;
        readonly "aria-disabled": boolean;
        readonly onMouseLeave: () => void;
        readonly onMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
      };
      readonly uploadInputProps: {
        readonly ref: (el: BlurCapableElement | null) => void;
        readonly className: string;
        readonly disabled: boolean;
        readonly onPointerDown: () => void;
        readonly onClick: (event: React.MouseEvent<HTMLInputElement>) => void;
        readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
      };
    }

    let captured: CapturedUploadElements | undefined;
    const UploadBindingProbe = (): React.JSX.Element => {
      const tree: React.JSX.Element = GalleryPage({ storeFactory: () => galleryStore });
      const cardNode = (tree.props as { readonly children: readonly React.JSX.Element[] }).children[0]!;
      const titleNode = (cardNode.props as { readonly children: readonly React.JSX.Element[] }).children[0]!;
      const actionsNode = (titleNode.props as { readonly children: readonly React.JSX.Element[] }).children[1]!;
      const uploadBtnNode = (actionsNode.props as { readonly children: readonly React.JSX.Element[] }).children[0]!;
      const uploadInputNode = (
        uploadBtnNode.props as { readonly children: readonly React.JSX.Element[] }
      ).children[2]!;
      captured = {
        uploadBtnProps: uploadBtnNode.props as CapturedUploadElements["uploadBtnProps"],
        uploadInputProps: uploadInputNode.props as CapturedUploadElements["uploadInputProps"],
      };
      return tree;
    };

    const html: string = renderToStaticMarkup(createElement(UploadBindingProbe));
    expect(html).toContain('class="btn primary icon-btn gallery-upload-btn"');
    expect(captured).toBeDefined();
    expect(captured?.uploadBtnProps.className).toBe("btn primary icon-btn gallery-upload-btn");
    expect(captured?.uploadBtnProps["aria-disabled"]).toBeFalse();
    expect(captured?.uploadInputProps.className).toBe("gallery-upload-input");
    expect(captured?.uploadInputProps.disabled).toBeFalse();

    let nodeBlurred: number = 0;
    captured?.uploadInputProps.ref({
      blur: (): void => {
        nodeBlurred += 1;
      },
    });
    captured?.uploadInputProps.onPointerDown();
    captured?.uploadInputProps.onClick({
      clientX: 64,
      clientY: 32,
    } as React.MouseEvent<HTMLInputElement>);
    expect(nodeBlurred).toBe(0);
    jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS);
    expect(nodeBlurred).toBe(1);
    captured?.uploadBtnProps.onMouseMove({
      clientX: 80,
      clientY: 48,
    } as React.MouseEvent<HTMLDivElement>);
    captured?.uploadBtnProps.onMouseLeave();

    const file: File = new File(["bytes"], "demo.webp", { type: "image/webp" });
    const changeTarget: { value: string; files: File[] } = {
      value: "C:\\fakepath\\demo.webp",
      files: [file],
    };
    captured?.uploadInputProps.onChange({
      currentTarget: changeTarget,
    } as unknown as React.ChangeEvent<HTMLInputElement>);
    expect(nodeBlurred).toBe(2);
    expect(changeTarget.value).toBe("");
    expect(uploadedBatches).toEqual([[file]]);
    captured?.uploadInputProps.ref(null);

    // 验证 gallery.css 焦点与按压/悬停抑制规则及高特异性声明契约
    const galleryCssPath: string = `${import.meta.dir}/../../packages/mini-app-frontend/styles/gallery.css`;
    const galleryCss: string = await Bun.file(galleryCssPath).text();

    expect(galleryCss).not.toContain(":focus-within");
    const focusVisibleRule: RegExpExecArray | null =
      /\.gallery-upload-btn:has\(\s*>\s*\.gallery-upload-input:focus-visible\s*\):not\(\.is-disabled\)\s*\{([^}]*)\}/u.exec(
        galleryCss
      );
    expect(focusVisibleRule).not.toBeNull();
    expect(focusVisibleRule?.[1] ?? "").toContain("outline: var(--border-w) solid var(--brutal-cyan);");
    expect(focusVisibleRule?.[1] ?? "").toContain("outline-offset: 2px;");

    const pressingRule: RegExpExecArray | null =
      /\.btn\.primary\.icon-btn\.gallery-upload-btn\.is-pressing:not\(\.is-disabled\)\s*\{([^}]*)\}/u.exec(
        galleryCss
      );
    expect(pressingRule).not.toBeNull();
    const pressingBody: string = pressingRule?.[1] ?? "";
    expect(pressingBody).toContain("transform: translate(2px, 2px) skewX(var(--btn-skew, 0deg));");
    expect(pressingBody).toContain("box-shadow: 0 0 0 var(--btn-shadow-color);");
    expect(pressingBody).toContain("background: var(--accent-light);");
    expect(pressingBody).toContain("color: var(--btn-primary-text);");
    expect(pressingBody).toContain("border-color: var(--btn-primary-border);");
    expect(pressingBody).toContain("transition: none;");

    const hoverSuppressedRule: RegExpExecArray | null =
      /\.btn\.primary\.icon-btn\.gallery-upload-btn\.hover-suppressed:not\(\.is-pressing\):not\(\.is-disabled\)\s*\{([^}]*)\}/u.exec(
        galleryCss
      );
    expect(hoverSuppressedRule).not.toBeNull();
    const hoverSuppressedBody: string = hoverSuppressedRule?.[1] ?? "";
    expect(hoverSuppressedBody).toContain("transform: skewX(var(--btn-skew, 0deg));");
    expect(hoverSuppressedBody).toContain("box-shadow: var(--btn-primary-shadow);");
    expect(hoverSuppressedBody).toContain("background: var(--btn-primary-bg);");
    expect(hoverSuppressedBody).toContain("color: var(--btn-primary-text);");
    expect(hoverSuppressedBody).toContain("border-color: var(--btn-primary-border);");
  });
});
