/**
 * Mini App 全路由未授权访问与安全拦截矩阵测试共用的受保护路由描述符、夹具快照类型与未知兜底路径常量。
 */

import { SUPER_ADMIN_USER_ID } from "../../packages/config/bot";

/** 单条受保护路由描述项（用于全路由未授权访问矩阵扫描与路由表 1:1 校验）。 */
export interface ProtectedRouteDescriptor {
  readonly method: string;
  readonly routePattern: string;
  readonly tier: "initDataOnly" | "sessionRequired";
  readonly buildPath: (galleryFileName: string, pickerRequestId: number) => string;
  readonly jsonBody?: string;
  readonly binaryUpload?: boolean;
}

/** 业务状态不可变性快照，用于断言未授权请求零副作用。 */
export interface BusinessStateSnapshot {
  readonly whitelistEntries: readonly (readonly [number, string])[];
  readonly blocklistEntries: readonly (readonly [number, string])[];
  readonly chatSnapshot: string;
  readonly qaEntries: readonly (readonly [string, string])[];
  readonly adPackBlacklists: {
    readonly sticker: readonly string[];
    readonly emoji: readonly string[];
  };
  readonly pendingPickerSize: number;
  readonly completedPickerSize: number;
  /** 图库目录的完整文件名列表（排序后），新增或删除任一文件都会改变它。 */
  readonly galleryFiles: readonly string[];
  readonly totpSecret: string | null | undefined;
}

/** 已种子化的业务夹具上下文。 */
export interface SeededSecurityFixture {
  readonly galleryFileName: string;
  readonly validPngBytes: Uint8Array;
  readonly pickerRequestId: number;
}

/** 发送测试请求的入参选项。 */
export interface SendSecurityRequestOptions {
  readonly path: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

/** 测试夹具使用的受管群 ID、名单初始 ID 与非超管入侵者 ID。 */
export const TEST_CHAT_ID: number = -100998877;
export const SEEDED_WHITELIST_ID: number = 610_001;
export const SEEDED_BLOCKLIST_ID: number = 620_002;
export const NON_ADMIN_USER_ID: number = SUPER_ADMIN_USER_ID + 777;

/** 公开探活、图标与单页门控入口路由模式集合（未授权请求访问单页入口时仅返回独立 `reject.html`）。 */
export const PUBLIC_ROUTE_PATTERNS: ReadonlySet<string> = new Set<string>([
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
    readonly galleryFileQuery?: boolean;
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
      if (extra.galleryFileQuery === true) {
        return `${routePattern}?fileName=${encodeURIComponent(galleryFileName)}`;
      }
      if (routePattern === "/api/picker/result") {
        return `${routePattern}?requestId=${pickerRequestId}`;
      }
      return extra.query !== undefined ? `${routePattern}?${extra.query}` : routePattern;
    },
  };
}

/** 全部受保护 Mini App 路由与 HTTP 方法穷举表（必须与 `createMiniAppBunRoutes()` 严格一致）。 */
export const PROTECTED_ROUTE_DESCRIPTORS: readonly Readonly<ProtectedRouteDescriptor>[] = [
  defineProtectedRoute("GET", "/api/auth/precheck", { tier: "initDataOnly" }),
  defineProtectedRoute("POST", "/api/auth/login", {
    tier: "initDataOnly",
    jsonBody: JSON.stringify({
      handshakeId: "0".repeat(32),
      clientPublicKey: "A".repeat(44),
      encryptedPayload: { iv: "aa==", payload: "bb==" },
    }),
  }),
  defineProtectedRoute("POST", "/api/auth/logout", { tier: "initDataOnly" }),
  defineProtectedRoute("GET", "/api/status"),
  defineProtectedRoute("GET", "/api/mood"),
  defineProtectedRoute("POST", "/api/mood/switch", { jsonBody: "{}" }),
  defineProtectedRoute("GET", "/api/chats"),
  defineProtectedRoute("GET", "/api/chats/detail", { query: `chatId=${TEST_CHAT_ID}` }),
  defineProtectedRoute("GET", "/api/chats/messages", {
    query: `chatId=${TEST_CHAT_ID}&page=1&pageSize=10`,
  }),
  defineProtectedRoute("POST", "/api/chats/feature", {
    jsonBody: JSON.stringify({ chatId: TEST_CHAT_ID, feature: "aiChat", enabled: false }),
  }),
  defineProtectedRoute("POST", "/api/chats/batch-kick", {
    jsonBody: JSON.stringify({ chatId: TEST_CHAT_ID, hours: 6 }),
  }),
  defineProtectedRoute("GET", "/api/chats/targets", { query: `chatId=${TEST_CHAT_ID}` }),
  defineProtectedRoute("POST", "/api/chats/targets", {
    jsonBody: JSON.stringify({
      chatId: TEST_CHAT_ID,
      action: "setQa",
      q: "unauth-q",
      a: "unauth-a",
    }),
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
  defineProtectedRoute("GET", "/api/configs"),
  defineProtectedRoute("GET", "/api/configs/file", {
    query: "scope=dynamic&fileName=mood.json",
  }),
  defineProtectedRoute("POST", "/api/configs/save", {
    jsonBody: JSON.stringify({
      scope: "dynamic",
      fileName: "mood.json",
      content: "{}",
    }),
  }),
  defineProtectedRoute("POST", "/api/configs/restart"),
  defineProtectedRoute("GET", "/api/ad-blacklists", {
    query: "kind=sticker&page=1&pageSize=10",
  }),
  defineProtectedRoute("POST", "/api/ad-blacklists", {
    jsonBody: JSON.stringify({ kind: "sticker", pack: "UnauthPack_1", enabled: true }),
  }),
  defineProtectedRoute("GET", "/api/ad-blacklists/preview", {
    query: "kind=sticker&pack=SeededStickerPack",
  }),
  defineProtectedRoute("GET", "/api/gallery", { query: "page=1&pageSize=10" }),
  defineProtectedRoute("POST", "/api/gallery/upload", { binaryUpload: true }),
  defineProtectedRoute("POST", "/api/gallery/delete", {
    jsonBody: JSON.stringify({ fileName: "keep.png" }),
  }),
  defineProtectedRoute("POST", "/api/gallery/download-ticket", {
    jsonBody: JSON.stringify({ fileName: "keep.png" }),
  }),
  defineProtectedRoute("GET", "/api/gallery/download", { galleryFileQuery: true }),
  defineProtectedRoute("HEAD", "/api/gallery/download", { galleryFileQuery: true }),
  defineProtectedRoute("GET", "/api/gallery/file", { galleryFileQuery: true }),
  defineProtectedRoute("HEAD", "/api/gallery/file", { galleryFileQuery: true }),
  defineProtectedRoute("GET", "/api/totp"),
  defineProtectedRoute("DELETE", "/api/totp"),
  defineProtectedRoute("POST", "/api/totp/setup"),
  defineProtectedRoute("POST", "/api/totp/enable", { jsonBody: JSON.stringify({ code: "000000" }) }),
  defineProtectedRoute("POST", "/api/totp/delete"),
];

/** 未注册 `/api/*` 别名路径与未知图片后缀路径兜底扫描集合。 */
export const UNKNOWN_FALLBACK_ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/api/whitelist"],
  ["POST", "/api/whitelist"],
  ["GET", "/api/blocklist"],
  ["POST", "/api/blocklist"],
  ["POST", "/api/chats/features"],
  ["POST", "/api/chats/kick-inactive"],
  ["DELETE", "/api/gallery/file"],
  ["GET", `/api/chats/${TEST_CHAT_ID}`],
  ["GET", "/api/picker/result/arbitrary-token"],
  ["GET", "/api/configs/unknown"],
  ["POST", "/api/totp/disable"],
  ["GET", "/api/unknown/probe"],
  ["GET", "/secret-asset.png"],
  ["GET", "/nested/diagram.svg"],
];
