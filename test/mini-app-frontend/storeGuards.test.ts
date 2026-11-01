/**
 * Mini App 前端 store 的会话与竞态守卫：登录后的本机到期时刻、手动锁定的服务端吊销、
 * 受管群变更响应与当前所选群的对齐，以及验证器待绑定密钥作废后的收起。`fetch` 按「方法 + 路径」路由到测试夹具。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_SESSION_HEADER,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

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

/** 等待超过加载骨架最短展示时长，让带最短时长的加载动作结算。 */
async function settleLoading(): Promise<void> {
  await Bun.sleep(MINI_APP_MIN_LOADING_MS + 120);
}

beforeEach((): void => {
  routes.clear();
  fetchCalls.length = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url: URL = new URL(String(input), "http://mini.test/");
    const key: string = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    fetchCalls.push(`${key}${url.search}`);
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
    route("POST /api/auth/login", (): Response =>
      json({ ok: true, sessionToken: "c".repeat(64), expiresAt: skewedServerExpiresAt, ttlMs: 60_000, assetToken: "d".repeat(64) }));
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
      json({ code: "INVALID_PASSWORD", error: "wrong" }, 403));
    useMiniAppStore.setState({ authMode: "password", gateState: "password", passwordInput: "pw" });
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().passwordError).toBe("wrong");

    route("POST /api/auth/login", (): Response =>
      json({ code: "PASSWORD_LOCKED", error: "locked" }, 403));
    route("GET /api/auth/precheck", (): Response =>
      json({ ok: false, code: "PASSWORD_LOCKED", error: "locked" }, 403));
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    expect(useMiniAppStore.getState().deniedDiag?.code).toBe("PASSWORD_LOCKED");
    expect(useMiniAppStore.getState().passwordBusy).toBeFalse();
  });

  test("手动锁定先以当前令牌通知服务端吊销会话，再清除本地凭据回到密码门禁；无令牌时不发请求", async () => {
    const token: string = "9".repeat(64);
    setMiniAppSessionToken(token, Date.now() + 60_000);
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
    await Bun.sleep(10);
    expect(fetchCalls).toEqual(["POST /api/auth/logout"]);
    expect(logoutSessionHeader).toBe(token);

    useMiniAppStore.getState().logout("again");
    await Bun.sleep(10);
    expect(fetchCalls).toEqual(["POST /api/auth/logout"]);
  });
});

describe("页面 store 竞态与收起", () => {
  test("受管群：开关或批量清理的响应返回前已切到其他群时只回报结果、不改写当前群详情；变更结果作废更早发出的详情读取", async () => {
    const store = createChatsStore();
    route("GET /api/chats", (): Response => json({ items: [] }));
    route("GET /api/chats/-100", (): Response => json({ detail: { chatId: -100, title: "A" } }));
    route("GET /api/chats/-200", (): Response => json({ detail: { chatId: -200, title: "B" } }));
    const toggleGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/chats/-100/feature", async (): Promise<Response> => {
      await toggleGate.promise;
      return json({ ok: true, message: "toggled-A", removedFromList: false, detail: { chatId: -100, title: "A2" } });
    });
    store.getState().selectChat(-100);
    await settleLoading();
    const toggling: Promise<void> = store.getState().toggleFeature("aiChat", true);
    store.getState().closeDetail();
    store.getState().selectChat(-200);
    await settleLoading();
    expect(store.getState().chatDetail?.title).toBe("B");
    toggleGate.resolve();
    await toggling;
    expect(store.getState().selectedChatId).toBe(-200);
    expect(store.getState().chatDetail?.title).toBe("B");
    expect(store.getState().togglingFeature).toBeNull();
    expect(useMiniAppStore.getState().toastText).toBe("toggled-A");

    const kickGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("POST /api/chats/-200/batch-kick", async (): Promise<Response> => {
      await kickGate.promise;
      return json({ ok: false, outcome: "notInitialized", hours: 1, recordCount: 0, message: "kick-B", detail: null });
    });
    const kicking: Promise<void> = store.getState().runBatchKick();
    useMiniAppStore.getState().resolveConfirm(true);
    await Bun.sleep(10);
    store.getState().closeDetail();
    await settleLoading();
    const listLoadsBefore: number = fetchCalls.filter((call: string): boolean => call === "GET /api/chats").length;
    store.getState().selectChat(-100);
    await settleLoading();
    kickGate.resolve();
    await kicking;
    expect(store.getState().selectedChatId).toBe(-100);
    expect(store.getState().chatDetail?.title).toBe("A");
    expect(store.getState().batchKickSubmitting).toBeFalse();
    expect(useMiniAppStore.getState().toastText).toBe("kick-B");
    expect(fetchCalls.filter((call: string): boolean => call === "GET /api/chats").length).toBe(listLoadsBefore);

    const detailGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    route("GET /api/chats/-100", async (): Promise<Response> => {
      await detailGate.promise;
      return json({ detail: { chatId: -100, title: "A-stale" } });
    });
    route("POST /api/chats/-100/feature", (): Response =>
      json({ ok: true, message: "toggled-A", removedFromList: false, detail: { chatId: -100, title: "A-fresh" } }));
    store.getState().closeMessages();
    expect(store.getState().loadingDetail).toBeTrue();
    await store.getState().toggleFeature("aiChat", false);
    expect(store.getState().chatDetail?.title).toBe("A-fresh");
    expect(store.getState().loadingDetail).toBeFalse();
    detailGate.resolve();
    await settleLoading();
    expect(store.getState().chatDetail?.title).toBe("A-fresh");
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
});
