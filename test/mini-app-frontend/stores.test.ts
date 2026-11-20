/**
 * Mini App 前端 store 的行为：根 store 的 Toast、预检与登录门禁，以及各页面组件独占 store
 * 的加载、竞态丢弃、确认弹窗与写操作回执。`fetch` 按「方法 + 路径」路由到测试夹具。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS,
  MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_PAGINATION_HOVER_DURATION_MS,
  MINI_APP_PICKER_POLL_INTERVAL_MS,
  MINI_APP_STATUS_POLL_INTERVAL_MS,
  MINI_APP_STATUS_SNAPSHOT_HOLD_AFTER_TOGGLE_MS,
  MINI_APP_TOAST_DURATION_MS,
  RANDOM_IMAGE_MAX_BYTES,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { ChatTargetsQaEditorForm } from "../../packages/mini-app-frontend/components/ChatTargetsQaPanel";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import { TotpPage } from "../../packages/mini-app-frontend/pages/TotpPage";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import { createIdentitiesStore } from "../../packages/mini-app-frontend/store/identities";
import { createMessagesStore } from "../../packages/mini-app-frontend/store/messages";
import { createPermissionDrawerStore } from "../../packages/mini-app-frontend/store/permissionDrawer";
import { createStatusStore } from "../../packages/mini-app-frontend/store/status";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  seedTestMiniAppSession, wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";
import {
  drainImmediate, flushFakeTimersUntil, flushUntil, resolveWithFakeTimers,
} from "./helpers/fakeTimerFlush";

/** 一条路由夹具：按请求返回响应。 */
type RouteHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
const fetchCalls: string[] = [];
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
  fetchCalls.length = 0;
  seedTestMiniAppSession("0".repeat(64), Date.now() + 600_000);
  globalThis.fetch = wrapEncryptedTestFetch((url: URL, init?: RequestInit): Response | Promise<Response> => {
    const key: string = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    fetchCalls.push(`${key}${url.search}`);
    const handler: RouteHandler | undefined = routes.get(key);
    if (handler === undefined) return json({ error: `no route ${key}` }, 404);
    return handler(url, init);
  });
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

describe("根 store", () => {
  test("notify 展示 Toast 并在时限后清除，PASSWORD_REQUIRED 锁定会话，PASSWORD_LOCKED 重新预检进入 denied", async () => {
    jest.useFakeTimers();
    useMiniAppStore.setState({ gateState: "unlocked", sessionExpiresAt: 1 });
    useMiniAppStore.getState().notify("hello", "warning");
    expect(useMiniAppStore.getState().toastText).toBe("hello");
    expect(useMiniAppStore.getState().toastTone).toBe("warning");
    jest.advanceTimersByTime(MINI_APP_TOAST_DURATION_MS);
    expect(useMiniAppStore.getState().toastText).toBe("");

    useMiniAppStore.getState().notify("[PASSWORD_REQUIRED] expired");
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().passwordError).toBe("expired");
    expect(useMiniAppStore.getState().toastText).toBe("expired");
    expect(useMiniAppStore.getState().toastTone).toBe("warning");
    expect(useMiniAppStore.getState().sessionExpiresAt).toBe(0);

    seedTestMiniAppSession("e".repeat(64), Date.now() + 60_000);
    route("GET /api/auth/precheck", (): Response =>
      json({ ok: false, code: "PASSWORD_LOCKED", error: "locked" }, 403));
    useMiniAppStore.setState({ gateState: "unlocked", sessionExpiresAt: 1 });
    useMiniAppStore.getState().notify("[PASSWORD_LOCKED] locked");
    expect(useMiniAppStore.getState().gateState).toBe("checking");
    expect(readMiniAppSessionToken()).toBe("");
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    expect(useMiniAppStore.getState().deniedDiag?.code).toBe("PASSWORD_LOCKED");
  });

  test("预检按结果进入 denied、password 或 unlocked，网络异常落到兜底诊断", async () => {
    route("GET /api/auth/precheck", (): Response =>
      json({ ok: false, requestId: "r1", code: "FORBIDDEN_USER", error: "no" }, 403));
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    expect(useMiniAppStore.getState().deniedDiag?.code).toBe("FORBIDDEN_USER");

    route("GET /api/auth/precheck", (): Response => json({ ok: true, totpEnabled: true }));
    useMiniAppStore.setState({ gateState: "checking" });
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().authMode).toBe("totp");

    const expiresAt: number = Date.now() + 60_000;
    seedTestMiniAppSession("a".repeat(64), expiresAt);
    route("GET /api/auth/precheck", (): Response =>
      json({ ok: true, sessionValid: true, sessionExpiresAt: expiresAt }));
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("unlocked");
    expect(useMiniAppStore.getState().sessionExpiresAt).toBe(expiresAt);

    route("GET /api/auth/precheck", (): Response => {
      throw new Error("offline");
    });
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    expect(useMiniAppStore.getState().deniedDiag?.error).toBe("offline");
    expect(useMiniAppStore.getState().deniedDiag?.code).toBe("ACCESS_DENIED");
  });

  test("预检判定会话无效或失败时只清除发出请求时的那枚令牌，在途期间写入的新令牌保持不动", async () => {
    const staleToken: string = "c".repeat(64);
    const freshToken: string = "d".repeat(64);
    const freshExpiresAt: number = Date.now() + 60_000;

    seedTestMiniAppSession(staleToken, Date.now() + 60_000);
    route("GET /api/auth/precheck", (): Response => json({ ok: true, sessionValid: false }));
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");

    seedTestMiniAppSession(staleToken, Date.now() + 60_000);
    route("GET /api/auth/precheck", (): Response => {
      seedTestMiniAppSession(freshToken, freshExpiresAt);
      return json({ ok: true, sessionValid: false });
    });
    useMiniAppStore.setState({ gateState: "checking" });
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe(freshToken);

    seedTestMiniAppSession(staleToken, Date.now() + 60_000);
    route("GET /api/auth/precheck", (): Response => {
      seedTestMiniAppSession(freshToken, freshExpiresAt);
      return json({ ok: false, code: "FORBIDDEN_USER", error: "no" }, 403);
    });
    useMiniAppStore.setState({ gateState: "checking" });
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    expect(readMiniAppSessionToken()).toBe(freshToken);
  });

  test("预检恢复的会话到期后按当前语言锁定控制台", async () => {
    jest.useFakeTimers();
    const expiresAt: number = Date.now() + 1_000;
    seedTestMiniAppSession("b".repeat(64), expiresAt);
    route("GET /api/auth/precheck", (): Response =>
      json({ ok: true, sessionValid: true, sessionExpiresAt: expiresAt }));
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("unlocked");
    useMiniAppStore.getState().setLanguage("ja");
    jest.advanceTimersByTime(1_000);
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().passwordError).toBe(getMiniAppTranslations("ja").sessionExpiredToast);
    expect(readMiniAppSessionToken()).toBe("");
  });

});

describe("页面 store", () => {
  test("状态看板只采纳最后一次请求，成功时置根 store 就绪，手动刷新失败以 Toast 报错", async () => {
    jest.useFakeTimers();
    const store = createStatusStore();
    let calls: number = 0;
    const firstStatusGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("GET /api/status", async (): Promise<Response> => {
      calls += 1;
      const seq: number = calls;
      if (seq === 1) await firstStatusGate.promise;
      return json({ generatedAt: seq });
    });
    route("GET /api/mood", (): Response => json({ ok: true, available: true, currentMood: "happy" }));
    const first: Promise<void> = store.getState().loadStatus(false);
    const second: Promise<void> = store.getState().loadStatus(false);
    await resolveWithFakeTimers(second);
    firstStatusGate.resolve();
    await resolveWithFakeTimers(first);
    expect(store.getState().status?.generatedAt).toBe(2);
    expect(store.getState().loading).toBeFalse();
    expect(useMiniAppStore.getState().statusReady).toBeTrue();

    route("GET /api/status", (): Response => json({ error: "boom" }, 500));
    await resolveWithFakeTimers(store.getState().loadStatus(true));
    await flushUntil((): boolean => store.getState().currentMood === "happy");
    expect(store.getState().errorText).toBe("boom");
    expect(store.getState().refreshing).toBeFalse();
    expect(store.getState().currentMood).toBe("happy");
    expect(useMiniAppStore.getState().toastText).toBe("boom");

    store.getState().toggleCapability("mood");
    expect(store.getState().expandedCapKeys).toEqual({ mood: true });
    store.getState().toggleCapability("mood");
    expect(store.getState().expandedCapKeys).toEqual({ mood: false });

    route("POST /api/mood/switch", (): Response =>
      json({ ok: true, available: true, currentMood: "calm", message: "switched" }));
    await resolveWithFakeTimers(store.getState().switchMood());
    expect(store.getState().currentMood).toBe("calm");
    expect(store.getState().switchingMood).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe("switched");
  });

  test("状态看板切换折叠面板后，暂缓时段内取得的快照到时段结束才写入，时段过后立即写入", async () => {
    jest.useFakeTimers();
    expect(MINI_APP_STATUS_SNAPSHOT_HOLD_AFTER_TOGGLE_MS).toBeGreaterThanOrEqual(
      MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS
    );
    let calls: number = 0;
    route("GET /api/status", (): Response => {
      calls += 1;
      return json({ generatedAt: calls });
    });
    const drain = async (): Promise<void> => {
      for (let turn: number = 0; turn < 6; turn += 1) {
        Bun.sleepSync(2);
        await new Promise<void>((resolve: () => void): void => {
          setImmediate(resolve);
        });
      }
    };
    const advance = async (ms: number): Promise<void> => {
      jest.advanceTimersByTime(ms);
      await drain();
    };
    const store = createStatusStore();
    const first: Promise<void> = store.getState().loadStatus(false);
    await drain();
    await advance(MINI_APP_MIN_LOADING_MS);
    await first;
    expect(store.getState().status?.generatedAt).toBe(1);

    store.getState().toggleCapability("mood");
    const second: Promise<void> = store.getState().loadStatus(false);
    await drain();
    expect(calls).toBe(2);
    expect(store.getState().status?.generatedAt).toBe(1);
    await advance(MINI_APP_STATUS_SNAPSHOT_HOLD_AFTER_TOGGLE_MS - 1);
    expect(store.getState().status?.generatedAt).toBe(1);
    await advance(1);
    await second;
    expect(store.getState().status?.generatedAt).toBe(2);
    expect(store.getState().loading).toBeFalse();

    const third: Promise<void> = store.getState().loadStatus(false);
    await drain();
    await third;
    expect(store.getState().status?.generatedAt).toBe(3);
  });

  test("状态轮询：响应结算后才排下一次，最小化或页面隐藏时暂停、回到前台立即补拉，停止后注销订阅", async () => {
    jest.useFakeTimers();
    const telegramHandlers: Map<string, () => void> = new Map<string, () => void>();
    const webApp: { isActive: boolean; onEvent: (type: string, handler: () => void) => void; offEvent: (type: string, handler: () => void) => void } = {
      isActive: true,
      onEvent: (type: string, handler: () => void): void => {
        telegramHandlers.set(type, handler);
      },
      offEvent: (type: string, handler: () => void): void => {
        if (telegramHandlers.get(type) === handler) telegramHandlers.delete(type);
      },
    };
    const visibility: { listener: (() => void) | null } = { listener: null };
    const page: { visibilityState: "visible" | "hidden"; addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void } = {
      visibilityState: "visible",
      addEventListener: (_type: string, listener: () => void): void => {
        visibility.listener = listener;
      },
      removeEventListener: (_type: string, listener: () => void): void => {
        if (visibility.listener === listener) visibility.listener = null;
      },
    };
    (globalThis as { Telegram?: unknown }).Telegram = { WebApp: webApp };
    (globalThis as { document?: unknown }).document = page;
    let calls: number = 0;
    let hold: boolean = false;
    let release: () => void = (): void => {};
    route("GET /api/status", async (): Promise<Response> => {
      calls += 1;
      if (hold) await new Promise<void>((resolve: () => void): void => { release = resolve; });
      return json({ generatedAt: calls });
    });
    const drain = async (): Promise<void> => {
      for (let turn: number = 0; turn < 6; turn += 1) {
        Bun.sleepSync(2);
        await new Promise<void>((resolve: () => void): void => {
          setImmediate(resolve);
        });
      }
    };
    const advance = async (ms: number): Promise<void> => {
      jest.advanceTimersByTime(ms);
      await drain();
    };
    try {
      const store = createStatusStore();
      store.getState().startPolling();
      await drain();
      expect(calls).toBe(1);
      await advance(MINI_APP_MIN_LOADING_MS);
      expect(store.getState().status?.generatedAt).toBe(1);
      await advance(MINI_APP_STATUS_POLL_INTERVAL_MS - 1);
      expect(calls).toBe(1);

      hold = true;
      await advance(1);
      expect(calls).toBe(2);
      await advance(MINI_APP_STATUS_POLL_INTERVAL_MS * 5);
      expect(calls).toBe(2);
      hold = false;
      release();
      await drain();
      await advance(MINI_APP_STATUS_POLL_INTERVAL_MS);
      expect(calls).toBe(3);

      webApp.isActive = false;
      telegramHandlers.get("deactivated")?.();
      await advance(MINI_APP_STATUS_POLL_INTERVAL_MS * 5);
      expect(calls).toBe(3);
      webApp.isActive = true;
      telegramHandlers.get("activated")?.();
      await drain();
      expect(calls).toBe(4);

      page.visibilityState = "hidden";
      visibility.listener?.();
      await advance(MINI_APP_STATUS_POLL_INTERVAL_MS * 5);
      expect(calls).toBe(4);
      page.visibilityState = "visible";
      visibility.listener?.();
      await drain();
      expect(calls).toBe(5);

      store.getState().stopPolling();
      expect(telegramHandlers.size).toBe(0);
      expect(visibility.listener).toBeNull();
      await advance(MINI_APP_STATUS_POLL_INTERVAL_MS * 5);
      expect(calls).toBe(5);
    } finally {
      (globalThis as { document?: unknown }).document = undefined;
    }
  });

  test("受管群：选群加载详情，关闭 /init 需确认，移出列表后回到列表并重载", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    route("GET /api/chats", (): Response => json({ items: [{ chatId: -100 }] }));
    route("GET /api/chats/detail", (): Response => json({ detail: { chatId: -100 } }));
    await resolveWithFakeTimers(store.getState().loadChatList());
    expect(store.getState().chats).toEqual([{ chatId: -100 }] as never);

    store.getState().selectChat(-100);
    expect(store.getState().selectedChatId).toBe(-100);
    expect(store.getState().botPermsExpanded).toBeFalse();
    store.getState().toggleBotPerms();
    expect(store.getState().botPermsExpanded).toBeTrue();
    store.getState().toggleBotPerms();
    expect(store.getState().botPermsExpanded).toBeFalse();
    expect(store.getState().loadingDetail).toBeTrue();
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail !== null);
    expect(store.getState().chatDetail?.chatId).toBe(-100);

    route("POST /api/chats/feature", (): Response =>
      json({ ok: true, message: "off", removedFromList: true, detail: null }));
    const declined: Promise<void> = store.getState().toggleFeature("init", false);
    expect(useMiniAppStore.getState().confirmModal?.message).toBe(zh.chats.confirmDisableInit);
    useMiniAppStore.getState().resolveConfirm(false);
    await declined;
    expect(fetchCalls.some((call: string): boolean => call.startsWith("POST"))).toBeFalse();

    const accepted: Promise<void> = store.getState().toggleFeature("init", false);
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(accepted);
    expect(store.getState().selectedChatId).toBeNull();
    expect(store.getState().togglingFeature).toBeNull();
    expect(useMiniAppStore.getState().toastText).toBe("off");
    await flushFakeTimersUntil((): boolean => !store.getState().loadingList && fetchCalls.filter((call: string): boolean => call === "GET /api/chats").length === 2);
    expect(fetchCalls.filter((call: string): boolean => call === "GET /api/chats")).toHaveLength(2);

    store.getState().setChatPage(3);
    expect(store.getState().loadingList).toBeTrue();
    store.getState().setChatPageSize(20);
    expect(store.getState().chatPage).toBe(1);
    expect(store.getState().chatPageSize).toBe(20);
    expect(store.getState().loadingList).toBeTrue();
    expect(MINI_APP_PAGINATION_HOVER_DURATION_MS).toBeGreaterThan(0);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingList);
    expect(store.getState().loadingList).toBeFalse();
  });

  test("热发言记录与名单：服务端夹紧页码时同步当前页码且后续 effect 不重复请求", async () => {
    const store = createMessagesStore();
    route("GET /api/chats/messages", (url: URL): Response =>
      json({ page: 2, pageSize: Number(url.searchParams.get("pageSize")), items: [] }));
    await store.getState().loadMessages(-100, 9, 15);
    await store.getState().loadMessages(-100, store.getState().pageNumber, 15);
    expect(fetchCalls).toEqual(["GET /api/chats/messages?chatId=-100&page=9&pageSize=15"]);
    expect(store.getState().pageNumber).toBe(2);
    expect(store.getState().pageData?.pageSize).toBe(15);
    store.getState().setPageSize(20);
    expect(store.getState().pageNumber).toBe(1);

    const identities = createIdentitiesStore();
    identities.getState().setWhitelistPageNumber(5);
    route("GET /api/identities/whitelist", (): Response =>
      json({ page: 1, items: [], whitelistTotal: 0, blocklistTotal: 0 }));
    await identities.getState().loadCurrentList();
    await identities.getState().loadCurrentList();
    expect(identities.getState().whitelistPageNumber).toBe(1);
    expect(fetchCalls.filter((c: string): boolean => c.startsWith("GET /api/identities/whitelist"))).toHaveLength(1);

    identities.getState().selectSubTab("blocklist");
    identities.getState().setBlocklistPageNumber(4);
    route("GET /api/identities/blocklist", (): Response =>
      json({ page: 1, items: [], whitelistTotal: 0, blocklistTotal: 0 }));
    await identities.getState().loadCurrentList();
    await identities.getState().loadCurrentList();
    expect(identities.getState().blocklistPageNumber).toBe(1);
    expect(fetchCalls.filter((c: string): boolean => c.startsWith("GET /api/identities/blocklist"))).toHaveLength(1);
  });

  test("名单：搜索词变化才回到第 1 页，按 ID 添加的校验、判重与成功回执", async () => {
    const store = createIdentitiesStore();
    store.getState().setWhitelistPageNumber(3);
    store.getState().commitSearchQuery("");
    expect(store.getState().whitelistPageNumber).toBe(3);
    store.getState().commitSearchQuery("doro");
    expect(store.getState().whitelistPageNumber).toBe(1);
    expect(store.getState().debouncedQuery).toBe("doro");
    store.getState().clearSearch();
    expect(store.getState().debouncedQuery).toBe("");

    store.getState().setIdInput("abc");
    await store.getState().addById();
    expect(useMiniAppStore.getState().toastText).toBe(zh.identities.invalidIdToast);
    expect(useMiniAppStore.getState().toastTone).toBe("warning");
    for (const looseNumber of ["0x1F", "1e3", "12.0", "+5"]) {
      useMiniAppStore.getState().clearToast();
      store.getState().setIdInput(looseNumber);
      await store.getState().addById();
      expect(useMiniAppStore.getState().toastText).toBe(zh.identities.invalidIdToast);
    }
    expect(fetchCalls.filter((call: string): boolean => call.startsWith("POST "))).toEqual([]);

    route("GET /api/identities/whitelist", (): Response =>
      json({ page: 1, items: [{ id: 7 }], whitelistTotal: 1, blocklistTotal: 0 }));
    await store.getState().loadCurrentList();
    expect(store.getState().loadingList).toBeFalse();
    const silentLoad: Promise<void> = store.getState().loadCurrentList(true);
    expect(store.getState().loadingList).toBeFalse();
    await silentLoad;
    route("POST /api/identities/whitelist", (): Response =>
      json({ ok: true, changed: false, duplicate: true, message: "WHITELIST_DUPLICATE" }));
    store.getState().setIdInput("7");
    await store.getState().addById();
    expect(fetchCalls.filter((call: string): boolean => call === "POST /api/identities/whitelist")).toHaveLength(1);
    expect(store.getState().duplicateAlertText).toBe(zh.identities.duplicateToast("ID 7", "whitelist"));

    route("POST /api/identities/whitelist", (): Response =>
      json({ ok: true, changed: true, message: "added" }));
    store.getState().setIdInput("8");
    store.getState().toggleAddMenu();
    await store.getState().addById();
    expect(store.getState().duplicateAlertText).toBeNull();
    expect(store.getState().selectedEntryId).toBe(8);
    expect(store.getState().addMenuOpen).toBeFalse();
    expect(store.getState().idInput).toBe("");
    expect(store.getState().busyAction).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe("added");

    store.getState().selectSubTab("blocklist");
    expect(store.getState().selectedEntryId).toBeNull();
    store.getState().selectAddMode("users");
    expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerUnsupportedHint);
  });

  test("名单：移出白名单需确认，并收起被移出条目的权限抽屉", async () => {
    const store = createIdentitiesStore();
    route("POST /api/identities/whitelist", (): Response =>
      json({ ok: true, changed: true, message: "removed" }));
    route("GET /api/identities/whitelist", (): Response =>
      json({ page: 1, items: [], whitelistTotal: 0, blocklistTotal: 0 }));
    store.getState().togglePermissionDrawer(9);
    const entry = { id: 9, displayName: "Doro" } as never;
    const removal: Promise<void> = store.getState().removeWhitelist(entry);
    expect(useMiniAppStore.getState().confirmModal?.message).toBe(
      zh.identities.confirmRemoveWhitelist("Doro", 9)
    );
    useMiniAppStore.getState().resolveConfirm(true);
    await removal;
    expect(store.getState().selectedEntryId).toBeNull();
    expect(useMiniAppStore.getState().toastText).toBe("removed");
  });

  test("权限抽屉：成功回执后通知父组件重载，失败只报错", async () => {
    let updated: number = 0;
    const store = createPermissionDrawerStore(async (): Promise<void> => {
      updated += 1;
    });
    route("POST /api/identities/permission", (_url: URL, init: RequestInit | undefined): Response =>
      json({ ok: true, changed: true, message: String(init?.body) }));
    const togglePromise: Promise<void> = store.getState().togglePermission(5, "all", true);
    expect(store.getState().busyKey).toBe("all");
    await togglePromise;
    expect(useMiniAppStore.getState().toastText).toBe(JSON.stringify({ id: 5, enableAll: true }));
    expect(updated).toBe(1);
    expect(store.getState().busyKey).toBeNull();

    route("POST /api/identities/permission", (): Response => json({ error: "denied" }, 400));
    await store.getState().togglePermission(5, "all", true);
    expect(useMiniAppStore.getState().toastText).toBe("denied");
    expect(updated).toBe(1);
  });

  test("图库：成功加载开启新批次，缩略图在最短时长后标记加载完成，翻页、删除与上传回执", async () => {
    jest.useFakeTimers();
    const store = createGalleryStore();
    route("GET /api/gallery", (url: URL): Response =>
      json({ page: Number(url.searchParams.get("page")), items: [], exists: true }));
    await resolveWithFakeTimers(store.getState().loadGallery(1, 10));
    expect(store.getState().batchEpoch).toBe(1);
    store.getState().markThumbLoaded("a.png", 0);
    store.getState().markThumbLoaded("a.png", 1);
    await flushFakeTimersUntil((): boolean => store.getState().loadedImages["a.png"] === true);
    expect(store.getState().loadedImages).toEqual({ "a.png": true });

    store.getState().setPreviewItem({ fileName: "a.png" } as never);
    store.getState().changePage(2);
    expect(store.getState().previewItem).toBeNull();
    await flushFakeTimersUntil((): boolean => !store.getState().loading && store.getState().page === 2);
    expect(store.getState().page).toBe(2);

    route("POST /api/gallery/delete", (): Response => json({ ok: true, outcome: "deleted", message: "x" }));
    const deletion: Promise<void> = store.getState().deleteImage("a.png");
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(deletion);
    expect(useMiniAppStore.getState().toastText).toBe(zh.gallery.deletedToast("a.png"));
    expect(store.getState().deletingFileName).toBeNull();

    route("POST /api/gallery/upload", (): Response => json({ ok: true, outcome: "added", message: "ok" }));
    await resolveWithFakeTimers(store.getState().uploadFiles([new File([new Uint8Array([1])], "x.png"), new File([new Uint8Array([2])], "y.png")]));
    expect(useMiniAppStore.getState().toastText).toBe("+2 · =0 · !0");
    expect(store.getState().uploading).toBeFalse();
    expect(store.getState().uploadStatusText).toBeNull();
    expect(store.getState().page).toBe(1);

    fetchCalls.length = 0;
    await store.getState().uploadFiles([]);
    await store.getState().uploadFiles([new File([], "empty.png")]);
    expect(fetchCalls).toEqual([]);
    expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("GALLERY_IMAGE_EMPTY"));
    expect(useMiniAppStore.getState().toastTone).toBe("warning");

    await store.getState().uploadFiles([new File([new Uint8Array(RANDOM_IMAGE_MAX_BYTES + 1)], "huge.png")]);
    expect(fetchCalls).toEqual([]);
    expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("GALLERY_IMAGE_TOO_LARGE"));

    route("POST /api/gallery/upload", (): Response => json({ error: "disk full" }, 500));
    await resolveWithFakeTimers(store.getState().uploadFiles([new File([new Uint8Array([1])], "err.png")]));
    expect(useMiniAppStore.getState().toastText).toBe("disk full");
    expect(useMiniAppStore.getState().toastTone).toBe("warning");

    route("POST /api/gallery/upload", (): Response =>
      json({ ok: false, outcome: "unsupportedFormat", message: "GALLERY_UNSUPPORTED_FORMAT" }, 400));
    await resolveWithFakeTimers(store.getState().uploadFiles([new File([new Uint8Array([1])], "bad.gif"), new File([], "empty.png")]));
    expect(useMiniAppStore.getState().toastText).toBe(`+0 · =0 · !2 · ${zh.serverNotice("GALLERY_UNSUPPORTED_FORMAT")}`);
    expect(useMiniAppStore.getState().toastTone).toBe("warning");

    fetchCalls.length = 0;
    useMiniAppStore.setState({ gateState: "unlocked" });
    route("POST /api/gallery/upload", (): Response =>
      json({ code: "PASSWORD_REQUIRED", error: "expired" }, 401));
    await resolveWithFakeTimers(store.getState().uploadFiles([new File([new Uint8Array([1])], "x.png"), new File([new Uint8Array([2])], "y.png")]));
    expect(fetchCalls).toEqual(["POST /api/gallery/upload"]);
    expect(useMiniAppStore.getState().gateState).toBe("password");
  });

  test("验证器：拉取状态同步登录模式，失败时报错且不渲染未启用，动态码格式不符就地提示，删除需确认", async () => {
    const failedStore = createTotpStore();
    route("GET /api/totp", (): Response => json({ error: "totp read failed" }, 500));
    await failedStore.getState().loadTotpStatus();
    expect(useMiniAppStore.getState().toastText).toBe("totp read failed");
    expect(renderToStaticMarkup(createElement(TotpPage, { storeFactory: () => failedStore }))).not.toContain(zh.totp.disabledBadge);

    const store = createTotpStore();
    route("GET /api/totp", (): Response => json({ enabled: true, createdAt: 1, maskedSecret: "AB••" }));
    await store.getState().loadTotpStatus();
    expect(store.getState().totpStatus?.enabled).toBeTrue();
    expect(store.getState().loadingStatus).toBeFalse();
    expect(useMiniAppStore.getState().authMode).toBe("totp");

    store.getState().setCodeInput("12");
    await store.getState().verifyEnable();
    expect(useMiniAppStore.getState().toastText).toBe(zh.gate.totpEmptyHint);

    route("DELETE /api/totp", (): Response =>
      json({ ok: true, message: "gone", status: { enabled: false, createdAt: null, maskedSecret: null } }));
    const deletion: Promise<void> = store.getState().deleteTotp();
    expect(useMiniAppStore.getState().confirmModal?.message).toBe(zh.totp.confirmDeleteTotp);
    useMiniAppStore.getState().resolveConfirm(true);
    await deletion;
    expect(store.getState().totpStatus?.enabled).toBeFalse();
    expect(useMiniAppStore.getState().authMode).toBe("password");
    expect(useMiniAppStore.getState().toastText).toBe("gone");
  });

  test("受管群：详情与热发言视图切换会重载对应数据，加载失败以 Toast 报错", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    route("GET /api/chats", (): Response => json({ error: "list down" }, 500));
    route("GET /api/chats/detail", (): Response => json({ detail: { chatId: -100 } }));
    await resolveWithFakeTimers(store.getState().loadChatList());
    expect(store.getState().loadingList).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe("list down");

    store.getState().selectChat(-100);
    store.getState().openMessages();
    expect(store.getState().viewingMessages).toBeTrue();
    store.getState().closeMessages();
    expect(store.getState().viewingMessages).toBeFalse();
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && fetchCalls.filter((call: string): boolean => call === "GET /api/chats/detail?chatId=-100").length === 2);
    expect(fetchCalls.filter((call: string): boolean => call === "GET /api/chats/detail?chatId=-100")).toHaveLength(2);

    route("POST /api/chats/feature", (): Response =>
      json({ ok: true, message: "on", removedFromList: false, detail: { chatId: -100, title: "x" } }));
    await resolveWithFakeTimers(store.getState().toggleFeature("aiChat", true));
    expect(useMiniAppStore.getState().confirmModal).toBeNull();
    expect(store.getState().chatDetail?.title).toBe("x");

    store.getState().setBatchKickHours(0);
    expect(store.getState().batchKickHours).toBe(MINI_APP_BATCH_KICK_MIN_HOURS);
    store.getState().setBatchKickHours(99);
    expect(store.getState().batchKickHours).toBe(MINI_APP_BATCH_KICK_MAX_HOURS);
    expect(store.getState().loadingWindowJoined).toBeTrue();
    store.getState().setBatchKickHours(Number.NaN);
    expect(store.getState().batchKickHours).toBe(MINI_APP_BATCH_KICK_MIN_HOURS);
    route("GET /api/chats/detail", (): Response =>
      json({ detail: { chatId: -100, title: "x", joinedCountsByHour: Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (_: unknown, i: number): number => i + 10), batchKickRunning: false, lastBatchKickCompletion: null } }));
    store.getState().setBatchKickHours(6);
    expect(store.getState().batchKickHours).toBe(6);
    expect(store.getState().loadingWindowJoined).toBeTrue();
    await flushFakeTimersUntil((): boolean => !store.getState().loadingWindowJoined, MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS);
    expect(store.getState().loadingWindowJoined).toBeFalse();
    expect(store.getState().chatDetail?.joinedCountsByHour[5]).toBe(15);

    const detailCallsBeforeCancel: number = fetchCalls.filter((call: string): boolean => call === "GET /api/chats/detail?chatId=-100").length;
    store.getState().setBatchKickHours(12);
    expect(store.getState().batchKickHours).toBe(12);
    expect(store.getState().loadingWindowJoined).toBeTrue();
    store.getState().cancelPendingRefresh();
    jest.advanceTimersByTime(MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS + 60);
    await drainImmediate();
    expect(fetchCalls.filter((call: string): boolean => call === "GET /api/chats/detail?chatId=-100").length).toBe(detailCallsBeforeCancel);
    store.getState().setBatchKickHours(6);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingWindowJoined, MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS);

    const declinedKick: Promise<void> = store.getState().runBatchKick();
    expect(useMiniAppStore.getState().confirmModal?.message).toBe(zh.chats.confirmBatchKick(6));
    useMiniAppStore.getState().resolveConfirm(false);
    await declinedKick;
    expect(fetchCalls.some((call: string): boolean => call.includes("/batch-kick"))).toBeFalse();

    route("POST /api/chats/batch-kick", (): Response =>
      json({ ok: true, outcome: "accepted", hours: 6, recordCount: 5, message: "BATCH_KICK_ACCEPTED", detail: { chatId: -100, title: "x", joinedCountsByHour: Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (): number => 5), batchKickRunning: true, lastBatchKickCompletion: null } }));
    const acceptedKick: Promise<void> = store.getState().runBatchKick();
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(acceptedKick);
    expect(store.getState().batchKickSubmitting).toBeFalse();
    expect(store.getState().chatDetail?.batchKickRunning).toBeTrue();
    expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("BATCH_KICK_ACCEPTED", { hours: 6, recordCount: 5 }));
    expect(useMiniAppStore.getState().toastTone).toBe("info");

    const completion = {
      hours: 6, recordCount: 5, scanned: 5, kicked: 4, absent: 1, protected: 0,
      blocked: 0, forbidden: 0, failed: 0, aborted: false, unmanaged: false, completedAt: 1_700_000_000_000,
    };
    route("GET /api/chats/detail", (): Response =>
      json({ detail: { chatId: -100, title: "x", joinedCountsByHour: Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (): number => 1), batchKickRunning: false, lastBatchKickCompletion: completion } }));
    await store.getState().pollRunningBatchKick();
    expect(store.getState().chatDetail?.batchKickRunning).toBeFalse();
    expect(store.getState().chatDetail?.lastBatchKickCompletion).toEqual(completion);
    expect(useMiniAppStore.getState().toastText).toBe(zh.chats.batchKickCompletedSummary(completion));
    jest.advanceTimersByTime(MINI_APP_TOAST_DURATION_MS);
    expect(useMiniAppStore.getState().toastText).toBe("");

    route("POST /api/chats/batch-kick", (): Response =>
      json({ ok: true, outcome: "empty", hours: 6, recordCount: 0, message: "BATCH_KICK_EMPTY", detail: { chatId: -100, title: "x", joinedCountsByHour: Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (): number => 0), batchKickRunning: false } }));
    const emptyKick: Promise<void> = store.getState().runBatchKick();
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(emptyKick);
    expect(useMiniAppStore.getState().toastTone).toBe("warning");

    route("POST /api/chats/batch-kick", (): Response => json({ error: "kick failed" }, 503));
    const failedKick: Promise<void> = store.getState().runBatchKick();
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(failedKick);
    expect(useMiniAppStore.getState().toastText).toBe("kick failed");
    expect(useMiniAppStore.getState().toastTone).toBe("warning");

    route("GET /api/chats", (): Response => json({ items: [] }));
    route("GET /api/chats/detail", (): Response => json({ error: "detail down" }, 500));
    store.getState().closeDetail();
    expect(store.getState().selectedChatId).toBeNull();
    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail);
    expect(useMiniAppStore.getState().toastText).toBe("detail down");
    expect(store.getState().loadingDetail).toBeFalse();

    const emptyTargets = {
      chatId: -100, qaItems: [], qaMax: CHAT_QA_MAX_PER_CHAT,
      qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS, qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
      deleteMessageTargets: [], deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
      translateTargets: [], translateMax: TRANSLATE_CHAT_USER_LIMIT, isTranslationEnabled: true,
    };
    route("GET /api/chats/targets", (): Response => json({ targets: emptyTargets }));
    store.getState().toggleTargetsMenu();
    expect(store.getState().targetsMenuOpen).toBeTrue();
    store.getState().closeTargetsMenu();
    expect(store.getState().targetsMenuOpen).toBeFalse();
    store.getState().openTargetsModal("qa");
    expect(store.getState().activeTargetsModal).toBe("qa");
    expect(store.getState().qaEditorOpen).toBeFalse();
    await flushFakeTimersUntil((): boolean => !store.getState().loadingTargets && store.getState().chatTargets !== null);
    expect(store.getState().chatTargets?.qaItems).toEqual([]);
    store.getState().openQaEditor();
    expect(store.getState().qaEditorOpen).toBeTrue();
    store.getState().setQaQuestionInput("draft-q");
    store.getState().setQaAnswerInput("draft-a");
    store.getState().closeQaEditor();
    expect(store.getState().qaEditorOpen).toBeFalse();
    expect(store.getState().qaQuestionInput).toBe("");
    expect(store.getState().qaAnswerInput).toBe("");

    store.getState().openQaEditor();
    expect(store.getState().qaEditorOpen).toBeTrue();
    store.getState().switchTargetsModalTab("deleteMessage");
    expect(store.getState().activeTargetsModal).toBe("deleteMessage");
    expect(store.getState().qaEditorOpen).toBeFalse();
    expect(store.getState().targetAddMenuOpen).toBeFalse();
    store.getState().openTargetAddMenu();
    expect(store.getState().targetAddMenuOpen).toBeTrue();
    store.getState().selectTargetAddMode("id");
    expect(store.getState().targetIdFormOpen).toBeTrue();
    store.getState().selectTargetAddMode("id");
    expect(store.getState().targetIdFormOpen).toBeFalse();
    store.getState().closeTargetAddMenu();
    expect(store.getState().targetAddMenuOpen).toBeFalse();
    store.getState().selectTargetAddMode("users");
    expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerUnsupportedHint);

    store.getState().fillQaPairForEdit("q1", "a1");
    expect(store.getState().qaEditorOpen).toBeTrue();
    expect(store.getState().qaQuestionInput).toBe("q1");
    expect(store.getState().qaAnswerInput).toBe("a1");
    expect(store.getState().qaEditSourceQuestion).toBe("q1");
    const renameHint: string = zh.chats.qaRenameKeepsOriginalHint("q1");
    expect(renderToStaticMarkup(createElement(ChatTargetsQaEditorForm, { state: store.getState(), t: zh })))
      .not.toContain(renameHint);
    store.getState().setQaQuestionInput("q1-renamed");
    expect(renderToStaticMarkup(createElement(ChatTargetsQaEditorForm, { state: store.getState(), t: zh })))
      .toContain(renameHint);
    store.getState().setQaQuestionInput(" q1 ");
    expect(renderToStaticMarkup(createElement(ChatTargetsQaEditorForm, { state: store.getState(), t: zh })))
      .not.toContain(renameHint);
    store.getState().setQaQuestionInput("q1");

    route("POST /api/chats/targets", (_url: URL, init?: RequestInit): Response => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { readonly action: string };
      return json({
        ok: true, message: body.action === "setQa" ? "QA_ADDED" : "QA_REMOVED",
        detail: { chatId: -100, title: "x" },
        targets: { ...emptyTargets, qaItems: body.action === "setQa" ? [{ q: "q1", a: "a1" }] : [] },
      });
    });
    await resolveWithFakeTimers(store.getState().submitQaPair());
    expect(store.getState().qaEditorOpen).toBeFalse();
    expect(store.getState().qaQuestionInput).toBe("");
    expect(store.getState().qaAnswerInput).toBe("");
    expect(store.getState().qaEditSourceQuestion).toBeNull();
    expect(store.getState().chatTargets?.qaItems).toEqual([{ q: "q1", a: "a1" }]);
    const declinedQaDelete: Promise<void> = store.getState().removeQaPair("q1");
    expect(useMiniAppStore.getState().confirmModal?.message).toBe(zh.chats.confirmDeleteQa("q1"));
    useMiniAppStore.getState().resolveConfirm(false);
    await declinedQaDelete;
    expect(store.getState().chatTargets?.qaItems).toEqual([{ q: "q1", a: "a1" }]);

    const acceptedQaDelete: Promise<void> = store.getState().removeQaPair("q1");
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(acceptedQaDelete);
    expect(store.getState().chatTargets?.qaItems).toEqual([]);

    store.getState().setDeleteTargetInput("7001");
    await resolveWithFakeTimers(store.getState().submitDeleteTarget());
    expect(store.getState().deleteTargetInput).toBe("");
    const declinedDeleteTarget: Promise<void> = store.getState().removeDeleteTarget(7001);
    expect(useMiniAppStore.getState().confirmModal?.message).toBe(zh.chats.confirmRemoveDeleteTarget("ID 7001", 7001));
    useMiniAppStore.getState().resolveConfirm(false);
    await declinedDeleteTarget;
    const acceptedDeleteTarget: Promise<void> = store.getState().removeDeleteTarget(7001);
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(acceptedDeleteTarget);

    store.getState().setTranslateTargetInput("7002");
    store.getState().toggleTranslateLangMenu();
    expect(store.getState().translateLangMenuOpen).toBeTrue();
    store.getState().closeTranslateLangMenu();
    expect(store.getState().translateLangMenuOpen).toBeFalse();
    store.getState().toggleTranslateLangMenu();
    store.getState().setTranslateLanguageInput("en");
    expect(store.getState().translateLangMenuOpen).toBeFalse();
    await resolveWithFakeTimers(store.getState().submitTranslateTarget());
    expect(store.getState().translateTargetInput).toBe("");
    const declinedTranslateTarget: Promise<void> = store.getState().removeTranslateTarget(7002);
    expect(useMiniAppStore.getState().confirmModal?.message).toBe(zh.chats.confirmRemoveTranslateTarget("ID 7002", 7002));
    useMiniAppStore.getState().resolveConfirm(false);
    await declinedTranslateTarget;
    const acceptedTranslateTarget: Promise<void> = store.getState().removeTranslateTarget(7002);
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(acceptedTranslateTarget);

    store.getState().closeTargetsModal();
    expect(store.getState().activeTargetsModal).toBeNull();
  });

  test("热发言记录与状态看板：加载失败以 Toast 报错，情绪不可用时清空当前情绪", async () => {
    const messages = createMessagesStore();
    route("GET /api/chats/messages", (): Response => json({ error: "no init" }, 404));
    await messages.getState().loadMessages(-100, 1, 10);
    expect(useMiniAppStore.getState().toastText).toBe("no init");
    expect(messages.getState().loading).toBeFalse();
    messages.getState().setPageNumber(4);
    expect(messages.getState().pageNumber).toBe(4);

    const status = createStatusStore();
    route("GET /api/mood", (): Response => json({ ok: true, available: false, currentMood: null }));
    await status.getState().loadMood();
    expect(status.getState().currentMood).toBeNull();
    route("GET /api/mood", (): Response => json({ error: "x" }, 500));
    await status.getState().loadMood();
    route("POST /api/mood/switch", (): Response => json({ error: "worker down" }, 503));
    await status.getState().switchMood();
    expect(status.getState().switchingMood).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe("worker down");
  });

  test("名单：原生选择器回执含重复项时展示拦截横幅，取消或无重复时以 Toast 回报；黑名单移出与分页", async () => {
    jest.useFakeTimers();
    const store = createIdentitiesStore();
    const chatCallbacks: ((accepted: boolean) => void)[] = [];
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: {
        requestChat: (_id: string, callback: (accepted: boolean) => void): void => {
          chatCallbacks.push(callback);
        },
      },
    };
    route("POST /api/picker/prepare", (): Response => json({ ok: true, requestId: 11, preparedButtonId: "btn" }));
    route("GET /api/identities/whitelist", (): Response =>
      json({ page: 1, items: [], whitelistTotal: 0, blocklistTotal: 0 }));
    let polls: number = 0;
    route("GET /api/picker/result", (): Response => {
      polls += 1;
      return json({ result: polls < 2 ? null : { requestId: 11, duplicateIds: [5, 6], summary: "dup" } });
    });
    store.getState().toggleAddMenu();
    store.getState().selectAddMode("users");
    await flushUntil((): boolean => chatCallbacks.length === 1 && !store.getState().busyAction);
    expect(store.getState().addMenuOpen).toBeFalse();
    expect(store.getState().busyAction).toBeFalse();
    chatCallbacks[0]?.(false);
    expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerCancelledToast);
    chatCallbacks[0]?.(true);
    expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerWaitingToast);
    await flushFakeTimersUntil((): boolean => store.getState().duplicateAlertText !== null, MINI_APP_PICKER_POLL_INTERVAL_MS);
    expect(store.getState().duplicateAlertText).toBe(zh.identities.duplicateToast("ID 5, ID 6", "whitelist"));
    store.getState().dismissDuplicateAlert();
    expect(store.getState().duplicateAlertText).toBeNull();

    store.getState().selectSubTab("blocklist");
    route("GET /api/identities/blocklist", (): Response =>
      json({ page: 1, items: [], whitelistTotal: 1, blocklistTotal: 0 }));
    route("GET /api/picker/result", (): Response =>
      json({ result: { requestId: 11, targetList: "blocklist", addedIds: [], skippedIds: [77001], duplicateIds: [], summary: "IDENTITY_IN_WHITELIST" } }));
    store.getState().selectAddMode("users");
    await flushUntil((): boolean => chatCallbacks.length === 2 && !store.getState().busyAction);
    chatCallbacks[1]?.(true);
    const expectedConflictToast: string = zh.serverNotice("IDENTITY_IN_WHITELIST", { id: 77001 });
    await flushFakeTimersUntil((): boolean => useMiniAppStore.getState().toastText === expectedConflictToast, MINI_APP_PICKER_POLL_INTERVAL_MS);
    expect(useMiniAppStore.getState().toastText).toBe(expectedConflictToast);
    expect(useMiniAppStore.getState().toastTone).toBe("warning");

    store.getState().selectAddMode("id");
    expect(store.getState().idFormOpen).toBeTrue();
    store.getState().closeIdForm();
    expect(store.getState().idFormOpen).toBeFalse();
    store.getState().setSearchInput("abc");
    expect(store.getState().searchInput).toBe("abc");

    store.getState().selectSubTab("blocklist");
    store.getState().setBlocklistPageNumber(4);
    store.getState().setBlocklistPageSize(20);
    expect(store.getState().blocklistPageNumber).toBe(1);
    store.getState().setWhitelistPageSize(15);
    expect(store.getState().whitelistPageSize).toBe(15);
    route("POST /api/identities/blocklist", (): Response => json({ ok: true, changed: true, message: "unblocked" }));
    route("GET /api/identities/blocklist", (): Response =>
      json({ page: 2, items: [], whitelistTotal: 0, blocklistTotal: 3 }));
    const removal: Promise<void> = store.getState().removeBlocklist({ id: 4, displayName: "Spam" } as never);
    expect(useMiniAppStore.getState().confirmModal?.message).toBe(zh.identities.confirmRemoveBlocklist("Spam", 4));
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(removal);
    expect(useMiniAppStore.getState().toastText).toBe("unblocked");
    expect(store.getState().blocklistTotal).toBe(3);
    expect(store.getState().blocklistPageNumber).toBe(2);
    store.getState().closePermissionDrawer();
    expect(store.getState().selectedEntryId).toBeNull();
  });

  test("图库：预览周期内只采纳当前预览的加载回调，下载成功回报文件名，删除失败回报服务端说明", async () => {
    jest.useFakeTimers();
    const store = createGalleryStore();
    store.getState().setPreviewItem({ fileName: "a.png", sizeBytes: 100, updatedAt: "2026-04-12 00:00:00", mimeType: "image/png" });
    expect(store.getState().previewLoaded).toBeFalse();
    store.getState().markPreviewLoaded();
    store.getState().markPreviewLoaded();
    await flushFakeTimersUntil((): boolean => store.getState().previewLoaded);
    store.getState().setPreviewItem({ fileName: "b.png", sizeBytes: 200, updatedAt: "2026-04-12 00:00:01", mimeType: "image/png" });
    expect(store.getState().previewLoaded).toBeFalse();
    store.getState().markPreviewLoaded();
    await flushFakeTimersUntil((): boolean => store.getState().previewLoaded);
    store.getState().setPreviewItem(null);
    expect(store.getState().previewItem).toBeNull();
    expect(store.getState().previewLoaded).toBeTrue();

    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { isVersionAtLeast: (): boolean => true, downloadFile: (_p: unknown, cb: (ok: boolean) => void): void => cb(true) },
    };
    route("POST /api/gallery/download-ticket", (): Response =>
      json({ ok: true, ticket: "t".repeat(64), expiresAt: Date.now() + 60_000, downloadFileName: "copy-ninja-a.png" }));
    await store.getState().downloadImage("a.png");
    expect(store.getState().downloadingFileName).toBeNull();
    expect(useMiniAppStore.getState().toastText.length).toBeGreaterThan(0);

    route("POST /api/gallery/delete", (): Response => json({ ok: false, outcome: "notFound", message: "gone already" }, 200));
    const deletion: Promise<void> = store.getState().deleteImage("b.png");
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(deletion);
    expect(useMiniAppStore.getState().toastText).toBe("gone already");

    route("GET /api/gallery", (): Response => json({ error: "dir error" }, 500));
    store.getState().changePageSize(20);
    expect(store.getState().pageSize).toBe(20);
    await resolveWithFakeTimers(store.getState().loadGallery());
    expect(useMiniAppStore.getState().toastText).toBe("dir error");
    expect(store.getState().loading).toBeFalse();
  });

  test("验证器：生成二维码进入绑定流程，取消清空，校验成功后同步登录模式", async () => {
    const store = createTotpStore();
    route("POST /api/totp/setup", (): Response => json({ ok: true, secret: "S", otpauthUri: "u", qrSvg: "<svg/>", expiresAt: 1 }));
    await store.getState().startSetup();
    expect(store.getState().setupData?.secret).toBe("S");
    store.getState().setCodeInput("12");
    store.getState().cancelSetup();
    expect(store.getState().setupData).toBeNull();
    expect(store.getState().codeInput).toBe("");

    route("POST /api/totp/enable", (): Response =>
      json({ ok: true, message: "bound", status: { enabled: true, createdAt: 2, maskedSecret: "S•" } }));
    store.getState().setCodeInput("123456");
    await store.getState().verifyEnable();
    expect(store.getState().totpStatus?.enabled).toBeTrue();
    expect(useMiniAppStore.getState().authMode).toBe("totp");
    expect(useMiniAppStore.getState().toastText).toBe("bound");

    route("POST /api/totp/setup", (): Response => json({ error: "setup failed" }, 500));
    await store.getState().startSetup();
    expect(useMiniAppStore.getState().toastText).toBe("setup failed");
    expect(store.getState().busy).toBeFalse();
  });

});
