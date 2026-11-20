/**
 * Mini App 前端 store 竞态与退场守卫：登录后的本机到期时刻、手动锁定与 Toast 定时器生命周期、
 * 受管群变更与目标弹窗静默刷新、跨子标签添加与黑名单移出静默刷新，
 * 以及验证器待绑定密钥作废后的收起。`fetch` 按「方法 + 路径」路由到测试夹具。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  resolveChatTargetsModalPanelState,
} from "../../packages/mini-app-frontend/components/ChatTargetsModal";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_SESSION_HEADER,
  MINI_APP_TOAST_DURATION_MS,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  extractServerNoticeParams,
  getMiniAppTranslations,
} from "../../packages/mini-app-frontend/i18n";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createIdentitiesStore } from "../../packages/mini-app-frontend/store/identities";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  seedTestMiniAppSession,
  TEST_SESSION_KEY,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";
import {
  drainImmediate,
  flushFakeTimersUntil,
  flushUntil,
  resolveWithFakeTimers,
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

describe("根 store 会话", () => {
  test("登录：空输入与非 6 位动态码就地报错，成功解锁，锁定转拦截页，其余错误留在门禁", async () => {
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().passwordError).toBe(zh.gate.passwordEmptyHint);

    useMiniAppStore.setState({ authMode: "totp", passwordInput: "12a" });
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().passwordError).toBe(zh.gate.totpEmptyHint);
    expect(fetchCalls).toEqual([]);

    // 服务端绝对到期时刻在本机时钟看来已过去（本机时钟快 2 小时）：本机到期时刻按 ttlMs 计算，不受影响。
    const skewedServerExpiresAt: number = Date.now() - 2 * 3_600_000;
    let locked: boolean = false;
    route("GET /api/auth/precheck", (): Response =>
      locked
        ? json({ ok: false, code: "PASSWORD_LOCKED", error: "locked" }, 403)
        : json({ ok: true })
    );
    route("POST /api/auth/login", (): Response =>
      json({
        ok: true,
        sessionToken: "c".repeat(64),
        sessionKey: TEST_SESSION_KEY,
        expiresAt: skewedServerExpiresAt,
        ttlMs: 60_000,
      }));
    useMiniAppStore.setState({ passwordInput: " 123456 " });
    const loginStartedAt: number = Date.now();
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().gateState).toBe("unlocked");
    const localExpiresAt: number = useMiniAppStore.getState().sessionExpiresAt;
    expect(localExpiresAt).toBeGreaterThanOrEqual(loginStartedAt + 60_000);
    expect(localExpiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(readMiniAppSessionExpiresAt()).toBe(localExpiresAt);
    expect(useMiniAppStore.getState().passwordInput).toBe("");
    expect(useMiniAppStore.getState().passwordBusy).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe(zh.gate.unlockedToast);
    expect(readMiniAppSessionToken()).toBe("c".repeat(64));

    route("POST /api/auth/login", (): Response =>
      json({ error: "wrong" }, 403));
    useMiniAppStore.setState({ authMode: "password", gateState: "password", passwordInput: "pw" });
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().passwordError).toBe("wrong");

    route("POST /api/auth/login", (): Response => {
      locked = true;
      return json({ code: "PASSWORD_LOCKED", error: "locked" }, 403);
    });
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    expect(useMiniAppStore.getState().deniedDiag?.code).toBe("PASSWORD_LOCKED");
    expect(useMiniAppStore.getState().passwordBusy).toBeFalse();
  });

  test("手动锁定先以当前令牌通知服务端吊销会话，再清除本地凭据回到密码门禁；无令牌时不发请求", async () => {
    jest.useFakeTimers();
    const token: string = "9".repeat(64);
    seedTestMiniAppSession(token, Date.now() + 60_000);
    let logoutSessionHeader: string | undefined;
    route("POST /api/auth/logout", (_url: URL, init?: RequestInit): Response => {
      logoutSessionHeader = (init?.headers as Record<string, string> | undefined)?.[MINI_APP_SESSION_HEADER];
      return json({ ok: true, revoked: true });
    });
    useMiniAppStore.setState({ gateState: "unlocked", sessionExpiresAt: Date.now() + 60_000 });
    useMiniAppStore.getState().logout("locked by hand");
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().passwordError).toBe("locked by hand");
    expect(readMiniAppSessionToken()).toBe("");
    await flushUntil((): boolean => fetchCalls.length === 1);
    expect(fetchCalls).toEqual(["POST /api/auth/logout"]);
    expect(logoutSessionHeader).toBe(token);

    useMiniAppStore.getState().logout("again");
    await drainImmediate();
    expect(fetchCalls).toEqual(["POST /api/auth/logout"]);
  });

  test("锁定、空原因锁定、手动关闭与密码锁定分支同步清理旧 Toast 定时器并按时限自动熄灭锁定提示", () => {
    jest.useFakeTimers();
    const halfToastMs: number = Math.floor(MINI_APP_TOAST_DURATION_MS / 2);

    useMiniAppStore.setState({ gateState: "unlocked", sessionExpiresAt: Date.now() + 60_000 });
    useMiniAppStore.getState().notify("earlier toast", "info");
    jest.advanceTimersByTime(halfToastMs);
    useMiniAppStore.getState().logout("locked toast");
    expect(useMiniAppStore.getState().toastText).toBe("locked toast");
    expect(useMiniAppStore.getState().toastTone).toBe("warning");

    // 早先 notify 的半程剩余定时器已被清理，不会提前熄灭锁定提示；满时限后锁定提示自动清空。
    jest.advanceTimersByTime(MINI_APP_TOAST_DURATION_MS - 1);
    expect(useMiniAppStore.getState().toastText).toBe("locked toast");
    jest.advanceTimersByTime(1);
    expect(useMiniAppStore.getState().toastText).toBe("");

    // 空原因锁定清掉在途 Toast 定时器且不递增 toastSeq。
    useMiniAppStore.setState({ gateState: "unlocked", sessionExpiresAt: Date.now() + 60_000 });
    useMiniAppStore.getState().notify("pending before silent lock", "info");
    const seqBeforeSilentLock: number = useMiniAppStore.getState().toastSeq;
    jest.advanceTimersByTime(halfToastMs);
    useMiniAppStore.getState().logout("   ");
    expect(useMiniAppStore.getState().toastText).toBe("");
    expect(useMiniAppStore.getState().toastSeq).toBe(seqBeforeSilentLock);
    useMiniAppStore.getState().showToast("manual after silent lock", "info");
    jest.advanceTimersByTime(halfToastMs + 50);
    expect(useMiniAppStore.getState().toastText).toBe("manual after silent lock");

    // clearToast 与 PASSWORD_LOCKED 同样取消挂起的 Toast 定时器。
    useMiniAppStore.getState().notify("to be cleared", "info");
    jest.advanceTimersByTime(halfToastMs);
    useMiniAppStore.getState().clearToast();
    useMiniAppStore.getState().showToast("fresh after clear", "info");
    jest.advanceTimersByTime(halfToastMs + 50);
    expect(useMiniAppStore.getState().toastText).toBe("fresh after clear");

    route("GET /api/auth/precheck", (): Response =>
      json({ ok: false, code: "PASSWORD_LOCKED", error: "locked" }, 403));
    useMiniAppStore.getState().notify("before hard lock", "info");
    jest.advanceTimersByTime(halfToastMs);
    useMiniAppStore.getState().notify("[PASSWORD_LOCKED] locked");
    useMiniAppStore.getState().showToast("after hard lock", "warning");
    jest.advanceTimersByTime(halfToastMs + 50);
    expect(useMiniAppStore.getState().toastText).toBe("after hard lock");
  });
});

describe("页面 store 竞态与收起", () => {
  test("受管群：开关或批量清理的响应返回前已切到其他群时只回报结果、不改写当前群详情；变更结果作废更早发出的详情读取", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    route("GET /api/chats", (): Response => json({ items: [] }));
    route("GET /api/chats/detail", (url: URL): Response =>
      url.searchParams.get("chatId") === "-200"
        ? json({ detail: { chatId: -200, title: "B" } })
        : json({ detail: { chatId: -100, title: "A" } })
    );
    const toggleGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/chats/feature", async (): Promise<Response> => {
      await toggleGate.promise;
      return json({ ok: true, message: "toggled-A", removedFromList: false, detail: { chatId: -100, title: "A2" } });
    });
    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail?.chatId === -100);
    const toggling: Promise<void> = store.getState().toggleFeature("aiChat", true);
    store.getState().closeDetail();
    store.getState().selectChat(-200);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail?.title === "B");
    expect(store.getState().chatDetail?.title).toBe("B");
    toggleGate.resolve();
    await resolveWithFakeTimers(toggling);
    expect(store.getState().selectedChatId).toBe(-200);
    expect(store.getState().chatDetail?.title).toBe("B");
    expect(store.getState().togglingFeature).toBeNull();
    expect(useMiniAppStore.getState().toastText).toBe("toggled-A");

    const kickEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const kickGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/chats/batch-kick", async (): Promise<Response> => {
      kickEntered.resolve();
      await kickGate.promise;
      return json({ ok: false, outcome: "notInitialized", hours: 1, recordCount: 0, message: "kick-B", detail: null });
    });
    const kicking: Promise<void> = store.getState().runBatchKick();
    useMiniAppStore.getState().resolveConfirm(true);
    await kickEntered.promise;
    store.getState().closeDetail();
    await flushFakeTimersUntil((): boolean => !store.getState().loadingList);
    const listLoadsBefore: number = fetchCalls.filter((call: string): boolean => call === "GET /api/chats").length;
    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail?.title === "A");
    kickGate.resolve();
    await resolveWithFakeTimers(kicking);
    expect(store.getState().selectedChatId).toBe(-100);
    expect(store.getState().chatDetail?.title).toBe("A");
    expect(store.getState().batchKickSubmitting).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe("kick-B");
    expect(fetchCalls.filter((call: string): boolean => call === "GET /api/chats").length).toBe(listLoadsBefore);

    const detailGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("GET /api/chats/detail", async (): Promise<Response> => {
      await detailGate.promise;
      return json({ detail: { chatId: -100, title: "A-stale" } });
    });
    route("POST /api/chats/feature", (): Response =>
      json({ ok: true, message: "toggled-A", removedFromList: false, detail: { chatId: -100, title: "A-fresh" } }));
    store.getState().closeMessages();
    expect(store.getState().loadingDetail).toBeTrue();
    await resolveWithFakeTimers(store.getState().toggleFeature("aiChat", false));
    expect(store.getState().chatDetail?.title).toBe("A-fresh");
    expect(store.getState().loadingDetail).toBeFalse();
    detailGate.resolve();
    await drainImmediate();
    jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS);
    await drainImmediate();
    expect(store.getState().chatDetail?.title).toBe("A-fresh");
    expect(store.getState().loadingDetail).toBeFalse();
  });

  test("受管群：轮询在途期间 toggleFeature 回执先到时，旧轮询响应不覆盖开关状态", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    const joinedCountsByHour: readonly number[] = Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (): number => 2);
    route("GET /api/chats/detail", (): Response =>
      json({
        detail: {
          chatId: -100,
          title: "A",
          features: { aiChat: false },
          joinedCountsByHour,
          batchKickRunning: true,
          lastBatchKickCompletion: null,
        },
      }));
    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail !== null);
    expect(store.getState().chatDetail?.batchKickRunning).toBeTrue();

    const pollGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("GET /api/chats/detail", async (): Promise<Response> => {
      await pollGate.promise;
      return json({
        detail: {
          chatId: -100,
          title: "A-stale-poll",
          features: { aiChat: false },
          joinedCountsByHour,
          batchKickRunning: true,
          lastBatchKickCompletion: null,
        },
      });
    });
    route("POST /api/chats/feature", (): Response =>
      json({
        ok: true,
        message: "FEATURE_ENABLED",
        removedFromList: false,
        detail: {
          chatId: -100,
          title: "A-toggled",
          features: { aiChat: true },
          joinedCountsByHour,
          batchKickRunning: true,
          lastBatchKickCompletion: null,
        },
      }));

    const polling: Promise<void> = store.getState().pollRunningBatchKick();
    await resolveWithFakeTimers(store.getState().toggleFeature("aiChat", true));
    expect(store.getState().chatDetail?.features.aiChat).toBeTrue();

    pollGate.resolve();
    await polling;
    expect(store.getState().chatDetail?.features.aiChat).toBeTrue();
    expect(store.getState().chatDetail?.title).toBe("A-toggled");
  });

  test("受管群：防抖刷新在途期间 toggleFeature 回执先到时，旧响应不覆盖且 loadingWindowJoined 为 false", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    const joinedCountsByHour: readonly number[] = Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (): number => 3);
    route("GET /api/chats/detail", (): Response =>
      json({
        detail: {
          chatId: -100,
          title: "A",
          features: { aiChat: false },
          joinedCountsByHour,
          batchKickRunning: false,
          lastBatchKickCompletion: null,
        },
      }));
    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail !== null);

    const toggleGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/chats/feature", async (): Promise<Response> => {
      await toggleGate.promise;
      return json({
        ok: true,
        message: "FEATURE_ENABLED",
        removedFromList: false,
        detail: {
          chatId: -100,
          title: "A-toggled",
          features: { aiChat: true },
          joinedCountsByHour,
          batchKickRunning: false,
          lastBatchKickCompletion: null,
        },
      });
    });

    const refreshEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const refreshGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("GET /api/chats/detail", async (): Promise<Response> => {
      refreshEntered.resolve();
      await refreshGate.promise;
      return json({
        detail: {
          chatId: -100,
          title: "A-stale-window",
          features: { aiChat: false },
          joinedCountsByHour,
          batchKickRunning: false,
          lastBatchKickCompletion: null,
        },
      });
    });

    // 先发起 toggleFeature，并在其未结算期间触发滑块防抖请求（此时仅 detailReqSeq 变化、windowJoinedReqSeq 不变）。
    const toggling: Promise<void> = store.getState().toggleFeature("aiChat", true);
    store.getState().setBatchKickHours(8);
    expect(store.getState().loadingWindowJoined).toBeTrue();
    await resolveWithFakeTimers(refreshEntered.promise, MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS);

    toggleGate.resolve();
    await resolveWithFakeTimers(toggling);
    expect(store.getState().chatDetail?.features.aiChat).toBeTrue();

    refreshGate.resolve();
    await flushUntil((): boolean => !store.getState().loadingWindowJoined);
    expect(store.getState().chatDetail?.features.aiChat).toBeTrue();
    expect(store.getState().chatDetail?.title).toBe("A-toggled");
    expect(store.getState().loadingWindowJoined).toBeFalse();

    // 失败分支同样在仅 detailReqSeq 变化时收起 loadingWindowJoined。
    const toggleGate2: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/chats/feature", async (): Promise<Response> => {
      await toggleGate2.promise;
      return json({
        ok: true,
        message: "FEATURE_DISABLED",
        removedFromList: false,
        detail: {
          chatId: -100,
          title: "A-toggled-2",
          features: { aiChat: false },
          joinedCountsByHour,
          batchKickRunning: false,
          lastBatchKickCompletion: null,
        },
      });
    });
    const failEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const failGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("GET /api/chats/detail", async (): Promise<Response> => {
      failEntered.resolve();
      await failGate.promise;
      return json({ error: "stale refresh error" }, 500);
    });
    const toggling2: Promise<void> = store.getState().toggleFeature("aiChat", false);
    store.getState().setBatchKickHours(10);
    await resolveWithFakeTimers(failEntered.promise, MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS);
    toggleGate2.resolve();
    await resolveWithFakeTimers(toggling2);
    failGate.resolve();
    await flushUntil((): boolean => !store.getState().loadingWindowJoined);
    expect(store.getState().chatDetail?.title).toBe("A-toggled-2");
    expect(store.getState().loadingWindowJoined).toBeFalse();
  });

  test("受管群：滑块防抖期间发起 toggleFeature 后立即取消防抖且 loadingWindowJoined 为 false", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    const joinedCountsByHour: readonly number[] = Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (): number => 4);
    route("GET /api/chats/detail", (): Response =>
      json({
        detail: {
          chatId: -100,
          title: "A",
          features: { aiChat: false },
          joinedCountsByHour,
          batchKickRunning: false,
          lastBatchKickCompletion: null,
        },
      }));
    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail !== null);

    const getCallsBefore: number = fetchCalls.filter((call: string): boolean => call === "GET /api/chats/detail?chatId=-100").length;
    store.getState().setBatchKickHours(9);
    expect(store.getState().loadingWindowJoined).toBeTrue();

    const toggleGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/chats/feature", async (): Promise<Response> => {
      await toggleGate.promise;
      return json({
        ok: true,
        message: "FEATURE_ENABLED",
        removedFromList: false,
        detail: {
          chatId: -100,
          title: "A-after-toggle",
          features: { aiChat: true },
          joinedCountsByHour,
          batchKickRunning: false,
          lastBatchKickCompletion: null,
        },
      });
    });

    const toggling: Promise<void> = store.getState().toggleFeature("aiChat", true);
    expect(store.getState().loadingWindowJoined).toBeFalse();
    jest.advanceTimersByTime(MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS + 60);
    await drainImmediate();
    expect(fetchCalls.filter((call: string): boolean => call === "GET /api/chats/detail?chatId=-100").length).toBe(getCallsBefore);

    toggleGate.resolve();
    await resolveWithFakeTimers(toggling);
    expect(store.getState().loadingWindowJoined).toBeFalse();
  });

  test("受管群：A → B → A 切群期间旧轮询响应被丢弃，不覆盖重新加载的群详情", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    const joinedCountsByHour: readonly number[] = Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (): number => 1);
    route("GET /api/chats", (): Response => json({ items: [] }));
    route("GET /api/chats/detail", (url: URL): Response => {
      if (url.searchParams.get("chatId") === "-200") {
        return json({
          detail: {
            chatId: -200,
            title: "B",
            joinedCountsByHour,
            batchKickRunning: false,
            lastBatchKickCompletion: null,
          },
        });
      }
      return json({
        detail: {
          chatId: -100,
          title: "A-initial",
          joinedCountsByHour,
          batchKickRunning: true,
          lastBatchKickCompletion: null,
        },
      });
    });
    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail?.title === "A-initial");

    const stalePollGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    let aFetchCount: number = 0;
    route("GET /api/chats/detail", async (url: URL): Promise<Response> => {
      if (url.searchParams.get("chatId") === "-200") {
        return json({
          detail: {
            chatId: -200,
            title: "B",
            joinedCountsByHour,
            batchKickRunning: false,
            lastBatchKickCompletion: null,
          },
        });
      }
      aFetchCount += 1;
      if (aFetchCount === 1) {
        await stalePollGate.promise;
        return json({
          detail: {
            chatId: -100,
            title: "A-stale-poll",
            joinedCountsByHour,
            batchKickRunning: true,
            lastBatchKickCompletion: null,
          },
        });
      }
      return json({
        detail: {
          chatId: -100,
          title: "A-reloaded",
          joinedCountsByHour,
          batchKickRunning: false,
          lastBatchKickCompletion: null,
        },
      });
    });

    const stalePolling: Promise<void> = store.getState().pollRunningBatchKick();
    store.getState().selectChat(-200);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail?.title === "B");
    expect(store.getState().chatDetail?.title).toBe("B");

    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail?.title === "A-reloaded");
    expect(store.getState().chatDetail?.title).toBe("A-reloaded");

    stalePollGate.resolve();
    await stalePolling;
    expect(store.getState().chatDetail?.title).toBe("A-reloaded");
    expect(store.getState().chatDetail?.batchKickRunning).toBeFalse();
  });

  test("受管群：目标与问答变更回执作废更早发出的轮询与防抖刷新，且 closeDetail 作废在途 loadDetail", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    const joinedCountsByHour: readonly number[] = Array.from({ length: MINI_APP_BATCH_KICK_MAX_HOURS }, (): number => 2);
    route("GET /api/chats", (): Response => json({ items: [] }));
    route("GET /api/chats/detail", (): Response =>
      json({
        detail: {
          chatId: -100,
          title: "A",
          qaPairCount: 0,
          joinedCountsByHour,
          batchKickRunning: true,
          lastBatchKickCompletion: null,
        },
      }));
    store.getState().selectChat(-100);
    await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail !== null);

    const pollGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const windowEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const windowGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    let getCount: number = 0;
    route("GET /api/chats/detail", async (): Promise<Response> => {
      getCount += 1;
      if (getCount === 1) {
        await pollGate.promise;
        return json({
          detail: {
            chatId: -100,
            title: "A-stale-poll",
            qaPairCount: 0,
            joinedCountsByHour,
            batchKickRunning: true,
            lastBatchKickCompletion: null,
          },
        });
      }
      windowEntered.resolve();
      await windowGate.promise;
      return json({
        detail: {
          chatId: -100,
          title: "A-stale-window",
          qaPairCount: 0,
          joinedCountsByHour,
          batchKickRunning: true,
          lastBatchKickCompletion: null,
        },
      });
    });
    route("POST /api/chats/targets", (): Response =>
      json({
        ok: true,
        message: "QA_ADDED",
        targets: {
          chatId: -100,
          qaItems: [{ q: "hi", a: "hello" }],
          qaMax: CHAT_QA_MAX_PER_CHAT,
          qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
          qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
          deleteMessageTargets: [],
          deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
          translateTargets: [],
          translateMax: TRANSLATE_CHAT_USER_LIMIT,
          isTranslationEnabled: true,
        },
        detail: {
          chatId: -100,
          title: "A-qa-updated",
          qaPairCount: 1,
          joinedCountsByHour,
          batchKickRunning: true,
          lastBatchKickCompletion: null,
        },
      }));

    const polling: Promise<void> = store.getState().pollRunningBatchKick();
    store.getState().setBatchKickHours(6);
    await resolveWithFakeTimers(windowEntered.promise, MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS);

    store.getState().setQaQuestionInput("hi");
    store.getState().setQaAnswerInput("hello");
    await resolveWithFakeTimers(store.getState().submitQaPair());
    expect(store.getState().chatDetail?.qaPairCount).toBe(1);

    pollGate.resolve();
    windowGate.resolve();
    await polling;
    await flushUntil((): boolean => !store.getState().loadingWindowJoined);
    expect(store.getState().chatDetail?.qaPairCount).toBe(1);
    expect(store.getState().chatDetail?.title).toBe("A-qa-updated");
    expect(store.getState().loadingWindowJoined).toBeFalse();

    // 打开详情后立即 closeDetail：loadingDetail 即刻归 false，随后晚到的详情响应不写回列表态。
    const lateDetailGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("GET /api/chats/detail", async (): Promise<Response> => {
      await lateDetailGate.promise;
      return json({
        detail: {
          chatId: -100,
          title: "A-after-close",
          qaPairCount: 1,
          joinedCountsByHour,
          batchKickRunning: false,
          lastBatchKickCompletion: null,
        },
      });
    });
    store.getState().selectChat(-100);
    expect(store.getState().loadingDetail).toBeTrue();
    store.getState().closeDetail();
    expect(store.getState().selectedChatId).toBeNull();
    expect(store.getState().loadingDetail).toBeFalse();

    lateDetailGate.resolve();
    await drainImmediate();
    jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS);
    await drainImmediate();
    expect(store.getState().selectedChatId).toBeNull();
    expect(store.getState().chatDetail).toBeNull();
    expect(store.getState().loadingDetail).toBeFalse();
  });

  test("验证器：动态码错误时保留二维码继续输入，服务端回报待绑定密钥已作废时收起二维码与输入", async () => {
    const store = createTotpStore();
    route("POST /api/totp/setup", (): Response => json({ ok: true, secret: "S", otpauthUri: "u", qrSvg: "<svg/>", expiresAt: 1 }));
    await store.getState().startSetup();
    const disabledStatus = { enabled: false, createdAt: null, maskedSecret: null };
    route("POST /api/totp/enable", (): Response =>
      json({ ok: false, message: "INVALID_TOTP_CODE", status: disabledStatus }, 400));
    store.getState().setCodeInput("111111");
    await store.getState().verifyEnable();
    expect(store.getState().setupData?.secret).toBe("S");
    expect(store.getState().codeInput).toBe("111111");
    expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("INVALID_TOTP_CODE"));

    route("POST /api/totp/enable", (): Response =>
      json({ ok: false, message: "TOTP_SETUP_EXPIRED", status: disabledStatus }, 400));
    store.getState().setCodeInput("222222");
    await store.getState().verifyEnable();
    expect(store.getState().setupData).toBeNull();
    expect(store.getState().codeInput).toBe("");
    expect(store.getState().busy).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe(zh.serverNotice("TOTP_SETUP_EXPIRED"));
  });

  test("受管群目标弹窗：同群已持有缓存清单时重开静默刷新不置骨架态，离开详情各路径同步关闭弹窗与下拉菜单", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    const emptyTargets = {
      chatId: -100,
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
    route("GET /api/chats", (): Response => json({ items: [{ chatId: -100 }] }));
    route("GET /api/chats/detail", (url: URL): Response =>
      json({ detail: { chatId: Number(url.searchParams.get("chatId")) } })
    );
    route("GET /api/chats/targets", (url: URL): Response =>
      json({ targets: { ...emptyTargets, chatId: Number(url.searchParams.get("chatId")) } })
    );

    store.getState().selectChat(-100);
    store.getState().openTargetsModal("qa");
    expect(store.getState().loadingTargets).toBeTrue();
    await flushFakeTimersUntil((): boolean => !store.getState().loadingTargets && store.getState().chatTargets !== null);
    expect(store.getState().loadingTargets).toBeFalse();
    expect(store.getState().chatTargets?.qaItems).toEqual([]);
    store.getState().openQaEditor();
    store.getState().setQaQuestionInput("closing-draft");
    store.getState().openTargetAddMenu();
    store.getState().selectTargetAddMode("id");
    store.getState().toggleTranslateLangMenu();
    const openSnapshot = store.getState();
    store.getState().closeTargetsModal();
    expect(store.getState().activeTargetsModal).toBeNull();
    const closingPanelState = resolveChatTargetsModalPanelState(store.getState(), openSnapshot, true);
    expect(closingPanelState.qaEditorOpen).toBeTrue();
    expect(closingPanelState.qaQuestionInput).toBe("closing-draft");
    expect(closingPanelState.targetAddMenuOpen).toBeTrue();
    expect(closingPanelState.targetIdFormOpen).toBeTrue();
    expect(closingPanelState.translateLangMenuOpen).toBeFalse();
    expect(resolveChatTargetsModalPanelState(store.getState(), openSnapshot, false).qaEditorOpen).toBeFalse();

    route("GET /api/chats/targets", (): Response =>
      json({ targets: { ...emptyTargets, qaItems: [{ q: "q-silent", a: "a-silent" }] } }));
    store.getState().openTargetsModal("qa");
    expect(store.getState().activeTargetsModal).toBe("qa");
    expect(store.getState().loadingTargets).toBeFalse();
    expect(store.getState().chatTargets?.qaItems).toEqual([]);
    await flushUntil((): boolean => store.getState().chatTargets?.qaItems.length === 1);
    expect(store.getState().chatTargets?.qaItems).toEqual([{ q: "q-silent", a: "a-silent" }]);

    const manualTargetsRefresh: Promise<void> = store.getState().loadChatTargets(false);
    expect(store.getState().loadingTargets).toBeTrue();
    await resolveWithFakeTimers(manualTargetsRefresh);
    expect(store.getState().loadingTargets).toBeFalse();

    store.getState().toggleTargetsMenu();
    expect(store.getState().targetsMenuOpen).toBeTrue();
    store.getState().openMessages();
    expect(store.getState().viewingMessages).toBeTrue();
    expect(store.getState().activeTargetsModal).toBeNull();
    expect(store.getState().targetsMenuOpen).toBeFalse();
    store.getState().closeMessages();

    route("GET /api/chats/detail", (): Response => json({ detail: { chatId: -200 } }));
    route("GET /api/chats/targets", (): Response => json({ targets: { ...emptyTargets, chatId: -200 } }));
    store.getState().openTargetsModal("deleteMessage");
    store.getState().toggleTargetsMenu();
    store.getState().selectChat(-200);
    expect(store.getState().selectedChatId).toBe(-200);
    expect(store.getState().activeTargetsModal).toBeNull();
    expect(store.getState().targetsMenuOpen).toBeFalse();
    expect(store.getState().chatTargets).toBeNull();

    store.getState().openTargetsModal("qa");
    store.getState().toggleTargetsMenu();
    route("POST /api/chats/feature", (): Response =>
      json({ ok: true, message: "init-off", removedFromList: true, detail: null }));
    const disableInitWhileModalOpen: Promise<void> = store.getState().toggleFeature("init", false);
    useMiniAppStore.getState().resolveConfirm(true);
    await resolveWithFakeTimers(disableInitWhileModalOpen);
    expect(store.getState().selectedChatId).toBeNull();
    expect(store.getState().activeTargetsModal).toBeNull();
    expect(store.getState().targetsMenuOpen).toBeFalse();
    expect(store.getState().chatTargets).toBeNull();

    store.getState().selectChat(-100);
    store.getState().openTargetsModal("translate");
    store.getState().toggleTargetsMenu();
    store.getState().closeDetail();
    expect(store.getState().selectedChatId).toBeNull();
    expect(store.getState().activeTargetsModal).toBeNull();
    expect(store.getState().targetsMenuOpen).toBeFalse();
    expect(store.getState().chatTargets).toBeNull();
    await flushFakeTimersUntil((): boolean => !store.getState().loadingList);
  });

  test("名单竞态与静默刷新：白名单添加在途切到黑名单不写入 selectedEntryId，已缓存黑名单移出静默刷新不闪骨架", async () => {
    jest.useFakeTimers();
    const store = createIdentitiesStore();
    const postGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/identities/whitelist", async (): Promise<Response> => {
      await postGate.promise;
      return json({ ok: true, changed: true, message: "added-42" });
    });
    route("GET /api/identities/blocklist", (): Response =>
      json({ page: 1, items: [{ id: 88, displayName: "Spam" }], whitelistTotal: 1, blocklistTotal: 1 }));

    store.getState().setIdInput("42");
    const adding: Promise<void> = store.getState().addById();
    store.getState().selectSubTab("blocklist");
    await resolveWithFakeTimers(store.getState().loadCurrentList());
    expect(store.getState().blocklistPage?.items).toHaveLength(1);
    expect(store.getState().loadingList).toBeFalse();

    postGate.resolve();
    await resolveWithFakeTimers(adding);
    expect(store.getState().subTab).toBe("blocklist");
    expect(store.getState().selectedEntryId).toBeNull();

    const refreshEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const refreshGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/identities/blocklist", (): Response => json({ ok: true, changed: true, message: "removed-88" }));
    route("GET /api/identities/blocklist", async (): Promise<Response> => {
      refreshEntered.resolve();
      await refreshGate.promise;
      return json({ page: 1, items: [], whitelistTotal: 1, blocklistTotal: 0 });
    });

    const removing: Promise<void> = store.getState().removeBlocklist({ id: 88, displayName: "Spam" } as never);
    useMiniAppStore.getState().resolveConfirm(true);
    await refreshEntered.promise;
    expect(store.getState().loadingList).toBeFalse();
    refreshGate.resolve();
    await resolveWithFakeTimers(removing);
    expect(store.getState().loadingList).toBeFalse();
    expect(store.getState().blocklistPage?.items).toEqual([]);
    expect(store.getState().blocklistTotal).toBe(0);
  });

  test("当前页已存在黑名单 ID 时 addById 仍向后端发起 POST，展示重复提示并在 Toast 中附带重新跨群封禁结果", async () => {
    const store = createIdentitiesStore();
    const zh: MiniAppTranslations = getMiniAppTranslations("zh");
    const postCalls: string[] = [];
    route("GET /api/identities/blocklist", (): Response =>
      json({ page: 1, items: [{ id: 99, displayName: "Blocked99" }], whitelistTotal: 0, blocklistTotal: 1 }));
    const duplicateResult = {
      ok: true,
      changed: false,
      duplicate: true,
      id: 99,
      persisted: false,
      affectedChats: 1,
      totalChats: 2,
      message: "BLOCKLIST_DUPLICATE",
    };
    route("POST /api/identities/blocklist", (): Response => {
      postCalls.push("POST /api/identities/blocklist");
      return json(duplicateResult);
    });

    store.getState().selectSubTab("blocklist");
    await store.getState().loadCurrentList();
    store.getState().setIdInput("99");
    await store.getState().addById();

    expect(postCalls).toEqual(["POST /api/identities/blocklist"]);
    expect(store.getState().duplicateAlertText).toBe(zh.identities.duplicateToast("ID 99", "blocklist"));
    const expectedToast: string = zh.serverNotice(
      "BLOCKLIST_DUPLICATE",
      extractServerNoticeParams(duplicateResult)
    );
    expect(expectedToast).toContain("1/2");
    expect(useMiniAppStore.getState().toastText).toBe(expectedToast);
    expect(useMiniAppStore.getState().toastTone).toBe("warning");
  });
});
