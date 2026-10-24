import {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_TMA_AUTH_PREFIX,
} from "../../consts/miniApp";
import type { WhitelistPermissionKey } from "../../types/identityPolicy";
import type {
  MiniAppAccessDiagnostics,
  MiniAppBlocklistPage,
  MiniAppChatDetail,
  MiniAppChatSummary,
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
  MiniAppIdentityMutationResult,
  MiniAppLoginSuccessResponse,
  MiniAppMessagePage,
  MiniAppPickerResultEvent,
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
  MiniAppPrecheckResult,
  MiniAppStatusView,
  MiniAppWhitelistPage,
  TelegramWebApp,
  TelegramWindow,
} from "../../types/miniApp";
import type { PrepareMiniAppPickerResult } from "../picker";

/**
 * 读取浏览器全局注入的 `Telegram.WebApp` 实例。
 * @returns `TelegramWebApp` 对象；非 Telegram WebView 环境返回 `undefined`
 */
export function getTelegramWebApp(): Readonly<TelegramWebApp> | undefined {
  const tgWindow: TelegramWindow = globalThis;
  return tgWindow.Telegram?.WebApp;
}

/**
 * 读取当前浏览器会话已解锁的 Mini App 90 分钟认证令牌。
 * @returns 64 位十六进制会话令牌；未解锁时返回空字符串
 */
export function readMiniAppSessionToken(): string {
  const tgWindow: TelegramWindow = globalThis;
  return tgWindow.__copyNinjaSessionToken ?? "";
}

/**
 * 保存当前浏览器会话已解锁的 Mini App 90 分钟认证令牌。
 * @param token 服务端签发的 64 位十六进制会话令牌
 */
export function setMiniAppSessionToken(token: string): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.__copyNinjaSessionToken = token;
}

/**
 * 清除当前浏览器会话的 Mini App 认证令牌（会话满 90 分钟过期或主动锁定时调用）。
 */
export function clearMiniAppSessionToken(): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.__copyNinjaSessionToken = undefined;
}

/**
 * 调用宿主环境确认对话框；无弹窗宿主时默认确认通过。
 * @param message 确认提示文本
 * @returns 用户是否确认继续
 */
export function confirmMiniAppAction(message: string): boolean {
  const tgWindow: TelegramWindow = globalThis;
  if (tgWindow.document !== undefined && typeof tgWindow.confirm === "function") {
    return tgWindow.confirm(message);
  }
  return true;
}

/**
 * 提取当前会话的 Telegram WebApp `initData` 原始签名串。
 * @returns `initData` 字符串；未注入时返回空字符串
 */
export function readMiniAppInitData(): string {
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  if (webApp?.initData !== undefined && webApp.initData.length > 0) {
    return webApp.initData;
  }
  const tgWindow: TelegramWindow = globalThis;
  if (tgWindow.location === undefined) return "";
  const queryParams: URLSearchParams = new URLSearchParams(tgWindow.location.search);
  const fromQuery: string | null = queryParams.get("tgWebAppData");
  if (fromQuery !== null && fromQuery.length > 0) return fromQuery;
  const hashRaw: string = tgWindow.location.hash.startsWith("#")
    ? tgWindow.location.hash.slice(1)
    : tgWindow.location.hash;
  const hashParams: URLSearchParams = new URLSearchParams(hashRaw);
  return hashParams.get("tgWebAppData") ?? "";
}

/**
 * 从后端 401/403 JSON 载荷与响应头提取真实访问诊断元数据。
 * @param payload 响应 JSON 对象
 * @param response 原始 `Response`
 * @param fallbackError 兜底错误说明
 * @returns 归一化后的真实访问诊断对象
 */
function parseAccessDiagnostics(
  payload: unknown,
  response: Response,
  fallbackError: string
): Readonly<MiniAppAccessDiagnostics> {
  const record: Record<string, unknown> =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const str = (key: string, fallback: string): string => {
    const val: unknown = record[key];
    return typeof val === "string" && val.length > 0 ? val : fallback;
  };
  return {
    requestId: str("requestId", response.headers.get("x-request-id") ?? "0000000000000000"),
    timestamp: str("timestamp", `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`),
    clientIp: str("clientIp", "127.0.0.1"),
    host: str("host", "localhost"),
    path: str("path", "/api/auth/precheck"),
    status: typeof record.status === "number" ? record.status : response.status,
    code: str("code", `HTTP_${response.status}`),
    error: str("error", fallbackError),
  };
}

/**
 * 调用 `GET ./api/auth/precheck` 核验当前客户端是否持有合法的 SuperAdmin `initData` 签名；未通过时返回服务端生成的真实请求 ID、UTC 时间与客户端 IP 供 403 页面展示。
 * @returns 预检结果
 */
export async function precheckMiniAppAccess(): Promise<MiniAppPrecheckResult> {
  const initData: string = readMiniAppInitData();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (initData.length > 0) {
    headers[MINI_APP_INIT_DATA_HEADER] = initData;
    headers.Authorization = `${MINI_APP_TMA_AUTH_PREFIX}${initData}`;
  }
  const response: Response = await fetch("./api/auth/precheck", { method: "GET", headers });
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    return {
      ok: false,
      diagnostics: parseAccessDiagnostics(
        payload,
        response,
        "禁止从外部浏览器直接访问。仅限 SuperAdmin 在与 Bot 的 Telegram 私聊中打开 Mini App。"
      ),
    };
  }
  const ttlMs: number =
    typeof payload === "object" &&
    payload !== null &&
    "ttlMs" in payload &&
    typeof (payload as { readonly ttlMs?: unknown }).ttlMs === "number"
      ? (payload as { readonly ttlMs: number }).ttlMs
      : MINI_APP_SESSION_TTL_MS;
  return { ok: true, ttlMs };
}

/**
 * 调用 `POST ./api/auth/login` 提交访问密码并获取 90 分钟有效期的认证会话令牌。
 * @param password 用户输入的访问密码
 * @returns 登录成功响应（含 `sessionToken` 与 `expiresAt`）
 */
export async function loginMiniAppWithPassword(
  password: string
): Promise<MiniAppLoginSuccessResponse> {
  const response: MiniAppLoginSuccessResponse =
    await miniAppFetchJson<MiniAppLoginSuccessResponse>("./api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  setMiniAppSessionToken(response.sessionToken);
  return response;
}

/**
 * 调用 Mini App 后端 JSON 接口并附带 SuperAdmin `initData` 与 90 分钟密码会话令牌请求头。
 * @param path 相对路径（如 `./api/status`）
 * @param init 可选 `RequestInit` 配置
 * @returns 解析后的 JSON 响应对象
 */
export async function miniAppFetchJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const initData: string = readMiniAppInitData();
  const sessionToken: string = readMiniAppSessionToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (initData.length > 0) {
    headers[MINI_APP_INIT_DATA_HEADER] = initData;
    headers.Authorization = `${MINI_APP_TMA_AUTH_PREFIX}${initData}`;
  }
  if (sessionToken.length > 0) {
    headers[MINI_APP_SESSION_HEADER] = sessionToken;
  }
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response: Response = await fetch(path, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    const code: string =
      typeof payload === "object" &&
      payload !== null &&
      "code" in payload &&
      typeof (payload as { readonly code?: unknown }).code === "string"
        ? (payload as { readonly code: string }).code
        : "";
    if (code === "PASSWORD_REQUIRED" || code === "PASSWORD_LOCKED") {
      clearMiniAppSessionToken();
    }
    const errorMessage: string =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof (payload as { readonly error?: unknown }).error === "string"
        ? (payload as { readonly error: string }).error
        : typeof payload === "object" &&
            payload !== null &&
            "message" in payload &&
            typeof (payload as { readonly message?: unknown }).message === "string"
          ? (payload as { readonly message: string }).message
          : `HTTP ${response.status}`;
    const prefix: string =
      code === "PASSWORD_REQUIRED" || code === "PASSWORD_LOCKED" ? `[${code}] ` : "";
    throw new Error(`${prefix}${errorMessage}`);
  }
  return payload as T;
}

/**
 * 拉取首页实时运行状态快照。
 * @returns 实时状态视图
 */
export async function fetchMiniAppStatus(): Promise<MiniAppStatusView> {
  return miniAppFetchJson<MiniAppStatusView>("./api/status");
}

/**
 * 拉取所有已启用 `/init` 的受管群列表。
 * @returns 已初始化群摘要列表
 */
export async function fetchMiniAppChats(): Promise<readonly Readonly<MiniAppChatSummary>[]> {
  const response: { readonly items: readonly Readonly<MiniAppChatSummary>[] } =
    await miniAppFetchJson<{ readonly items: readonly Readonly<MiniAppChatSummary>[] }>(
      "./api/chats"
    );
  return response.items;
}

/**
 * 拉取指定群的详细状态与功能开关快照。
 * @param chatId 目标群 ID
 * @returns 群详细状态视图
 */
export async function fetchMiniAppChatDetail(chatId: number): Promise<MiniAppChatDetail> {
  const response: { readonly detail: MiniAppChatDetail } =
    await miniAppFetchJson<{ readonly detail: MiniAppChatDetail }>(
      `./api/chats/${encodeURIComponent(String(chatId))}`
    );
  return response.detail;
}

/**
 * 切换指定群的单项功能开关（含 `/init`）。
 * @param chatId 目标群 ID
 * @param feature 功能键
 * @param enabled 目标布尔状态
 * @returns 开关变更结果
 */
export async function toggleMiniAppChatFeature(
  chatId: number,
  feature: MiniAppFeatureKey,
  enabled: boolean
): Promise<MiniAppFeatureToggleResult> {
  return miniAppFetchJson<MiniAppFeatureToggleResult>(
    `./api/chats/${encodeURIComponent(String(chatId))}/feature`,
    {
      method: "POST",
      body: JSON.stringify({ feature, enabled }),
    }
  );
}

/**
 * 分页拉取指定群的热 256 条发言记录（不含压缩记忆摘要）。
 * @param chatId 目标群 ID
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @returns 热发言记录分页结果
 */
export async function fetchMiniAppChatMessages(
  chatId: number,
  page: number,
  pageSize: number
): Promise<MiniAppMessagePage> {
  return miniAppFetchJson<MiniAppMessagePage>(
    `./api/chats/${encodeURIComponent(String(chatId))}/messages?page=${page}&pageSize=${pageSize}`
  );
}

/**
 * 按页码拉取白名单与权限矩阵列表（含当前页、总页数及黑白名单总条数）。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @returns 白名单分页结果
 */
export async function fetchMiniAppWhitelist(
  page: number,
  pageSize: number
): Promise<MiniAppWhitelistPage> {
  return miniAppFetchJson<MiniAppWhitelistPage>(
    `./api/identities/whitelist?page=${page}&pageSize=${pageSize}`
  );
}

/**
 * 按数字 ID 添加或移出白名单。
 * @param id 用户正整数 ID 或 `-100...` 频道 ID
 * @param enabled `true` 为加入白名单，`false` 为从白名单移除
 * @returns 名单变更结果
 */
export async function setMiniAppWhitelistMembership(
  id: number,
  enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  return miniAppFetchJson<MiniAppIdentityMutationResult>("./api/identities/whitelist", {
    method: "POST",
    body: JSON.stringify({ id, enabled }),
  });
}

/**
 * 修改白名单条目的单项权限开关或一键开启全部权限。
 * @param id 目标白名单 ID
 * @param permission 权限键或 `"all"`
 * @param enabled 目标布尔状态
 * @returns 权限变更结果
 */
export async function updateMiniAppWhitelistPermission(
  id: number,
  permission: WhitelistPermissionKey | "all",
  enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  const body: Record<string, unknown> =
    permission === "all"
      ? { id, enableAll: true }
      : { id, key: permission, value: enabled };
  return miniAppFetchJson<MiniAppIdentityMutationResult>("./api/identities/permission", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * 按页码拉取黑名单列表（含当前页、总页数及黑白名单总条数）。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @returns 黑名单分页结果
 */
export async function fetchMiniAppBlocklist(
  page: number,
  pageSize: number
): Promise<MiniAppBlocklistPage> {
  return miniAppFetchJson<MiniAppBlocklistPage>(
    `./api/identities/blocklist?page=${page}&pageSize=${pageSize}`
  );
}

/**
 * 按数字 ID 加入或移出黑名单。
 * @param id 用户正整数 ID 或 `-100...` 频道 ID
 * @param enabled `true` 为拉黑，`false` 为解封
 * @returns 名单变更结果
 */
export async function setMiniAppBlocklistMembership(
  id: number,
  enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  return miniAppFetchJson<MiniAppIdentityMutationResult>("./api/identities/blocklist", {
    method: "POST",
    body: JSON.stringify({ id, enabled }),
  });
}

/**
 * 请求后端生成 `savePreparedKeyboardButton` 原生好友/联系人/频道选择器会话。
 * @param targetList 目标名单（`"whitelist"` 或 `"blocklist"`）
 * @param subjectKind 目标身份类型（`"users"` 或 `"channel"`）
 * @returns 预备选择器会话信息
 */
export async function requestMiniAppPreparedPicker(
  targetList: MiniAppPickerTargetList,
  subjectKind: MiniAppPickerSubjectKind
): Promise<Extract<PrepareMiniAppPickerResult, { readonly ok: true }>> {
  return miniAppFetchJson<Extract<PrepareMiniAppPickerResult, { readonly ok: true }>>(
    "./api/picker/prepare",
    {
      method: "POST",
      body: JSON.stringify({ targetList, subjectKind }),
    }
  );
}

/**
 * 查询原生选择器会话的共享结果回执。
 * @param requestId 预备选择器请求 ID
 * @returns 已完成回执；尚未收到时返回 `null`
 */
export async function pollMiniAppPickerResult(
  requestId: number
): Promise<Readonly<MiniAppPickerResultEvent> | null> {
  const response: { readonly result: Readonly<MiniAppPickerResultEvent> | null } =
    await miniAppFetchJson<{ readonly result: Readonly<MiniAppPickerResultEvent> | null }>(
      `./api/picker/result?requestId=${encodeURIComponent(String(requestId))}`
    );
  return response.result;
}

/**
 * 按页码拉取当前配置的图库图片列表。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页张数
 * @returns 图库分页结果
 */
export async function fetchMiniAppGallery(
  page: number,
  pageSize: number
): Promise<MiniAppGalleryPage> {
  return miniAppFetchJson<MiniAppGalleryPage>(
    `./api/gallery?page=${page}&pageSize=${pageSize}`
  );
}

/**
 * 构造携带当前 SuperAdmin `initData` 签名与 90 分钟会话令牌的图库单张图片预览地址。
 * @param fileName 图库图片文件名
 * @returns 供 `<img>` 使用的受保护预览 URL
 */
export function buildMiniAppGalleryImageUrl(fileName: string): string {
  const initData: string = readMiniAppInitData();
  const sessionToken: string = readMiniAppSessionToken();
  const encodedName: string = encodeURIComponent(fileName);
  if (initData.length === 0) {
    return `./api/gallery/file/${encodedName}`;
  }
  const sessionQuery: string =
    sessionToken.length > 0 ? `&session=${encodeURIComponent(sessionToken)}` : "";
  return `./api/gallery/file/${encodedName}?initData=${encodeURIComponent(initData)}${sessionQuery}`;
}

/**
 * 按现有 `/h_image add` 协议（字节上限、魔数格式、像素尺寸与内容 SHA-256 去重）上传单张图片到图库目录。
 * @param bytes 待上传的图片原始字节
 * @returns 结构化的上传入库结果
 */
export async function uploadMiniAppGalleryImageBytes(
  bytes: Uint8Array
): Promise<MiniAppGalleryUploadResult> {
  const initData: string = readMiniAppInitData();
  const sessionToken: string = readMiniAppSessionToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/octet-stream",
  };
  if (initData.length > 0) {
    headers[MINI_APP_INIT_DATA_HEADER] = initData;
    headers.Authorization = `${MINI_APP_TMA_AUTH_PREFIX}${initData}`;
  }
  if (sessionToken.length > 0) {
    headers[MINI_APP_SESSION_HEADER] = sessionToken;
  }
  const response: Response = await fetch("./api/gallery/upload", {
    method: "POST",
    headers,
    body: bytes,
  });
  const payload: unknown = await response.json().catch((): null => null);
  if (
    typeof payload === "object" &&
    payload !== null &&
    "outcome" in payload &&
    "message" in payload &&
    typeof (payload as { readonly outcome?: unknown }).outcome === "string" &&
    typeof (payload as { readonly message?: unknown }).message === "string"
  ) {
    return payload as MiniAppGalleryUploadResult;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return {
    ok: false,
    outcome: "failed",
    message: "未收到有效的上传回执。",
  };
}
