/**
 * Mini App 服务端全路由未授权访问与安全回归矩阵测试：
 * - 与 `createMiniAppBunRoutes()` 做 1:1 穷举比对，确保零遗漏覆盖全部已注册路由与 HTTP 方法及未知 `/api/*`、受保护图片后缀兜底路径；
 * - 逐项核验外部浏览器裸请求、`headerGuard` 快路径防跨站/防直接导航/畸形凭据、`initData` 篡改与时效越界、非 SuperAdmin 合法签名、仅携带 SuperAdmin `initData` 缺少二次会话、伪造/过期/已注销/TOTP 变更后失效会话、密码与 TOTP 暴力破解锁定、Picker 伪造共享消息、图库文件名穿越与符号链接逃逸、HTTP 方法失配、URL 编码绕过、超大 JSON 请求体以及安全响应头；
 * - 断言所有拦截响应均携带 `no-store` 防缓存头、脱敏源站 IP 字面量，且业务状态快照在全量攻击扫描前后零突变。
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "grammy/types";
import { imageFixture } from "../helpers/image";
import {
  buildSignedTestInitData,
  installMiniAppTestDiskIOMock,
  miniAppTestBlocklistRows,
  miniAppTestWhitelistRows,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { latestAiMemories } = await import("../../packages/cache/main/aiChat");
const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { resetIdentityStorageCache } = await import("../../packages/cache/main/identityStorage");
const {
  miniAppAuthSessions,
  miniAppCompletedPickerResults,
  miniAppPasswordGuardHolder,
  miniAppPendingPickers,
  miniAppPendingTotpSetupHolder,
  miniAppTotpRecordHolder,
} = await import("../../packages/cache/main/miniApp");
const { chatQaEntries } = await import("../../packages/cache/main/qa");
const { getAssetConfig } = await import("../../packages/config/assets");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const {
  MINI_APP_ASSET_CACHE_CONTROL,
  MINI_APP_AUTH_CLOCK_SKEW_SECONDS,
  MINI_APP_AUTH_MAX_AGE_SECONDS,
  MINI_APP_CSP_HEADER_VALUE,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_MAX_INIT_DATA_LENGTH,
  MINI_APP_MAX_JSON_BODY_BYTES,
  MINI_APP_NO_STORE_CACHE_CONTROL,
  MINI_APP_PAGE_GATE_COOKIE_NAME,
  MINI_APP_PASSWORD_LOCKOUT_MS,
  MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_REFRESH_THRESHOLD_MS,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_TMA_AUTH_PREFIX,
  MINI_APP_X_FRAME_OPTIONS_VALUE,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_TOTP_PENDING_TTL_MS,
  MINI_APP_TOTP_RECORD_VERSION,
  MINI_APP_TOTP_STEP_SECONDS,
} = await import("../../packages/consts/miniAppTotp");
const { MINI_APP_TOTP_MEMORY_DIR } = await import("../../packages/consts/paths");
const { getOrCreateChatState } = await import("../../packages/infra/chatStateStorage");
const { deriveMiniAppAssetToken } = await import("../../packages/libs/miniAppAuth");
const { generateMiniAppTotpCodeAt } = await import("../../packages/libs/miniAppTotp");
const {
  createMiniAppBunRoutes,
  getMiniAppPickerResult,
  handleMiniAppSharedMessage,
  issueMiniAppAuthSession,
  prepareMiniAppPicker,
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { revokeOtherMiniAppAuthSessions } = await import(
  "../../packages/mini-app-api-server/auth/session"
);
const { dispatchMiniAppTestRequest } = await import("../helpers/miniAppRequest");
import type {
  MiniAppAccessDiagnostics,
  MiniAppAuthSession,
  MiniAppLoginSuccessResponse,
} from "../../packages/types/miniApp/auth";
import type { MiniAppGalleryUploadResult } from "../../packages/types/miniApp/gallery";
import type {
  MiniAppTotpMutationResponse,
  MiniAppTotpSetupResponse,
  MiniAppTotpStatusView,
} from "../../packages/types/miniAppTotp";

/** 单条受保护路由描述项（用于全路由未授权访问矩阵扫描与路由表 1:1 校验）。 */
interface ProtectedRouteDescriptor {
  readonly method: string;
  readonly routePattern: string;
  readonly tier: "initDataOnly" | "sessionRequired";
  readonly buildPath: (galleryFileName: string, pickerRequestId: number) => string;
  readonly jsonBody?: string;
  readonly binaryUpload?: boolean;
}

/** 业务状态不可变性快照，用于断言未授权请求零副作用。 */
interface BusinessStateSnapshot {
  readonly whitelistEntries: readonly (readonly [number, string])[];
  readonly blocklistEntries: readonly (readonly [number, string])[];
  readonly chatSnapshot: string;
  readonly qaEntries: readonly (readonly [string, string])[];
  readonly pendingPickerSize: number;
  readonly completedPickerSize: number;
  readonly galleryFileExists: boolean;
  readonly totpSecret: string | null | undefined;
}

/** 已种子化的业务夹具上下文。 */
interface SeededSecurityFixture {
  readonly galleryFileName: string;
  readonly validPngBytes: Uint8Array;
  readonly pickerRequestId: number;
}

/** 发送测试请求的入参选项。 */
interface SendSecurityRequestOptions {
  readonly path: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

/** 测试夹具使用的受管群 ID、名单初始 ID 与非超管入侵者 ID。 */
const TEST_CHAT_ID: number = -100998877;
const SEEDED_WHITELIST_ID: number = 610_001;
const SEEDED_BLOCKLIST_ID: number = 620_002;
const NON_ADMIN_USER_ID: number = SUPER_ADMIN_USER_ID + 777;

/** 公开探活、图标与单页门控入口路由模式集合（未授权请求访问单页入口时仅返回独立 `reject.html`，绝不返回完整前端包或业务数据）。 */
const PUBLIC_ROUTE_PATTERNS: ReadonlySet<string> = new Set<string>([
  "/healthz",
  "/",
  "/index.html",
  "/favicon.ico",
]);

/**
 * 构造静态路径或参数化路径的受保护路由描述项。
 * @param method 大写 HTTP 方法。
 * @param routePattern `createMiniAppBunRoutes()` 注册的路由模板。
 * @param extra 鉴权层级与请求体选项。
 * @returns 规范化后的受保护路由描述项。
 */
function defineProtectedRoute(
  method: string,
  routePattern: string,
  extra: {
    readonly tier?: "initDataOnly" | "sessionRequired";
    readonly query?: string;
    readonly jsonBody?: string;
    readonly binaryUpload?: boolean;
  } = {}
): ProtectedRouteDescriptor {
  return {
    method,
    routePattern,
    tier: extra.tier ?? "sessionRequired",
    jsonBody: extra.jsonBody,
    binaryUpload: extra.binaryUpload,
    buildPath: (galleryFileName: string, pickerRequestId: number): string => {
      const base: string = routePattern
        .replace(":chatId", String(TEST_CHAT_ID))
        .replace(":fileName", galleryFileName);
      if (routePattern === "/api/picker/result") {
        return `${base}?requestId=${pickerRequestId}`;
      }
      return extra.query !== undefined ? `${base}?${extra.query}` : base;
    },
  };
}

/** 全部受保护 Mini App 路由与 HTTP 方法穷举表（必须与 `createMiniAppBunRoutes()` 严格一致）。 */
const PROTECTED_ROUTE_DESCRIPTORS: readonly Readonly<ProtectedRouteDescriptor>[] = [
  defineProtectedRoute("GET", "/api/auth/precheck", { tier: "initDataOnly" }),
  defineProtectedRoute("POST", "/api/auth/login", {
    tier: "initDataOnly",
    jsonBody: JSON.stringify({ password: getBotMiniAppConfig()?.password ?? "unused-pw" }),
  }),
  defineProtectedRoute("POST", "/api/auth/logout", { tier: "initDataOnly" }),
  defineProtectedRoute("GET", "/api/status"),
  defineProtectedRoute("GET", "/api/mood"),
  defineProtectedRoute("POST", "/api/mood/switch", { jsonBody: "{}" }),
  defineProtectedRoute("GET", "/api/chats"),
  defineProtectedRoute("GET", "/api/chats/:chatId"),
  defineProtectedRoute("GET", "/api/chats/:chatId/messages", { query: "page=1&pageSize=10" }),
  defineProtectedRoute("POST", "/api/chats/:chatId/feature", {
    jsonBody: JSON.stringify({ feature: "aiChat", enabled: false }),
  }),
  defineProtectedRoute("POST", "/api/chats/:chatId/batch-kick", {
    jsonBody: JSON.stringify({ hours: 6 }),
  }),
  defineProtectedRoute("GET", "/api/chats/:chatId/targets"),
  defineProtectedRoute("POST", "/api/chats/:chatId/targets", {
    jsonBody: JSON.stringify({ action: "setQa", question: "unauth-q", answer: "unauth-a" }),
  }),
  defineProtectedRoute("GET", "/api/identities/whitelist", { query: "page=1&pageSize=10" }),
  defineProtectedRoute("POST", "/api/identities/whitelist", {
    jsonBody: JSON.stringify({ action: "add", id: 999_111 }),
  }),
  defineProtectedRoute("GET", "/api/identities/blocklist", { query: "page=1&pageSize=10" }),
  defineProtectedRoute("POST", "/api/identities/blocklist", {
    jsonBody: JSON.stringify({ action: "add", id: 999_222 }),
  }),
  defineProtectedRoute("POST", "/api/identities/permission", {
    jsonBody: JSON.stringify({ id: SEEDED_WHITELIST_ID, action: "toggle", capability: "aiChat" }),
  }),
  defineProtectedRoute("POST", "/api/picker/prepare", {
    jsonBody: JSON.stringify({ targetList: "whitelist", subjectKind: "users" }),
  }),
  defineProtectedRoute("GET", "/api/picker/result"),
  defineProtectedRoute("GET", "/api/gallery", { query: "page=1&pageSize=10" }),
  defineProtectedRoute("POST", "/api/gallery/upload", { binaryUpload: true }),
  defineProtectedRoute("POST", "/api/gallery/delete", {
    jsonBody: JSON.stringify({ fileName: "keep.png" }),
  }),
  defineProtectedRoute("GET", "/api/gallery/download/:fileName"),
  defineProtectedRoute("HEAD", "/api/gallery/download/:fileName"),
  defineProtectedRoute("GET", "/api/gallery/file/:fileName"),
  defineProtectedRoute("HEAD", "/api/gallery/file/:fileName"),
  defineProtectedRoute("DELETE", "/api/gallery/file/:fileName"),
  defineProtectedRoute("GET", "/api/totp"),
  defineProtectedRoute("DELETE", "/api/totp"),
  defineProtectedRoute("POST", "/api/totp/setup"),
  defineProtectedRoute("POST", "/api/totp/enable", { jsonBody: JSON.stringify({ code: "000000" }) }),
  defineProtectedRoute("POST", "/api/totp/delete"),
];

/** 未注册 `/api/*` 别名路径与未知图片后缀路径兜底扫描集合。 */
const UNKNOWN_FALLBACK_ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/api/whitelist"],
  ["POST", "/api/whitelist"],
  ["GET", "/api/blocklist"],
  ["POST", "/api/blocklist"],
  ["POST", `/api/chats/${TEST_CHAT_ID}/features`],
  ["POST", `/api/chats/${TEST_CHAT_ID}/kick-inactive`],
  ["GET", "/api/picker/result/arbitrary-token"],
  ["POST", "/api/totp/disable"],
  ["GET", "/api/unknown/probe"],
  ["GET", "/secret-asset.png"],
  ["GET", "/nested/diagram.svg"],
];

/**
 * 生成指定用户与时间戳的合法签名 `initData` 原始查询串。
 * @param userId Telegram 用户 ID。
 * @param authDate 签名秒级时间戳（默认当前时刻）。
 * @param botToken 签名使用的 Bot Token（默认 `BOT_TOKEN`）。
 * @returns 带有效 HMAC-SHA256 `hash` 的查询串。
 */
function signInitDataForUser(
  userId: number,
  authDate: number = Math.floor(Date.now() / 1_000),
  botToken: string = BOT_TOKEN
): string {
  return buildSignedTestInitData({
    botToken,
    authDate,
    user: {
      id: userId,
      first_name: userId === SUPER_ADMIN_USER_ID ? "SuperAdmin" : "Intruder",
      username: userId === SUPER_ADMIN_USER_ID ? "super_admin" : "intruder_user",
    },
  });
}

/**
 * 构造同时携带合法 SuperAdmin `initData` 与新签发 45 分钟有效会话的请求头。
 * @returns 已解锁的请求头字典。
 */
function unlockedSuperAdminHeaders(): Record<string, string> {
  return {
    [MINI_APP_INIT_DATA_HEADER]: signInitDataForUser(SUPER_ADMIN_USER_ID),
    [MINI_APP_SESSION_HEADER]: issueMiniAppAuthSession().token,
  };
}

/**
 * 向进程内 Mini App 路由分发器发送单次 HTTP 请求（模拟 IPv4 回环 Host 以同时验证源站 IP 脱敏）。
 * @param options 请求路径、方法、头与请求体。
 * @returns 服务端 `Response`。
 */
function sendSecurityRequest({
  path,
  method = "GET",
  headers = {},
  body,
}: SendSecurityRequestOptions): Promise<Response> {
  return dispatchMiniAppTestRequest(
    new Request(`http://127.0.0.1:3000${path}`, { method, headers, body })
  );
}

/**
 * 按路由描述项与附加鉴权头发送请求。
 * @param route 受保护路由描述项。
 * @param fixture 业务夹具。
 * @param baseHeaders 附加请求头。
 * @returns 服务端 `Response`。
 */
function dispatchDescriptorRequest(
  route: Readonly<ProtectedRouteDescriptor>,
  fixture: Readonly<SeededSecurityFixture>,
  baseHeaders: Readonly<Record<string, string>>
): Promise<Response> {
  const headers: Record<string, string> = { ...baseHeaders };
  let body: string | Uint8Array | undefined;
  if (route.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = route.jsonBody;
  } else if (route.binaryUpload === true) {
    headers["Content-Type"] = "application/octet-stream";
    body = fixture.validPngBytes;
  }
  return sendSecurityRequest({
    path: route.buildPath(fixture.galleryFileName, fixture.pickerRequestId),
    method: route.method,
    headers,
    body,
  });
}

/**
 * 断言单次未授权响应满足预期状态码、诊断错误码、`no-store` 防缓存头与源站 IP 字面量脱敏。
 * @param response 待核验的 HTTP 响应。
 * @param expectedStatus 预期 HTTP 状态码。
 * @param expectedCode 预期诊断 `code`。
 */
async function assertBlockedDiagnostics(
  response: Response,
  expectedStatus: number,
  expectedCode: string
): Promise<void> {
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("cache-control")).toBe(MINI_APP_NO_STORE_CACHE_CONTROL);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const requestIdHeader: string | null = response.headers.get("x-request-id");
  expect(requestIdHeader).toMatch(/^[0-9a-f]{16}$/u);
  if (response.body === null) return;
  const rawText: string = await response.text();
  if (rawText.length === 0) return;
  const diag: MiniAppAccessDiagnostics = JSON.parse(rawText) as MiniAppAccessDiagnostics;
  expect(diag.status).toBe(expectedStatus);
  expect(diag.code).toBe(expectedCode);
  expect(diag.requestId).toBe(requestIdHeader ?? "");
  expect(diag.host).not.toContain("127.0.0.1");
}

/**
 * 初始化受管群、黑白名单、群问答、图库图片与待消费 Picker 会话夹具。
 * @returns 已写入的夹具标识集合。
 */
async function seedProtectedStateFixture(): Promise<SeededSecurityFixture> {
  miniAppTestWhitelistRows.set(
    SEEDED_WHITELIST_ID,
    JSON.stringify({ aiChat: true, command: true })
  );
  miniAppTestBlocklistRows.set(SEEDED_BLOCKLIST_ID, JSON.stringify({ blocked: true }));

  const chatState = getOrCreateChatState(TEST_CHAT_ID);
  chatState.isInitEnabled = true;
  chatState.title = "Protected Security Group";
  chatState.isAIChatEnabled = true;
  chatState.isTranslationEnabled = true;
  chatState.deleteMessageTargets = [700_001];
  chatQaEntries.set(TEST_CHAT_ID, new Map<string, string>([["seed-trigger", "seed-answer"]]));

  const galleryDir: string = getAssetConfig().randomHImageDirectory;
  rmSync(galleryDir, { recursive: true, force: true });
  mkdirSync(galleryDir, { recursive: true });
  const seedPng: Uint8Array = await new Bun.Image(imageFixture(10, 10)).png().bytes();
  const uploadRes: Response = await sendSecurityRequest({
    path: "/api/gallery/upload",
    method: "POST",
    headers: unlockedSuperAdminHeaders(),
    body: seedPng,
  });
  expect(uploadRes.status).toBe(200);
  const uploadJson: MiniAppGalleryUploadResult =
    (await uploadRes.json()) as MiniAppGalleryUploadResult;
  expect(uploadJson.ok).toBeTrue();
  miniAppAuthSessions.clear();

  const prepared = await prepareMiniAppPicker({
    targetList: "whitelist",
    subjectKind: "users",
    api: {
      savePreparedKeyboardButton: async (): Promise<{ readonly id: string }> => ({
        id: "prepared-sec-1",
      }),
    },
  });
  if (!prepared.ok) throw new Error("Failed to seed prepared picker session");

  const attackUploadPng: Uint8Array = await new Bun.Image(imageFixture(14, 14)).png().bytes();
  return {
    galleryFileName: uploadJson.fileName!,
    validPngBytes: attackUploadPng,
    pickerRequestId: prepared.requestId,
  };
}

/**
 * 采集当前内存与临时图库目录的业务状态快照，用于核验未授权请求未造成任何写入或删除。
 * @param galleryFileName 已种子化的图库图片文件名。
 * @returns 序列化可比对的只读快照。
 */
function captureBusinessStateSnapshot(galleryFileName: string): BusinessStateSnapshot {
  const chatState = getOrCreateChatState(TEST_CHAT_ID);
  const galleryPath: string = join(getAssetConfig().randomHImageDirectory, galleryFileName);
  return {
    whitelistEntries: [...miniAppTestWhitelistRows.entries()],
    blocklistEntries: [...miniAppTestBlocklistRows.entries()],
    chatSnapshot: JSON.stringify({
      isInitEnabled: chatState.isInitEnabled,
      isAIChatEnabled: chatState.isAIChatEnabled,
      isTranslationEnabled: chatState.isTranslationEnabled,
      deleteMessageTargets: chatState.deleteMessageTargets,
      translate: chatState.translate,
    }),
    qaEntries: [...(chatQaEntries.get(TEST_CHAT_ID)?.entries() ?? [])],
    pendingPickerSize: miniAppPendingPickers.size,
    completedPickerSize: miniAppCompletedPickerResults.size,
    galleryFileExists: existsSync(galleryPath),
    totpSecret: miniAppTotpRecordHolder.current?.secret,
  };
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  rmSync(getAssetConfig().randomHImageDirectory, { recursive: true, force: true });
  resetMiniAppTestDiskIOState();
  resetIdentityStorageCache();
  resetChatStateCache();
  chatQaEntries.clear();
  latestAiMemories.clear();
  miniAppAuthSessions.clear();
  miniAppPasswordGuardHolder.current = null;
  miniAppPendingTotpSetupHolder.current = null;
  miniAppTotpRecordHolder.current = undefined;
  miniAppPendingPickers.clear();
  miniAppCompletedPickerResults.clear();
  setSystemTime();
});

describe("Mini App 服务端未授权访问全路由安全矩阵", () => {
  test("路由穷举校验：测试矩阵 1:1 覆盖 createMiniAppBunRoutes() 全部非公开路由与 HTTP 方法，未授权单页入口仅返回独立 reject.html 且彻底移除 /_bundle", async () => {
    const routes: Bun.Serve.Routes<undefined, string> = createMiniAppBunRoutes();
    expect(routes["/_bundle"]).toBeUndefined();
    const actualProtectedPairs: string[] = [];
    for (const [pattern, entry] of Object.entries(routes)) {
      if (PUBLIC_ROUTE_PATTERNS.has(pattern)) continue;
      expect(entry !== undefined && typeof entry === "object" && entry !== null).toBeTrue();
      for (const method of Object.keys(entry as Record<string, unknown>)) {
        actualProtectedPairs.push(`${method.toUpperCase()} ${pattern}`);
      }
    }
    const matrixPairs: string[] = PROTECTED_ROUTE_DESCRIPTORS.map(
      (item: Readonly<ProtectedRouteDescriptor>): string => `${item.method} ${item.routePattern}`
    );
    expect([...actualProtectedPairs].sort()).toEqual([...matrixPairs].sort());

    for (const publicPath of ["/", "/index.html"]) {
      const pageRes: Response = await sendSecurityRequest({ path: publicPath });
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get("content-security-policy")).toBe(MINI_APP_CSP_HEADER_VALUE);
      expect(pageRes.headers.get("x-frame-options")).toBe(MINI_APP_X_FRAME_OPTIONS_VALUE);
      expect(pageRes.headers.get("cache-control")).toBe(MINI_APP_NO_STORE_CACHE_CONTROL);
      expect(pageRes.headers.get("x-content-type-options")).toBe("nosniff");
      expect(pageRes.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/u);
      const html: string = await pageRes.text();
      expect(html).toContain("cf-error-page");
      expect(html).toContain('data-code="MISSING_INIT_DATA"');
      expect(html).toContain('data-status="401"');
      expect(html).not.toContain('id="root"');
      expect(html).not.toContain("./chunk-");
      expect(html).not.toContain(BOT_TOKEN);
    }

    const headPageRes: Response = await sendSecurityRequest({ path: "/", method: "HEAD" });
    expect(headPageRes.status).toBe(200);
    expect(headPageRes.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/u);
    expect(await headPageRes.text()).toBe("");

    const hiddenBundleRes: Response = await sendSecurityRequest({ path: "/_bundle" });
    expect(hiddenBundleRes.status).toBe(404);

    const healthRes: Response = await sendSecurityRequest({ path: "/healthz" });
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("cache-control")).toBe(MINI_APP_NO_STORE_CACHE_CONTROL);
    expect(await healthRes.json()).toEqual({ ok: true });
  });

  test("外部浏览器裸请求与 headerGuard 快路径拦截：全量路由与未知兜底路径一律拒绝跨站、直接导航、非法 Origin/Scheme 及畸形凭据，且业务状态零突变", async () => {
    const server = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "sec-test-password-123456",
    });
    expect(server).not.toBeNull();
    const fixture: SeededSecurityFixture = await seedProtectedStateFixture();
    const beforeSnapshot: BusinessStateSnapshot = captureBusinessStateSnapshot(
      fixture.galleryFileName
    );

    // 1. 外部浏览器 / curl 不带任何 Telegram 鉴权头扫描全部已注册路由与未知路径。
    for (const route of PROTECTED_ROUTE_DESCRIPTORS) {
      const res: Response = await dispatchDescriptorRequest(route, fixture, {});
      await assertBlockedDiagnostics(res, 401, "MISSING_INIT_DATA");
    }
    for (const [method, path] of UNKNOWN_FALLBACK_ROUTES) {
      const res: Response = await sendSecurityRequest({ path, method });
      await assertBlockedDiagnostics(res, 401, "MISSING_INIT_DATA");
    }

    // 2. 即使携带合法 SuperAdmin initData + 有效会话，触发 headerGuard 的跨站、导航、跨源、冲突凭据与畸形载荷仍在 O(1) 快路径被拦截。
    const validHeaders: Record<string, string> = unlockedSuperAdminHeaders();
    const validInitData: string = validHeaders[MINI_APP_INIT_DATA_HEADER]!;
    const otherInitData: string = signInitDataForUser(
      SUPER_ADMIN_USER_ID,
      Math.floor(Date.now() / 1_000) - 10
    );
    const filePath: string = `/api/gallery/file/${fixture.galleryFileName}`;

    const headerGuardCases: readonly (readonly [
      string,
      Readonly<Record<string, string>>,
      number,
      string
    ])[] = [
      ["/api/status", { ...validHeaders, "sec-fetch-site": "cross-site" }, 403, "CROSS_SITE_FORBIDDEN"],
      [filePath, { ...validHeaders, "sec-fetch-site": "unexpected-site" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/api/status", { ...validHeaders, "sec-fetch-mode": "navigate" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      ["/api/status", { ...validHeaders, "sec-fetch-mode": "websocket" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      [filePath, { ...validHeaders, "sec-fetch-mode": "websocket" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      [filePath, { ...validHeaders, "sec-fetch-mode": "nested-navigate" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      [filePath, { ...validHeaders, "sec-fetch-dest": "iframe" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      ["/api/status", { ...validHeaders, "sec-fetch-dest": "script" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      ["/api/status", { ...validHeaders, accept: "text/html,application/xhtml+xml" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      ["/api/status", { ...validHeaders, origin: "https://evil.example" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/api/status", { ...validHeaders, origin: "null" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/api/status", { ...validHeaders, origin: "ftp://miniapp.example.com" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/api/status", { ...validHeaders, referer: "https://evil.example/embed" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/api/status", { ...validHeaders, authorization: "Bearer forged-jwt-token" }, 401, "MISSING_INIT_DATA"],
      ["/api/status", { [MINI_APP_INIT_DATA_HEADER]: validInitData, authorization: `${MINI_APP_TMA_AUTH_PREFIX}${otherInitData}` }, 401, "INVALID_SIGNATURE"],
      ["/api/status", { [MINI_APP_INIT_DATA_HEADER]: `auth_date=1&hash=${"a".repeat(MINI_APP_MAX_INIT_DATA_LENGTH)}` }, 401, "MALFORMED_INIT_DATA"],
      ["/api/status", { [MINI_APP_INIT_DATA_HEADER]: `auth_date=1&hash=${"a".repeat(64)}&x=\u0007` }, 401, "MALFORMED_INIT_DATA"],
      ["/api/status", { [MINI_APP_INIT_DATA_HEADER]: "auth_date=1700000000&user=%7B%7D" }, 401, "MALFORMED_INIT_DATA"],
      [`${filePath}?initData=${"x".repeat(MINI_APP_MAX_INIT_DATA_LENGTH + 5)}`, {}, 401, "MALFORMED_INIT_DATA"],
      [`${filePath}?initData=${encodeURIComponent(`auth_date=1&hash=${"a".repeat(64)}&\u0007=1`)}`, {}, 401, "MALFORMED_INIT_DATA"],
      [`${filePath}?initData=only_user_no_hash`, {}, 401, "MALFORMED_INIT_DATA"],
    ];

    for (const [path, headers, status, code] of headerGuardCases) {
      const res: Response = await sendSecurityRequest({ path, headers });
      await assertBlockedDiagnostics(res, status, code);
    }

    expect(captureBusinessStateSnapshot(fixture.galleryFileName)).toEqual(beforeSnapshot);
  });

  test("initData 密码学与结构防篡改矩阵：错签、篡改 user.id、缺 hash、重复键、过期/未来偏移 auth_date、畸形 user 与群聊上下文一律拒绝", async () => {
    const fixture: SeededSecurityFixture = await seedProtectedStateFixture();
    const beforeSnapshot: BusinessStateSnapshot = captureBusinessStateSnapshot(
      fixture.galleryFileName
    );
    const activeSession: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
    const nowSec: number = Math.floor(Date.now() / 1_000);

    const validSuperAdminRaw: string = signInitDataForUser(SUPER_ADMIN_USER_ID, nowSec);
    const flippedLastChar: string = validSuperAdminRaw.endsWith("0") ? "1" : "0";
    const tamperedHashInitData: string = `${validSuperAdminRaw.slice(0, -1)}${flippedLastChar}`;

    const signedForIntruder: URLSearchParams = new URLSearchParams(
      signInitDataForUser(NON_ADMIN_USER_ID, nowSec)
    );
    signedForIntruder.set("user", JSON.stringify({ id: SUPER_ADMIN_USER_ID, first_name: "Escalated" }));

    const tamperedCases: readonly (readonly [string, boolean, number, string])[] = [
      [tamperedHashInitData, true, 401, "INVALID_SIGNATURE"],
      [signInitDataForUser(SUPER_ADMIN_USER_ID, nowSec, "123456:wrong-bot-token"), true, 401, "INVALID_SIGNATURE"],
      [signedForIntruder.toString(), true, 401, "INVALID_SIGNATURE"],
      [`auth_date=${nowSec}&user=%7B%22id%22%3A1%7D&hash=${"z".repeat(64)}`, true, 401, "MALFORMED_INIT_DATA"],
      [`${validSuperAdminRaw}&auth_date=${nowSec}`, true, 401, "MALFORMED_INIT_DATA"],
      [signInitDataForUser(SUPER_ADMIN_USER_ID, nowSec - MINI_APP_AUTH_MAX_AGE_SECONDS - 10), false, 401, "EXPIRED_AUTH_DATE"],
      // 未来偏移超限即使携带有效 45 分钟解锁会话也不可豁免。
      [signInitDataForUser(SUPER_ADMIN_USER_ID, nowSec + MINI_APP_AUTH_CLOCK_SKEW_SECONDS + 10), true, 401, "EXPIRED_AUTH_DATE"],
      [buildSignedTestInitData({ botToken: BOT_TOKEN, authDate: nowSec, extra: { user: "{broken" } }), true, 401, "MALFORMED_INIT_DATA"],
      [buildSignedTestInitData({ botToken: BOT_TOKEN, authDate: nowSec }), true, 401, "MISSING_USER"],
      [buildSignedTestInitData({ botToken: BOT_TOKEN, authDate: nowSec, user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin" }, extra: { chat_type: "supergroup" } }), true, 403, "FORBIDDEN_USER"],
      [buildSignedTestInitData({ botToken: BOT_TOKEN, authDate: nowSec, user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin" }, extra: { chat_type: "channel" } }), true, 403, "FORBIDDEN_USER"],
    ];

    const representativeTargets: readonly string[] = [
      "/api/auth/precheck",
      "/api/status",
      `/api/gallery/file/${fixture.galleryFileName}`,
      `/api/gallery/download/${fixture.galleryFileName}`,
    ];

    for (const [initData, attachSession, status, code] of tamperedCases) {
      for (const targetPath of representativeTargets) {
        const headers: Record<string, string> = { [MINI_APP_INIT_DATA_HEADER]: initData };
        if (attachSession) headers[MINI_APP_SESSION_HEADER] = activeSession.token;
        const res: Response = await sendSecurityRequest({ path: targetPath, headers });
        await assertBlockedDiagnostics(res, status, code);
      }
    }

    expect(captureBusinessStateSnapshot(fixture.galleryFileName)).toEqual(beforeSnapshot);
  });

  test("非 SuperAdmin 合法签名与 Picker 伪造防护：全量路由（含 precheck、login、logout、图库与 TOTP）一律 403 FORBIDDEN_USER，伪造共享消息零入库", async () => {
    const server = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "sec-test-password-123456",
    });
    expect(server).not.toBeNull();
    const fixture: SeededSecurityFixture = await seedProtectedStateFixture();
    const adminSession: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
    const beforeSnapshot: BusinessStateSnapshot = captureBusinessStateSnapshot(
      fixture.galleryFileName
    );
    const nonAdminHeaders: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: signInitDataForUser(NON_ADMIN_USER_ID),
      [MINI_APP_SESSION_HEADER]: adminSession.token,
    };

    for (const route of PROTECTED_ROUTE_DESCRIPTORS) {
      const res: Response = await dispatchDescriptorRequest(route, fixture, nonAdminHeaders);
      await assertBlockedDiagnostics(res, 403, "FORBIDDEN_USER");
    }
    for (const [method, path] of UNKNOWN_FALLBACK_ROUTES) {
      const res: Response = await sendSecurityRequest({ path, method, headers: nonAdminHeaders });
      await assertBlockedDiagnostics(res, 403, "FORBIDDEN_USER");
    }

    // 非 SuperAdmin 请求 /api/auth/logout 不得越权吊销 SuperAdmin 的在途会话。
    expect(miniAppAuthSessions.has(adminSession.token)).toBeTrue();

    // 伪造非 SuperAdmin 私聊或群聊发来的 users_shared 消息不得消费预备 Picker 会话或污染名单。
    const spoofedNonAdminShare: Message = {
      message_id: 901,
      date: 1_700_000_100,
      chat: { id: NON_ADMIN_USER_ID, type: "private", first_name: "Intruder" },
      from: { id: NON_ADMIN_USER_ID, is_bot: false, first_name: "Intruder" },
      users_shared: {
        request_id: fixture.pickerRequestId,
        users: [{ user_id: 888_001, first_name: "Injected" }],
      },
    };
    const spoofedGroupShare: Message = {
      message_id: 902,
      date: 1_700_000_101,
      chat: { id: TEST_CHAT_ID, type: "supergroup", title: "Group" },
      from: { id: SUPER_ADMIN_USER_ID, is_bot: false, first_name: "Admin" },
      users_shared: {
        request_id: fixture.pickerRequestId,
        users: [{ user_id: 888_002, first_name: "InjectedFromGroup" }],
      },
    };
    expect(await handleMiniAppSharedMessage(spoofedNonAdminShare)).toBeNull();
    expect(await handleMiniAppSharedMessage(spoofedGroupShare)).toBeNull();
    expect(getMiniAppPickerResult(fixture.pickerRequestId)).toBeNull();

    expect(captureBusinessStateSnapshot(fixture.galleryFileName)).toEqual(beforeSnapshot);
  });

  test("二次认证会话隔离：仅持 SuperAdmin initData、伪造/畸形/过期/注销/TOTP 变更前的旧会话在全部解锁后路由（含 /api/gallery/file/:fileName）一律 401", async () => {
    const baseMs: number = Date.now();
    setSystemTime(new Date(baseMs));
    const server = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "sec-test-password-123456",
    });
    expect(server).not.toBeNull();
    const fixture: SeededSecurityFixture = await seedProtectedStateFixture();
    const beforeSnapshot: BusinessStateSnapshot = captureBusinessStateSnapshot(
      fixture.galleryFileName
    );
    const postLoginRoutes: readonly Readonly<ProtectedRouteDescriptor>[] =
      PROTECTED_ROUTE_DESCRIPTORS.filter(
        (route: Readonly<ProtectedRouteDescriptor>): boolean => route.tier === "sessionRequired"
      );
    expect(postLoginRoutes.length).toBe(PROTECTED_ROUTE_DESCRIPTORS.length - 3);
    const validInitData: string = signInitDataForUser(SUPER_ADMIN_USER_ID);

    // 1. 仅携带合法 SuperAdmin initData（无 sessionToken）访问全部解锁后路由一律 401 PASSWORD_REQUIRED。
    for (const route of postLoginRoutes) {
      const res: Response = await dispatchDescriptorRequest(route, fixture, {
        [MINI_APP_INIT_DATA_HEADER]: validInitData,
      });
      await assertBlockedDiagnostics(res, 401, "PASSWORD_REQUIRED");
    }

    // 2. 携带空串、畸形、长度不符、随机 64 位十六进制、已满 45 分钟过期或已 logout 会话扫描全部解锁后路由。
    const expiredSession: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(
      baseMs - MINI_APP_SESSION_TTL_MS - 1_000
    );
    const loggedOutSession: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(baseMs);
    const logoutRes: Response = await sendSecurityRequest({
      path: "/api/auth/logout",
      method: "POST",
      headers: {
        [MINI_APP_INIT_DATA_HEADER]: validInitData,
        [MINI_APP_SESSION_HEADER]: loggedOutSession.token,
      },
    });
    expect(logoutRes.status).toBe(200);

    for (const badToken of [
      "   ",
      "not-a-hex-session-token",
      "a".repeat(63),
      "f".repeat(64),
      expiredSession.token,
      loggedOutSession.token,
    ]) {
      for (const route of postLoginRoutes) {
        const res: Response = await dispatchDescriptorRequest(route, fixture, {
          [MINI_APP_INIT_DATA_HEADER]: validInitData,
          [MINI_APP_SESSION_HEADER]: badToken,
        });
        await assertBlockedDiagnostics(res, 401, "PASSWORD_REQUIRED");
      }
    }

    // 3. 查询串鉴权隔离：JSON API 拒绝 ?initData=&session=；图库预览拒绝伪造 ?token= 与注销会话，仅合法 assetToken 放行。
    const activeSession: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(baseMs);
    const validAssetToken: string = deriveMiniAppAssetToken(BOT_TOKEN, SUPER_ADMIN_USER_ID);
    const galleryFileUrl: string = `/api/gallery/file/${fixture.galleryFileName}`;

    await assertBlockedDiagnostics(
      await sendSecurityRequest({ path: `/api/status?initData=${encodeURIComponent(validInitData)}&session=${activeSession.token}` }),
      401,
      "MISSING_INIT_DATA"
    );
    await assertBlockedDiagnostics(
      await sendSecurityRequest({
        path: `${galleryFileUrl}?token=${"e".repeat(64)}`,
        headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, [MINI_APP_SESSION_HEADER]: activeSession.token },
      }),
      401,
      "INVALID_SIGNATURE"
    );
    await assertBlockedDiagnostics(
      await sendSecurityRequest({ path: `${galleryFileUrl}?initData=${encodeURIComponent(validInitData)}&session=${loggedOutSession.token}` }),
      401,
      "PASSWORD_REQUIRED"
    );
    await assertBlockedDiagnostics(
      await sendSecurityRequest({ path: `${galleryFileUrl}?token=${validAssetToken}`, headers: { [MINI_APP_SESSION_HEADER]: "d".repeat(64) } }),
      401,
      "PASSWORD_REQUIRED"
    );

    const validAssetTokenAloneRes: Response = await sendSecurityRequest({ path: `${galleryFileUrl}?token=${validAssetToken}` });
    expect(validAssetTokenAloneRes.status).toBe(200);
    expect(validAssetTokenAloneRes.headers.get("cache-control")).toBe(MINI_APP_ASSET_CACHE_CONTROL);
    await validAssetTokenAloneRes.arrayBuffer();

    await assertBlockedDiagnostics(
      await sendSecurityRequest({ path: `/api/gallery/download/${fixture.galleryFileName}?token=${validAssetToken}` }),
      401,
      "PASSWORD_REQUIRED"
    );
    expect(captureBusinessStateSnapshot(fixture.galleryFileName)).toEqual(beforeSnapshot);

    // 4. TOTP 绑定与删除立即吊销其余旧会话（保留执行变更操作的当前会话及宽限期内别名）。
    const staleBeforeEnable: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(baseMs);
    const agedCallerSession: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(
      baseMs - MINI_APP_SESSION_REFRESH_THRESHOLD_MS - 1_000
    );
    const refreshRes: Response = await sendSecurityRequest({
      path: "/api/totp",
      headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, [MINI_APP_SESSION_HEADER]: agedCallerSession.token },
    });
    const refreshedCallerToken: string = refreshRes.headers.get(MINI_APP_SESSION_HEADER)!;
    expect(refreshedCallerToken).toMatch(/^[0-9a-f]{64}$/u);

    const setupRes: Response = await sendSecurityRequest({
      path: "/api/totp/setup",
      method: "POST",
      headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, [MINI_APP_SESSION_HEADER]: refreshedCallerToken },
    });
    const setupBody: MiniAppTotpSetupResponse = (await setupRes.json()) as MiniAppTotpSetupResponse;
    const enableRes: Response = await sendSecurityRequest({
      path: "/api/totp/enable",
      method: "POST",
      headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, [MINI_APP_SESSION_HEADER]: agedCallerSession.token, "Content-Type": "application/json" },
      body: JSON.stringify({ code: generateMiniAppTotpCodeAt(setupBody.secret, baseMs) }),
    });
    expect(enableRes.status).toBe(200);
    expect(((await enableRes.json()) as MiniAppTotpMutationResponse).ok).toBeTrue();

    await assertBlockedDiagnostics(
      await sendSecurityRequest({
        path: "/api/status",
        headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, [MINI_APP_SESSION_HEADER]: staleBeforeEnable.token },
      }),
      401,
      "PASSWORD_REQUIRED"
    );
    expect(
      (await sendSecurityRequest({
        path: "/api/totp",
        headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, [MINI_APP_SESSION_HEADER]: refreshedCallerToken },
      })).status
    ).toBe(200);

    const staleBeforeDelete: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(baseMs);
    const deleteTotpRes: Response = await sendSecurityRequest({
      path: "/api/totp/delete",
      method: "POST",
      headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, [MINI_APP_SESSION_HEADER]: refreshedCallerToken },
    });
    expect(deleteTotpRes.status).toBe(200);

    await assertBlockedDiagnostics(
      await sendSecurityRequest({
        path: "/api/status",
        headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, [MINI_APP_SESSION_HEADER]: staleBeforeDelete.token },
      }),
      401,
      "PASSWORD_REQUIRED"
    );

    revokeOtherMiniAppAuthSessions("", baseMs);
    expect(miniAppAuthSessions.size).toBe(0);
  });

  test("密码、TOTP 校验、暴力破解锁定、图库路径穿越/符号链接防护及 HTTP 方法/编码/超限请求体边界", async () => {
    const baseMs: number = 1_760_000_000_000;
    setSystemTime(new Date(baseMs));
    const server = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "sec-test-password-123456",
    });
    expect(server).not.toBeNull();
    const fixture: SeededSecurityFixture = await seedProtectedStateFixture();
    const adminHeaders: Record<string, string> = unlockedSuperAdminHeaders();
    const validInitData: string = adminHeaders[MINI_APP_INIT_DATA_HEADER]!;

    // 1. TOTP 待绑定密钥时效与 3 次错误销毁，以及已启用 TOTP 后的明文密码拒绝、相邻步长码拒绝与密钥脱敏。
    const setupExpiredRes: Response = await sendSecurityRequest({ path: "/api/totp/setup", method: "POST", headers: adminHeaders });
    const expiredSetupBody: MiniAppTotpSetupResponse = (await setupExpiredRes.json()) as MiniAppTotpSetupResponse;
    setSystemTime(new Date(baseMs + MINI_APP_TOTP_PENDING_TTL_MS + 1_000));
    const enableAfterTtlRes: Response = await sendSecurityRequest({
      path: "/api/totp/enable",
      method: "POST",
      headers: { ...unlockedSuperAdminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ code: generateMiniAppTotpCodeAt(expiredSetupBody.secret, Date.now()) }),
    });
    expect(enableAfterTtlRes.status).toBe(400);
    expect(((await enableAfterTtlRes.json()) as MiniAppTotpMutationResponse).message).toBe("TOTP_SETUP_EXPIRED");

    setSystemTime(new Date(baseMs));
    const freshAdminHeaders: Record<string, string> = unlockedSuperAdminHeaders();
    const setupStrikeRes: Response = await sendSecurityRequest({ path: "/api/totp/setup", method: "POST", headers: freshAdminHeaders });
    const strikeSetupBody: MiniAppTotpSetupResponse = (await setupStrikeRes.json()) as MiniAppTotpSetupResponse;
    const strikeCodes: readonly string[] = [
      generateMiniAppTotpCodeAt(strikeSetupBody.secret, baseMs - MINI_APP_TOTP_STEP_SECONDS * 1_000),
      generateMiniAppTotpCodeAt(strikeSetupBody.secret, baseMs + MINI_APP_TOTP_STEP_SECONDS * 1_000),
      "000000",
    ];
    for (let idx: number = 0; idx < MINI_APP_PASSWORD_MAX_ATTEMPTS; idx += 1) {
      const badEnableRes: Response = await sendSecurityRequest({
        path: "/api/totp/enable",
        method: "POST",
        headers: { ...freshAdminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ code: strikeCodes[idx] ?? "999999" }),
      });
      expect(badEnableRes.status).toBe(400);
      expect(((await badEnableRes.json()) as MiniAppTotpMutationResponse).message).toBe(
        idx + 1 < MINI_APP_PASSWORD_MAX_ATTEMPTS ? "INVALID_TOTP_CODE" : "TOTP_SETUP_EXPIRED"
      );
    }

    const activeSecret: string = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    miniAppTotpRecordHolder.current = { version: MINI_APP_TOTP_RECORD_VERSION, secret: activeSecret, createdAt: baseMs };
    const totpStatusRes: Response = await sendSecurityRequest({ path: "/api/totp", headers: freshAdminHeaders });
    const totpStatus: MiniAppTotpStatusView = (await totpStatusRes.json()) as MiniAppTotpStatusView;
    expect(totpStatus.enabled).toBeTrue();
    expect(JSON.stringify(totpStatus)).not.toContain(activeSecret);

    // 2. 图库文件名穿越、非法后缀、编码绕过与目录内符号链接逃逸防护。
    const galleryDir: string = getAssetConfig().randomHImageDirectory;
    const outsideSecretPath: string = join(galleryDir, "..", "outside-secret.png");
    await Bun.write(outsideSecretPath, fixture.validPngBytes);
    symlinkSync(outsideSecretPath, join(galleryDir, "symlink-escape.png"));

    for (const unsafeName of ["..", "..%2foutside-secret.png", "%2e%2e%2foutside-secret.png", "%2e%2e", "nested%5csecret.png", ".hidden.png", "vector.svg", "config.json", "%E0%A4%A.png", "null%00.png", "symlink-escape.png"]) {
      expect((await sendSecurityRequest({ path: `/api/gallery/file/${unsafeName}`, headers: freshAdminHeaders })).status).toBe(404);
      expect((await sendSecurityRequest({ path: `/api/gallery/download/${unsafeName}`, headers: freshAdminHeaders })).status).toBe(404);
      expect([400, 404]).toContain((await sendSecurityRequest({ path: `/api/gallery/file/${unsafeName}`, method: "DELETE", headers: freshAdminHeaders })).status);
      expect([400, 404]).toContain(
        (await sendSecurityRequest({ path: "/api/gallery/delete", method: "POST", headers: { ...freshAdminHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ fileName: unsafeName }) })).status
      );
    }
    expect(existsSync(outsideSecretPath)).toBeTrue();
    rmSync(outsideSecretPath, { force: true });

    // 3. HTTP 方法失配（先鉴权后 404）、URL 编码路径绕过（/%61pi/status）与超大 JSON 请求体拦截。
    for (const disallowedMethod of ["OPTIONS", "PUT", "PATCH", "DELETE"]) {
      await assertBlockedDiagnostics(await sendSecurityRequest({ path: "/api/status", method: disallowedMethod }), 401, "MISSING_INIT_DATA");
      const authMethodRes: Response = await sendSecurityRequest({ path: "/api/status", method: disallowedMethod, headers: freshAdminHeaders });
      expect(authMethodRes.status).toBe(404);
      expect(authMethodRes.headers.get("cache-control")).toBe(MINI_APP_NO_STORE_CACHE_CONTROL);
    }

    const encodedApiRes: Response = await sendSecurityRequest({ path: "/%61pi/status", headers: freshAdminHeaders });
    expect(encodedApiRes.status).toBe(404);
    expect(await encodedApiRes.json()).toEqual({ error: "Not found" });

    const oversizedPayload: Uint8Array = new TextEncoder().encode(
      JSON.stringify({ action: "add", id: 777_888, pad: "x".repeat(MINI_APP_MAX_JSON_BODY_BYTES + 128) })
    );
    const oversizedJsonRes: Response = await sendSecurityRequest({
      path: "/api/identities/whitelist",
      method: "POST",
      headers: { ...freshAdminHeaders, "Content-Type": "application/json" },
      body: oversizedPayload,
    });
    expect(oversizedJsonRes.status).toBe(400);

    // 4. 连续 3 次登录失败（密码绕过已启用 TOTP + 相邻步长码 + 错误码）触发 30 分钟全局锁定。
    const totpLoginFailures: readonly Record<string, string>[] = [
      { password: "sec-test-password-123456" },
      { totpCode: generateMiniAppTotpCodeAt(activeSecret, baseMs - MINI_APP_TOTP_STEP_SECONDS * 1_000) },
      { totpCode: "000000" },
    ];
    for (let attempt: number = 0; attempt < MINI_APP_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
      const failLoginRes: Response = await sendSecurityRequest({
        path: "/api/auth/login",
        method: "POST",
        headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, "Content-Type": "application/json" },
        body: JSON.stringify(totpLoginFailures[attempt]),
      });
      await assertBlockedDiagnostics(
        failLoginRes,
        403,
        attempt + 1 < MINI_APP_PASSWORD_MAX_ATTEMPTS ? "INVALID_TOTP_CODE" : "PASSWORD_LOCKED"
      );
    }
    expect(miniAppAuthSessions.size).toBe(0);

    await assertBlockedDiagnostics(
      await sendSecurityRequest({
        path: "/api/auth/login",
        method: "POST",
        headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData, "Content-Type": "application/json" },
        body: JSON.stringify({ totpCode: generateMiniAppTotpCodeAt(activeSecret, baseMs) }),
      }),
      403,
      "PASSWORD_LOCKED"
    );
    await assertBlockedDiagnostics(
      await sendSecurityRequest({ path: "/api/auth/precheck", headers: { [MINI_APP_INIT_DATA_HEADER]: validInitData } }),
      403,
      "PASSWORD_LOCKED"
    );
    await assertBlockedDiagnostics(await sendSecurityRequest({ path: "/api/status", headers: freshAdminHeaders }), 403, "PASSWORD_LOCKED");
    await assertBlockedDiagnostics(
      await sendSecurityRequest({ path: `/api/gallery/file/${fixture.galleryFileName}?token=${deriveMiniAppAssetToken(BOT_TOKEN, SUPER_ADMIN_USER_ID)}` }),
      403,
      "PASSWORD_LOCKED"
    );

    setSystemTime(new Date(baseMs + MINI_APP_PASSWORD_LOCKOUT_MS + 1_000));
    const unlockedLoginRes: Response = await sendSecurityRequest({
      path: "/api/auth/login",
      method: "POST",
      headers: { [MINI_APP_INIT_DATA_HEADER]: signInitDataForUser(SUPER_ADMIN_USER_ID), "Content-Type": "application/json" },
      body: JSON.stringify({ totpCode: generateMiniAppTotpCodeAt(activeSecret, Date.now()) }),
    });
    expect(unlockedLoginRes.status).toBe(200);
    expect(unlockedLoginRes.headers.get("set-cookie")).toContain(`${MINI_APP_PAGE_GATE_COOKIE_NAME}=`);
    const loginSuccess: MiniAppLoginSuccessResponse = (await unlockedLoginRes.json()) as MiniAppLoginSuccessResponse;
    expect(loginSuccess.ok).toBeTrue();
    expect(loginSuccess.ttlMs).toBe(MINI_APP_SESSION_TTL_MS);
  });
});
