/**
 * Mini App 前端未授权访问与门禁安全测试：
 * - 验证 `App` 初始处于 `"checking"` 阶段时返回空标记（不挂载 `AccessDeniedPage`、`AuthGatePage` 或 `AppShell`，零业务 API 请求）；
 * - 验证缺失 `Telegram.WebApp.initData` 或 `/api/auth/precheck` 返回 `401`/`403`/非 2xx/网络异常时，清理本地残留令牌并进入 `AccessDeniedPage`，且诊断字段全部经 JSX 转义防 XSS；
 * - 验证预检要求输入密码或 TOTP（含本地令牌缺失、畸形、已过期）时进入 `AuthGatePage`（绝不渲染 `AppShell`），图库预览与下载 URL 不附带失效凭据；
 * - 验证 `logout()`、业务请求与后台轮询（`statusStore.loadMood`、`statusStore.loadStatus(false)`、`chatsStore.pollRunningBatchKick`）收到 `401 PASSWORD_REQUIRED` / `403 PASSWORD_LOCKED` 以及 45 分钟会话到期后，立即清除内存与存储中的会话及资源令牌、不再向后续请求附加失效 `X-Mini-App-Session`，并锁定回 `AuthGatePage` 或 `AccessDeniedPage`。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../../packages/mini-app-frontend/App";
import { buildMiniAppGalleryDownloadUrl, downloadMiniAppGalleryImageByName } from "../../packages/mini-app-frontend/api/galleryDownload";
import { buildMiniAppGalleryImageUrl } from "../../packages/mini-app-frontend/api/galleryFile";
import { uploadMiniAppGalleryImageBytes } from "../../packages/mini-app-frontend/api/galleryUpload";
import { buildMiniAppAuthHeaders, miniAppFetchJson } from "../../packages/mini-app-frontend/api/request";
import {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_STORAGE_KEY,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_TMA_AUTH_PREFIX,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import {
  clearMiniAppAssetToken,
  clearMiniAppSessionToken,
  readMiniAppAssetToken,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
  setMiniAppAssetToken,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import { readMiniAppInitData } from "../../packages/mini-app-frontend/libs/telegram";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import type { MiniAppChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import { createIdentitiesStore } from "../../packages/mini-app-frontend/store/identities";
import { createMessagesStore } from "../../packages/mini-app-frontend/store/messages";
import { createPermissionDrawerStore } from "../../packages/mini-app-frontend/store/permissionDrawer";
import { createStatusStore } from "../../packages/mini-app-frontend/store/status";
import type { MiniAppStatusStore } from "../../packages/mini-app-frontend/store/status";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppChatDetail, MiniAppStatusView } from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

/** 测试捕获到的单次前端出站请求记录。 */
interface CapturedRequest {
  /** 大写 HTTP 方法与路径拼成的路由键（如 `"GET /api/status"`）。 */
  readonly routeKey: string;
  /** 包含查询串的完整相对路径（如 `"/api/gallery?page=1"`）。 */
  readonly fullPath: string;
  /** 小写归一化后的请求头键值表。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 请求配置中的 `keepalive` 标记。 */
  readonly keepalive: boolean;
}

/** 测试模拟的内存版 Web Storage 容器。 */
interface MemoryStorage {
  /** 读取键对应的字符串值。 */
  readonly getItem: (key: string) => string | null;
  /** 写入键值。 */
  readonly setItem: (key: string, value: string) => void;
  /** 移除指定键。 */
  readonly removeItem: (key: string) => void;
  /** 清空全部键值。 */
  readonly clear: () => void;
  /** 当前存储条目数。 */
  readonly size: () => number;
}

/** 模拟路由处理函数签名。 */
type MockRouteHandler = (
  url: URL,
  init: RequestInit | undefined,
  headers: Readonly<Record<string, string>>
) => Response | Promise<Response>;

/** 单测期间读写或覆盖的全部全局属性键列表，用于 `beforeEach`/`afterEach` 对称快照与恢复。 */
const SNAPSHOTTED_GLOBAL_KEYS: readonly string[] = [
  "window",
  "localStorage",
  "sessionStorage",
  "Telegram",
  "location",
  "document",
  "fetch",
];

const capturedRequests: CapturedRequest[] = [];
const mockRoutes: Map<string, MockRouteHandler> = new Map<string, MockRouteHandler>();
const savedGlobalDescriptors: Map<string, PropertyDescriptor | undefined> = new Map<
  string,
  PropertyDescriptor | undefined
>();
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

/**
 * 创建独立的内存版 `Storage` 夹具以验证 `localStorage` 与 `sessionStorage` 凭据持久化及吊销清理。
 * @returns 内存存储对象。
 */
function createMemoryStorage(): MemoryStorage {
  const map: Map<string, string> = new Map<string, string>();
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
    clear: (): void => {
      map.clear();
    },
    size: (): number => map.size,
  };
}

/**
 * 将 `RequestInit["headers"]` 归一化为小写键名的只读字典。
 * @param rawHeaders 原始请求头入参。
 * @returns 小写键名请求头表。
 */
function normalizeHeaders(rawHeaders: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (rawHeaders === undefined) return out;
  const parsed: Headers = new Headers(rawHeaders);
  parsed.forEach((value: string, key: string): void => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * 注册一条按 `"METHOD /path"` 匹配的模拟服务端响应处理器。
 * @param key `"METHOD /path"` 键。
 * @param handler 响应构造回调。
 */
function registerRoute(key: string, handler: MockRouteHandler): void {
  mockRoutes.set(key, handler);
}

/**
 * 构造测试用 JSON `Response`。
 * @param payload 响应体载荷。
 * @param status HTTP 状态码。
 * @returns JSON `Response`。
 */
function jsonRes(payload: unknown, status: number = 200): Response {
  return Response.json(payload, { status });
}

/**
 * 断言当前根组件 `App` 的 SSR 渲染结果只命中预期的门禁视图，绝不挂载其余视图或业务外壳。
 * @param expectedView 预期渲染的门禁视图类型。
 * @returns 渲染得到的静态 HTML 字符串。
 */
function assertRenderedGateView(
  expectedView: "checking" | "denied" | "password" | "unlocked"
): string {
  const markup: string = renderToStaticMarkup(createElement(App));
  if (expectedView === "checking") {
    expect(markup).toBe("");
    return markup;
  }
  expect(markup.includes("cf-error-page")).toBe(expectedView === "denied");
  expect(markup.includes("auth-gate-card")).toBe(expectedView === "password");
  expect(markup.includes("app-shell")).toBe(expectedView === "unlocked");
  return markup;
}

/**
 * 在内存、`localStorage` 与 `sessionStorage` 中预置一对尚未到期的会话令牌与受保护资源令牌，用于验证失败或登出时被彻底擦除。
 * @param sessionHex 64 位十六进制会话令牌。
 * @param assetHex 64 位十六进制资源令牌。
 */
function seedActiveLocalCredentials(sessionHex: string, assetHex: string): void {
  setMiniAppAssetToken(assetHex);
  setMiniAppSessionToken(sessionHex, Date.now() + MINI_APP_SESSION_TTL_MS);
}

let localStoreFixture: MemoryStorage = createMemoryStorage();
let sessionStoreFixture: MemoryStorage = createMemoryStorage();

beforeEach((): void => {
  savedGlobalDescriptors.clear();
  for (const key of SNAPSHOTTED_GLOBAL_KEYS) {
    savedGlobalDescriptors.set(key, Reflect.getOwnPropertyDescriptor(globalThis, key));
  }

  capturedRequests.length = 0;
  mockRoutes.clear();
  localStoreFixture = createMemoryStorage();
  sessionStoreFixture = createMemoryStorage();

  for (const key of ["window", "Telegram", "location", "document"]) {
    Reflect.deleteProperty(globalThis, key);
  }
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: localStoreFixture,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: sessionStoreFixture,
  });

  const mockedFetch: typeof fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const url: URL = new URL(String(input), "https://miniapp.example.com/");
    const method: string = (init?.method ?? "GET").toUpperCase();
    const routeKey: string = `${method} ${url.pathname}`;
    const headers: Record<string, string> = normalizeHeaders(init?.headers);
    capturedRequests.push({
      routeKey,
      fullPath: `${url.pathname}${url.search}`,
      headers,
      keepalive: init?.keepalive === true,
    });
    const handler: MockRouteHandler | undefined = mockRoutes.get(routeKey);
    if (handler !== undefined) {
      return handler(url, init, headers);
    }
    return jsonRes({ error: `Unhandled route ${routeKey}` }, 404);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: mockedFetch,
  });

  clearMiniAppSessionToken();
  clearMiniAppAssetToken();
  resetMiniAppStoreForTest();
  useMiniAppStore.getState().setLanguage("zh");
});

afterEach((): void => {
  jest.useRealTimers();
  resetMiniAppStoreForTest();
  clearMiniAppSessionToken();
  clearMiniAppAssetToken();
  for (const key of SNAPSHOTTED_GLOBAL_KEYS) {
    const descriptor: PropertyDescriptor | undefined = savedGlobalDescriptors.get(key);
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
  savedGlobalDescriptors.clear();
});

describe("Mini App 前端未授权访问门禁与凭据隔离", () => {
  test("初始 checking 阶段 App 渲染 null：不挂载任何业务页面或门禁卡片，且不触发任何业务 API 请求", () => {
    expect(useMiniAppStore.getState().gateState).toBe("checking");
    const markup: string = assertRenderedGateView("checking");
    expect(markup).toBe("");
    expect(capturedRequests).toEqual([]);
  });

  test("缺失 Telegram.WebApp.initData 或预检返回 401/403/500/网络失败时一律清除残留凭据并进入 AccessDeniedPage，且诊断字段严格转义", async () => {
    expect(readMiniAppInitData()).toBe("");
    const bareHeaders: Record<string, string> = buildMiniAppAuthHeaders(true);
    expect(bareHeaders[MINI_APP_INIT_DATA_HEADER]).toBeUndefined();
    expect(bareHeaders.authorization).toBeUndefined();
    expect(bareHeaders[MINI_APP_SESSION_HEADER]).toBeUndefined();
    expect(buildMiniAppGalleryImageUrl("sample.png")).toBe("./api/gallery/file/sample.png");
    expect(buildMiniAppGalleryDownloadUrl("sample.png")).toBe("./api/gallery/download/sample.png");

    interface PrecheckFailureCase {
      readonly label: string;
      readonly initData: string | undefined;
      readonly responder: MockRouteHandler;
      readonly expectedCode: string;
    }

    const failureCases: readonly PrecheckFailureCase[] = [
      {
        label: "外部浏览器无 initData 返回 401 MISSING_INIT_DATA",
        initData: undefined,
        responder: (): Response =>
          jsonRes(
            {
              ok: false,
              status: 401,
              code: "MISSING_INIT_DATA",
              error: "MISSING_INIT_DATA",
              requestId: "aa11bb22cc33dd44",
              clientIp: "203.0.113.10",
              host: "miniapp.example.com",
              path: "/api/auth/precheck",
            },
            401
          ),
        expectedCode: "MISSING_INIT_DATA",
      },
      {
        label: "篡改签名返回 401 INVALID_SIGNATURE",
        initData: "auth_date=1700000000&hash=deadbeef",
        responder: (): Response =>
          jsonRes({ ok: false, status: 401, code: "INVALID_SIGNATURE", error: "INVALID_SIGNATURE" }, 401),
        expectedCode: "INVALID_SIGNATURE",
      },
      {
        label: "非超级管理员有效签名返回 403 FORBIDDEN_USER",
        initData: "user=%7B%22id%22%3A99999%7D&auth_date=1700000000&hash=abcd",
        responder: (): Response =>
          jsonRes({ ok: false, status: 403, code: "FORBIDDEN_USER", error: "FORBIDDEN_USER" }, 403),
        expectedCode: "FORBIDDEN_USER",
      },
      {
        label: "跨站或直接导航拦截返回 403 CROSS_SITE_FORBIDDEN",
        initData: "signed-data",
        responder: (): Response =>
          jsonRes({ ok: false, status: 403, code: "CROSS_SITE_FORBIDDEN", error: "CROSS_SITE_FORBIDDEN" }, 403),
        expectedCode: "CROSS_SITE_FORBIDDEN",
      },
      {
        label: "密码连续输错锁定期返回 403 PASSWORD_LOCKED",
        initData: "signed-data",
        responder: (): Response =>
          jsonRes(
            {
              ok: false,
              status: 403,
              code: "PASSWORD_LOCKED",
              error: "PASSWORD_LOCKED",
              remainingMinutes: 29,
            },
            403
          ),
        expectedCode: "PASSWORD_LOCKED",
      },
      {
        label: "网关返回非 JSON 502 错误响应",
        initData: "signed-data",
        responder: (): Response =>
          new Response("<html>Bad Gateway</html>", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          }),
        expectedCode: "HTTP_502",
      },
      {
        label: "预检请求遭遇网络层拒绝异常",
        initData: "signed-data",
        responder: (): Promise<Response> => Promise.reject(new TypeError("Network unreachable")),
        expectedCode: "ACCESS_DENIED",
      },
    ];

    for (const item of failureCases) {
      resetMiniAppStoreForTest();
      capturedRequests.length = 0;
      (globalThis as { Telegram?: unknown }).Telegram =
        item.initData === undefined ? undefined : { WebApp: { initData: item.initData } };
      seedActiveLocalCredentials("a".repeat(64), "b".repeat(64));
      expect(readMiniAppSessionToken()).toBe("a".repeat(64));
      expect(readMiniAppAssetToken()).toBe("b".repeat(64));

      registerRoute("GET /api/auth/precheck", item.responder);
      await useMiniAppStore.getState().runAccessPrecheck();

      expect(`${item.label} -> ${useMiniAppStore.getState().gateState}`).toBe(`${item.label} -> denied`);
      expect(useMiniAppStore.getState().deniedDiag?.code).toBe(item.expectedCode);
      expect(readMiniAppSessionToken()).toBe("");
      expect(readMiniAppAssetToken()).toBe("");
      expect(localStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
      expect(sessionStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
      expect(capturedRequests.map((req: CapturedRequest): string => req.routeKey)).toEqual([
        "GET /api/auth/precheck",
      ]);

      const deniedHtml: string = assertRenderedGateView("denied");
      expect(deniedHtml).toContain(item.expectedCode);
    }

    // 验证 AccessDeniedPage 对任意不可信诊断字段严格执行 HTML 转义，防止反射型 XSS。
    useMiniAppStore.setState({
      gateState: "denied",
      deniedDiag: {
        requestId: "<script>alert(1)</script>",
        timestamp: "2026-11-13 00:00:00 UTC",
        clientIp: "\"><img src=x onerror=alert(2)>",
        host: "<svg onload=alert(3)>",
        path: "/api/<iframe src=javascript:alert(4)>",
        status: 403,
        code: "FORBIDDEN_USER",
        error: "<script>evil()</script>",
      },
    });
    const escapedHtml: string = assertRenderedGateView("denied");
    expect(escapedHtml).not.toContain("<script>");
    expect(escapedHtml).not.toContain("<svg onload=");
    expect(escapedHtml).not.toContain("<iframe");
    expect(escapedHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapedHtml).toContain("&lt;svg onload=alert(3)&gt;");
  });

  test("预检要求二次认证（未解锁、会话已过期或本地存储令牌损坏）时严格进入 AuthGatePage，绝不挂载 AppShell 或泄露失效令牌", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "valid-superadmin-initdata", initDataUnsafe: { user: { id: 10001 } } },
    };

    seedActiveLocalCredentials("c".repeat(64), "d".repeat(64));
    const headersWithoutSession: Record<string, string> = buildMiniAppAuthHeaders(false);
    expect(headersWithoutSession[MINI_APP_INIT_DATA_HEADER]).toBe("valid-superadmin-initdata");
    expect(headersWithoutSession.Authorization).toBe(
      `${MINI_APP_TMA_AUTH_PREFIX}valid-superadmin-initdata`
    );
    expect(headersWithoutSession[MINI_APP_SESSION_HEADER]).toBeUndefined();

    // 1. 密码模式预检未携带有效会话 -> 停留在 AuthGatePage（password 输入框）。
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes({ ok: true, ttlMs: MINI_APP_SESSION_TTL_MS, totpEnabled: false, authMode: "password" })
    );
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().authMode).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppAssetToken()).toBe("");
    const pwGateHtml: string = assertRenderedGateView("password");
    expect(pwGateHtml).toContain('type="password"');

    // 未解锁态构造图库图片或下载 URL 仅携带 initData，绝不携带 assetToken 或失效 session。
    expect(buildMiniAppGalleryImageUrl("pic.png")).toBe(
      "./api/gallery/file/pic.png?initData=valid-superadmin-initdata"
    );
    expect(buildMiniAppGalleryDownloadUrl("pic.png")).toBe(
      "./api/gallery/download/pic.png?initData=valid-superadmin-initdata"
    );

    // 2. TOTP 模式预检未解锁 -> 停留在 AuthGatePage（6 位数字动态码输入框）。
    resetMiniAppStoreForTest();
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes({ ok: true, ttlMs: MINI_APP_SESSION_TTL_MS, totpEnabled: true, authMode: "totp" })
    );
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().authMode).toBe("totp");
    const totpGateHtml: string = assertRenderedGateView("password");
    expect(totpGateHtml).toContain('inputMode="numeric"');
    expect(totpGateHtml).toContain('maxLength="6"');

    // 3. 服务端返回 sessionValid: true 但到期时间戳已过期 -> 拒绝解锁，清理凭据并进入 AuthGatePage。
    resetMiniAppStoreForTest();
    seedActiveLocalCredentials("e".repeat(64), "f".repeat(64));
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        sessionValid: true,
        sessionExpiresAt: Date.now() - 5_000,
        assetToken: "f".repeat(64),
      })
    );
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppAssetToken()).toBe("");
    assertRenderedGateView("password");

    // 4. 本地 Web Storage 被注入非 64 位十六进制的畸形令牌 -> 读取即自毁，预检后仍停留在 AuthGatePage。
    resetMiniAppStoreForTest();
    localStoreFixture.setItem(
      MINI_APP_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: "malformed-non-hex-token",
        expiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
        assetToken: "1".repeat(64),
      })
    );
    expect(readMiniAppSessionToken()).toBe("");
    expect(localStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        sessionValid: true,
        sessionExpiresAt: Date.now() + 60_000,
      })
    );
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    assertRenderedGateView("password");
  });

  test("门禁密码或 TOTP 输错保持锁定在 AuthGatePage，连续输错触发 PASSWORD_LOCKED 时立即降级至 AccessDeniedPage", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "valid-superadmin-initdata" },
    };
    useMiniAppStore.setState({ gateState: "password", authMode: "totp", passwordInput: "123456" });

    registerRoute("POST /api/auth/login", (): Response =>
      jsonRes(
        {
          ok: false,
          status: 403,
          code: "INVALID_TOTP_CODE",
          error: "INVALID_TOTP_CODE",
          remainingAttempts: 2,
        },
        403
      )
    );
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().passwordError).toBe(zh.serverNotice("INVALID_TOTP_CODE", { remainingAttempts: 2 }));
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppAssetToken()).toBe("");
    assertRenderedGateView("password");

    // 第 3 次错误返回 PASSWORD_LOCKED -> 自动重跑 precheck 并切入 AccessDeniedPage。
    registerRoute("POST /api/auth/login", (): Response =>
      jsonRes(
        {
          ok: false,
          status: 403,
          code: "PASSWORD_LOCKED",
          error: "PASSWORD_LOCKED",
          remainingMinutes: 30,
        },
        403
      )
    );
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes(
        {
          ok: false,
          status: 403,
          code: "PASSWORD_LOCKED",
          error: "PASSWORD_LOCKED",
          remainingMinutes: 30,
        },
        403
      )
    );
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    expect(useMiniAppStore.getState().deniedDiag?.code).toBe("PASSWORD_LOCKED");
    assertRenderedGateView("denied");
  });

  test("logout() 立即擦除内存与 Web Storage 令牌、结算确认弹窗并退回 AuthGatePage，后续任何请求不再携带旧会话头", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "valid-superadmin-initdata" },
    };
    const activeToken: string = "7".repeat(64);
    const activeAsset: string = "8".repeat(64);
    seedActiveLocalCredentials(activeToken, activeAsset);
    useMiniAppStore.setState({
      gateState: "unlocked",
      sessionExpiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
      sidebarOpen: true,
      langMenuOpen: true,
    });
    const confirmPromise: Promise<boolean> = useMiniAppStore
      .getState()
      .requestConfirm("confirm-dangerous-op", "danger");

    registerRoute("POST /api/auth/logout", (): Response => jsonRes({ ok: true, revoked: true }));
    registerRoute("GET /api/status", (): Response =>
      jsonRes({ code: "PASSWORD_REQUIRED", error: "PASSWORD_REQUIRED" }, 401)
    );

    useMiniAppStore.getState().logout(zh.lockSessionToast);

    // 同步断言：本地令牌、资源令牌、Web Storage、弹窗与侧栏状态均已立即清空并退回密码门禁。
    expect(await confirmPromise).toBeFalse();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().sidebarOpen).toBeFalse();
    expect(useMiniAppStore.getState().langMenuOpen).toBeFalse();
    expect(useMiniAppStore.getState().sessionExpiresAt).toBe(0);
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppSessionExpiresAt()).toBe(0);
    expect(readMiniAppAssetToken()).toBe("");
    expect(localStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
    expect(sessionStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
    assertRenderedGateView("password");

    // 核验登出请求携带了待吊销的旧令牌与 keepalive 标记。
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.routeKey).toBe("POST /api/auth/logout");
    expect(capturedRequests[0]?.keepalive).toBeTrue();
    expect(capturedRequests[0]?.headers[MINI_APP_SESSION_HEADER]).toBe(activeToken);

    // 登出后发起任何后续 API 请求、构造请求头或图库 URL，均不再附带已吊销的会话或资源令牌。
    expect(buildMiniAppAuthHeaders(true)[MINI_APP_SESSION_HEADER]).toBeUndefined();
    expect(buildMiniAppGalleryImageUrl("a.png")).not.toContain(activeAsset);
    expect(buildMiniAppGalleryDownloadUrl("a.png")).not.toContain(activeToken);

    await expect(miniAppFetchJson("./api/status")).rejects.toThrow("[PASSWORD_REQUIRED]");
    expect(capturedRequests[1]?.routeKey).toBe("GET /api/status");
    expect(capturedRequests[1]?.headers[MINI_APP_SESSION_HEADER]).toBeUndefined();
  });

  test("会话中任意业务 API 或各领域 Store 收到 401 PASSWORD_REQUIRED / 403 PASSWORD_LOCKED 及 45 分钟到期时立即清除凭据并锁定", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "valid-superadmin-initdata" },
    };

    // 1. 传输层：普通 JSON、图库上传、图库下载收到 401 PASSWORD_REQUIRED 均立即擦除令牌并附带 [PASSWORD_REQUIRED] 前缀。
    registerRoute("POST /api/gallery/upload", (): Response =>
      jsonRes({ code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" }, 401)
    );
    seedActiveLocalCredentials("1".repeat(64), "2".repeat(64));
    await expect(uploadMiniAppGalleryImageBytes(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "[PASSWORD_REQUIRED] SESSION_EXPIRED"
    );
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppAssetToken()).toBe("");

    registerRoute("GET /api/gallery/download/a.png", (): Response =>
      jsonRes({ code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" }, 401)
    );
    seedActiveLocalCredentials("1".repeat(64), "2".repeat(64));
    await expect(downloadMiniAppGalleryImageByName("a.png", "1.png")).rejects.toThrow(
      "[PASSWORD_REQUIRED] SESSION_EXPIRED"
    );
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppAssetToken()).toBe("");

    // 2. 各业务页面 Store 遇到 401 PASSWORD_REQUIRED 时均通过 notify 立即把根门禁锁定回 AuthGatePage。
    interface StoreRevocationAction {
      readonly name: string;
      readonly run: () => Promise<void>;
    }

    const unauthorizedResponder: MockRouteHandler = (): Response =>
      jsonRes({ code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" }, 401);
    for (const key of [
      "GET /api/status",
      "GET /api/mood",
      "GET /api/chats",
      "GET /api/chats/-1001/messages",
      "GET /api/identities/whitelist",
      "POST /api/identities/permission",
      "GET /api/gallery",
      "GET /api/totp",
    ]) {
      registerRoute(key, unauthorizedResponder);
    }

    const storeActions: readonly StoreRevocationAction[] = [
      {
        name: "StatusStore.loadStatus(true)",
        run: async (): Promise<void> => {
          const s = createStatusStore();
          await s.getState().loadStatus(true);
        },
      },
      {
        name: "ChatsStore.loadChatList",
        run: async (): Promise<void> => {
          const s = createChatsStore();
          await s.getState().loadChatList();
        },
      },
      {
        name: "MessagesStore.loadMessages",
        run: async (): Promise<void> => {
          const s = createMessagesStore();
          await s.getState().loadMessages(-1001, 1, 10);
        },
      },
      {
        name: "IdentitiesStore.loadCurrentList",
        run: async (): Promise<void> => {
          const s = createIdentitiesStore();
          await s.getState().loadCurrentList();
        },
      },
      {
        name: "PermissionDrawerStore.togglePermission",
        run: async (): Promise<void> => {
          const s = createPermissionDrawerStore((): void => {});
          await s.getState().togglePermission(12345, "all", true);
        },
      },
      {
        name: "GalleryStore.loadGallery",
        run: async (): Promise<void> => {
          const s = createGalleryStore();
          await s.getState().loadGallery();
        },
      },
      {
        name: "TotpStore.loadTotpStatus",
        run: async (): Promise<void> => {
          const s = createTotpStore();
          await s.getState().loadTotpStatus();
        },
      },
    ];

    for (const action of storeActions) {
      seedActiveLocalCredentials("3".repeat(64), "4".repeat(64));
      useMiniAppStore.setState({
        gateState: "unlocked",
        sessionExpiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
      });
      capturedRequests.length = 0;

      await action.run();
      await Bun.sleep(MINI_APP_MIN_LOADING_MS + 30);

      expect(`${action.name} -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${action.name} -> password`
      );
      expect(readMiniAppSessionToken()).toBe("");
      expect(readMiniAppAssetToken()).toBe("");
      assertRenderedGateView("password");

      // 锁定后再次请求不再附带旧的 X-Mini-App-Session 头。
      capturedRequests.length = 0;
      await expect(miniAppFetchJson("./api/status")).rejects.toThrow("[PASSWORD_REQUIRED]");
      expect(capturedRequests[0]?.headers[MINI_APP_SESSION_HEADER]).toBeUndefined();
    }

    // 3. 会话中收到 403 PASSWORD_LOCKED 时立即擦除凭据、回到 checking 并经重预检落入 AccessDeniedPage。
    seedActiveLocalCredentials("5".repeat(64), "6".repeat(64));
    useMiniAppStore.setState({
      gateState: "unlocked",
      sessionExpiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
    });
    registerRoute("GET /api/totp", (): Response =>
      jsonRes({ code: "PASSWORD_LOCKED", error: "PASSWORD_LOCKED", remainingMinutes: 30 }, 403)
    );
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes({ ok: false, status: 403, code: "PASSWORD_LOCKED", error: "PASSWORD_LOCKED" }, 403)
    );
    const totpStore = createTotpStore();
    await totpStore.getState().loadTotpStatus();
    expect(useMiniAppStore.getState().gateState).toBe("checking");
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppAssetToken()).toBe("");
    assertRenderedGateView("checking");

    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    assertRenderedGateView("denied");

    // 4. 45 分钟本地会话定时器到期时自动擦除凭据并锁定回 AuthGatePage。
    jest.useFakeTimers();
    const shortTtlMs: number = 5_000;
    const tokenBeforeTimer: string = "9".repeat(64);
    seedActiveLocalCredentials(tokenBeforeTimer, "a".repeat(64));
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        sessionValid: true,
        sessionExpiresAt: Date.now() + shortTtlMs,
        assetToken: "a".repeat(64),
      })
    );
    await useMiniAppStore.getState().runAccessPrecheck();
    expect(useMiniAppStore.getState().gateState).toBe("unlocked");
    assertRenderedGateView("unlocked");

    jest.advanceTimersByTime(shortTtlMs + 100);
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppAssetToken()).toBe("");
    assertRenderedGateView("password");
  });

  test("静默后台轮询（statusStore.loadMood / statusStore.loadStatus(false) / chatsStore.pollRunningBatchKick）收到 401 或 403 时立即清除令牌并锁定控制台", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "valid-superadmin-initdata" },
    };

    const statusSnapshotFixture: Readonly<MiniAppStatusView> = {
      generatedAt: 1_700_000_000_000,
      uptimeMs: 60_000,
      cpuAveragePercent: 1.5,
      memoryPeakRssBytes: 64_000_000,
      memoryCurrentRssBytes: 48_000_000,
      memoryOtherBytes: 16_000_000,
      memoryTotalBytes: 64_000_000,
      memoryHeapUsedBytes: 32_000_000,
      managedChatCount: 1,
      whitelistCount: 0,
      blocklistCount: 0,
      activeSessions: { total: 0, gag: 0, wed: 0, verify: 0, qaSet: 0 },
      telegramOutbound: {
        inFlight: 0,
        maxConcurrency: 30,
        waiting: 0,
        retryQueueSize: 0,
        retryQueueMax: 128,
      },
      capabilities: [],
    };

    const runningBatchKickDetailFixture: Readonly<MiniAppChatDetail> = {
      chatId: -1001,
      title: "Managed Supergroup",
      features: {
        init: true,
        aiChat: false,
        translation: false,
        adDetect: false,
        floodControl: false,
        antiRaid: false,
        proxySend: false,
      },
      hotMessageCount: 0,
      qaPairCount: 0,
      isLockdownActive: false,
      hotMessageMax: 256,
      quietRemainingMs: 0,
      lockdownRemainingMs: 0,
      botPermissions: null,
      translateTargetCount: 0,
      deleteMessageTargetCount: 0,
      joinedCountsByHour: new Array<number>(24).fill(0),
      batchKickRunning: true,
      lastBatchKickCompletion: null,
      activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
    };

    interface BackgroundPollCase {
      readonly name: string;
      readonly routeKey: string;
      readonly prepareAndPoll: (registerTarget: () => void) => Promise<void>;
    }

    const backgroundPollCases: readonly BackgroundPollCase[] = [
      {
        name: "statusStore.loadMood()",
        routeKey: "GET /api/mood",
        prepareAndPoll: async (registerTarget: () => void): Promise<void> => {
          const statusStore: MiniAppStatusStore = createStatusStore();
          registerTarget();
          await statusStore.getState().loadMood();
        },
      },
      {
        name: "statusStore.loadStatus(false) [post-snapshot silent poll]",
        routeKey: "GET /api/status",
        prepareAndPoll: async (registerTarget: () => void): Promise<void> => {
          const statusStore: MiniAppStatusStore = createStatusStore();
          registerRoute("GET /api/status", (): Response => jsonRes(statusSnapshotFixture));
          await statusStore.getState().loadStatus(false);
          expect(statusStore.getState().status).not.toBeNull();
          registerTarget();
          await statusStore.getState().loadStatus(false);
        },
      },
      {
        name: "chatsStore.pollRunningBatchKick()",
        routeKey: "GET /api/chats/-1001",
        prepareAndPoll: async (registerTarget: () => void): Promise<void> => {
          const chatsStore: MiniAppChatsStore = createChatsStore();
          chatsStore.setState({
            selectedChatId: -1001,
            chatDetail: runningBatchKickDetailFixture,
            batchKickSubmitting: false,
          });
          registerTarget();
          await chatsStore.getState().pollRunningBatchKick();
        },
      },
    ];

    // 1. 后台静默轮询收到 401 PASSWORD_REQUIRED 时立即清空本地令牌并将 gateState 锁定回 password。
    for (const pollCase of backgroundPollCases) {
      seedActiveLocalCredentials("b".repeat(64), "c".repeat(64));
      useMiniAppStore.setState({
        gateState: "unlocked",
        sessionExpiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
      });

      await pollCase.prepareAndPoll((): void => {
        registerRoute(pollCase.routeKey, (): Response =>
          jsonRes({ code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" }, 401)
        );
      });

      expect(`${pollCase.name} 401 -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${pollCase.name} 401 -> password`
      );
      expect(readMiniAppSessionToken()).toBe("");
      expect(readMiniAppAssetToken()).toBe("");
      expect(localStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
      expect(sessionStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
      assertRenderedGateView("password");
    }

    // 2. 后台静默轮询收到 403 PASSWORD_LOCKED 时立即清空本地令牌、切回 checking 并经重预检落入 denied。
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes({ ok: false, status: 403, code: "PASSWORD_LOCKED", error: "PASSWORD_LOCKED" }, 403)
    );
    for (const pollCase of backgroundPollCases) {
      seedActiveLocalCredentials("d".repeat(64), "e".repeat(64));
      useMiniAppStore.setState({
        gateState: "unlocked",
        sessionExpiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
      });

      await pollCase.prepareAndPoll((): void => {
        registerRoute(pollCase.routeKey, (): Response =>
          jsonRes({ code: "PASSWORD_LOCKED", error: "PASSWORD_LOCKED", remainingMinutes: 30 }, 403)
        );
      });

      expect(`${pollCase.name} 403 -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${pollCase.name} 403 -> checking`
      );
      expect(readMiniAppSessionToken()).toBe("");
      expect(readMiniAppAssetToken()).toBe("");
      expect(localStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
      expect(sessionStoreFixture.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();
      assertRenderedGateView("checking");

      await useMiniAppStore.getState().runAccessPrecheck();
      expect(`${pollCase.name} precheck -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${pollCase.name} precheck -> denied`
      );
      assertRenderedGateView("denied");
    }
  });
});
