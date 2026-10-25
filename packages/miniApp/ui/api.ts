import {
  MINI_APP_INIT_DATA_HEADER, MINI_APP_SESSION_HEADER, MINI_APP_SESSION_TTL_MS, MINI_APP_TMA_AUTH_PREFIX,
} from "../../consts/miniApp";
import type { WhitelistPermissionKey } from "../../types/identityPolicy";
import type {
  MiniAppAccessDiagnostics, MiniAppBlocklistPage, MiniAppChatDetail, MiniAppChatSummary,
  MiniAppDownloadAnchorElement, MiniAppFeatureKey, MiniAppFeatureToggleResult, MiniAppGalleryDeleteResult,
  MiniAppGalleryPage, MiniAppGalleryUploadResult, MiniAppIdentityMutationResult, MiniAppLoginSuccessResponse,
  MiniAppMessagePage, MiniAppPickerResultEvent, MiniAppPickerSubjectKind, MiniAppPickerTargetList,
  MiniAppPrecheckResult, MiniAppStatusView, MiniAppWhitelistPage, TelegramWebApp, TelegramWindow,
} from "../../types/miniApp";
import type {
  MiniAppAuthMode,
  MiniAppTotpMutationResponse,
  MiniAppTotpSetupResponse,
  MiniAppTotpStatusView,
} from "../../types/miniAppTotp";
import type { PrepareMiniAppPickerResult } from "../picker";
import { buildMiniAppGalleryDownloadFileName } from "./formatters";

export { buildMiniAppGalleryDownloadFileName };

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
 * 读取当前浏览器会话缓存的受保护静态/图库资源稳定访问令牌。
 * @returns 64 位十六进制资源令牌；未预检时返回空字符串
 */
export function readMiniAppAssetToken(): string {
  const tgWindow: TelegramWindow = globalThis;
  return tgWindow.__copyNinjaAssetToken ?? "";
}

/**
 * 保存服务端在预检或登录成功后下发的受保护静态/图库资源稳定访问令牌。
 * @param token 64 位十六进制资源令牌
 */
export function setMiniAppAssetToken(token: string): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.__copyNinjaAssetToken = token;
}

/**
 * 清除当前浏览器会话的受保护资源令牌（仅供测试重置使用）。
 */
export function clearMiniAppAssetToken(): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.__copyNinjaAssetToken = undefined;
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
  if (webApp?.initData !== undefined && webApp.initData.length > 0) return webApp.initData;
  const tgWindow: TelegramWindow = globalThis;
  if (tgWindow.location === undefined) return "";
  const queryParams: URLSearchParams = new URLSearchParams(tgWindow.location.search);
  const fromQuery: string | null = queryParams.get("tgWebAppData");
  if (fromQuery !== null && fromQuery.length > 0) return fromQuery;
  const hashRaw: string = tgWindow.location.hash.startsWith("#")
    ? tgWindow.location.hash.slice(1)
    : tgWindow.location.hash;
  return new URLSearchParams(hashRaw).get("tgWebAppData") ?? "";
}

/**
 * 将未知响应体安全收窄为键值字典。
 * @param payload 原始 JSON 响应值
 * @returns 对象字典（非对象时返回空字典）
 */
function asPayloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * 组装携带当前会话 `initData` 与 90 分钟令牌的认证请求头。
 * @param includeSession 是否附加 90 分钟会话令牌头
 * @param contentType 可选的 `Content-Type`
 * @returns 组装好的请求头字典
 */
function buildMiniAppAuthHeaders(includeSession: boolean, contentType?: string): Record<string, string> {
  const initData: string = readMiniAppInitData();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (initData.length > 0) {
    headers[MINI_APP_INIT_DATA_HEADER] = initData;
    headers.Authorization = `${MINI_APP_TMA_AUTH_PREFIX}${initData}`;
  }
  if (includeSession) {
    const sessionToken: string = readMiniAppSessionToken();
    if (sessionToken.length > 0) headers[MINI_APP_SESSION_HEADER] = sessionToken;
  }
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  return headers;
}

/**
 * 从后端 401/403 JSON 载荷与响应头提取真实访问诊断元数据。
 * @param payload 响应 JSON 对象
 * @param response 原始 `Response`
 * @param fallbackError 兜底错误说明
 * @returns 归一化后的真实访问诊断对象
 */
function parseAccessDiagnostics(
  payload: unknown, response: Response, fallbackError: string
): Readonly<MiniAppAccessDiagnostics> {
  const record: Record<string, unknown> = asPayloadRecord(payload);
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
 * 调用 `GET ./api/auth/precheck` 核验当前客户端是否持有合法的 SuperAdmin `initData` 签名。
 * @returns 预检结果
 */
export async function precheckMiniAppAccess(): Promise<MiniAppPrecheckResult> {
  const response: Response = await fetch("./api/auth/precheck", {
    method: "GET", headers: buildMiniAppAuthHeaders(false),
  });
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
  const record: Record<string, unknown> = asPayloadRecord(payload);
  const ttlMs: number = typeof record.ttlMs === "number" ? record.ttlMs : MINI_APP_SESSION_TTL_MS;
  const totpEnabled: boolean = record.totpEnabled === true;
  const authMode: MiniAppAuthMode =
    record.authMode === "totp" || totpEnabled ? "totp" : "password";
  const assetToken: string | undefined =
    typeof record.assetToken === "string" && record.assetToken.length > 0 ? record.assetToken : undefined;
  if (assetToken !== undefined) setMiniAppAssetToken(assetToken);
  return {
    ok: true, ttlMs, totpEnabled, authMode,
    ...(assetToken === undefined ? {} : { assetToken }),
  };
}

/**
 * 调用 `POST ./api/auth/login` 提交 6 位 TOTP 动态码（优先）或访问密码并获取 90 分钟有效期的认证会话令牌。
 * @param credential 用户输入的 6 位 TOTP 验证码或访问密码
 * @param mode 当前登录校验模式（`"totp"` 或 `"password"`）
 * @returns 登录成功响应（含 `sessionToken` 与 `expiresAt`）
 */
export async function loginMiniAppWithPassword(
  credential: string, mode: MiniAppAuthMode = "password"
): Promise<MiniAppLoginSuccessResponse> {
  const response: MiniAppLoginSuccessResponse =
    await miniAppFetchJson<MiniAppLoginSuccessResponse>("./api/auth/login", {
      method: "POST",
      body: JSON.stringify(
        mode === "totp" ? { totpCode: credential, password: credential } : { password: credential }
      ),
    });
  setMiniAppSessionToken(response.sessionToken);
  if (typeof response.assetToken === "string" && response.assetToken.length > 0) {
    setMiniAppAssetToken(response.assetToken);
  }
  return response;
}

/**
 * 调用 Mini App 后端 JSON 接口并附带 SuperAdmin `initData` 与 90 分钟密码会话令牌请求头。
 * @param path 相对路径（如 `./api/status`）
 * @param init 可选 `RequestInit` 配置
 * @returns 解析后的 JSON 响应对象
 */
export async function miniAppFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = buildMiniAppAuthHeaders(
    true, init?.body !== undefined ? "application/json" : undefined
  );
  const response: Response = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    const record: Record<string, unknown> = asPayloadRecord(payload);
    const code: string = typeof record.code === "string" ? record.code : "";
    if (code === "PASSWORD_REQUIRED" || code === "PASSWORD_LOCKED") clearMiniAppSessionToken();
    const errorMessage: string =
      typeof record.error === "string"
        ? record.error
        : typeof record.message === "string"
          ? record.message
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
    await miniAppFetchJson("./api/chats");
  return response.items;
}

/**
 * 拉取指定群的详细状态与功能开关快照。
 * @param chatId 目标群 ID
 * @returns 群详细状态视图
 */
export async function fetchMiniAppChatDetail(chatId: number): Promise<MiniAppChatDetail> {
  const response: { readonly detail: MiniAppChatDetail } = await miniAppFetchJson(
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
  chatId: number, feature: MiniAppFeatureKey, enabled: boolean
): Promise<MiniAppFeatureToggleResult> {
  return miniAppFetchJson(`./api/chats/${encodeURIComponent(String(chatId))}/feature`, {
    method: "POST", body: JSON.stringify({ feature, enabled }),
  });
}

/**
 * 分页拉取指定群的热 256 条发言记录（不含压缩记忆摘要）。
 * @param chatId 目标群 ID
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @returns 热发言记录分页结果
 */
export async function fetchMiniAppChatMessages(
  chatId: number, page: number, pageSize: number
): Promise<MiniAppMessagePage> {
  return miniAppFetchJson(
    `./api/chats/${encodeURIComponent(String(chatId))}/messages?page=${page}&pageSize=${pageSize}`
  );
}

/**
 * 按页码拉取白名单与权限矩阵列表（含当前页、总页数及黑白名单总条数，支持按名称/用户名/ID 搜索）。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @param query 可选搜索关键字
 * @returns 白名单分页结果
 */
export async function fetchMiniAppWhitelist(
  page: number, pageSize: number, query: string = ""
): Promise<MiniAppWhitelistPage> {
  const trimmed: string = query.trim();
  const suffix: string = trimmed.length > 0 ? `&query=${encodeURIComponent(trimmed)}` : "";
  return miniAppFetchJson(`./api/identities/whitelist?page=${page}&pageSize=${pageSize}${suffix}`);
}

/**
 * 按数字 ID 添加或移出白名单。
 * @param id 用户正整数 ID 或 `-100...` 频道 ID
 * @param enabled `true` 为加入白名单，`false` 为从白名单移除
 * @returns 名单变更结果
 */
export async function setMiniAppWhitelistMembership(
  id: number, enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  return miniAppFetchJson("./api/identities/whitelist", {
    method: "POST", body: JSON.stringify({ id, enabled }),
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
  id: number, permission: WhitelistPermissionKey | "all", enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  const body: Record<string, unknown> =
    permission === "all" ? { id, enableAll: true } : { id, key: permission, value: enabled };
  return miniAppFetchJson("./api/identities/permission", {
    method: "POST", body: JSON.stringify(body),
  });
}

/**
 * 按页码拉取黑名单列表（含当前页、总页数及黑白名单总条数，支持按名称/用户名/ID 搜索）。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @param query 可选搜索关键字
 * @returns 黑名单分页结果
 */
export async function fetchMiniAppBlocklist(
  page: number, pageSize: number, query: string = ""
): Promise<MiniAppBlocklistPage> {
  const trimmed: string = query.trim();
  const suffix: string = trimmed.length > 0 ? `&query=${encodeURIComponent(trimmed)}` : "";
  return miniAppFetchJson(`./api/identities/blocklist?page=${page}&pageSize=${pageSize}${suffix}`);
}

/**
 * 按数字 ID 加入或移出黑名单。
 * @param id 用户正整数 ID 或 `-100...` 频道 ID
 * @param enabled `true` 为拉黑，`false` 为解封
 * @returns 名单变更结果
 */
export async function setMiniAppBlocklistMembership(
  id: number, enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  return miniAppFetchJson("./api/identities/blocklist", {
    method: "POST", body: JSON.stringify({ id, enabled }),
  });
}

/**
 * 请求后端生成 `savePreparedKeyboardButton` 原生好友/联系人/频道选择器会话。
 * @param targetList 目标名单（`"whitelist"` 或 `"blocklist"`）
 * @param subjectKind 目标身份类型（`"users"` 或 `"channel"`）
 * @returns 预备选择器会话信息
 */
export async function requestMiniAppPreparedPicker(
  targetList: MiniAppPickerTargetList, subjectKind: MiniAppPickerSubjectKind
): Promise<Extract<PrepareMiniAppPickerResult, { readonly ok: true }>> {
  return miniAppFetchJson("./api/picker/prepare", {
    method: "POST", body: JSON.stringify({ targetList, subjectKind }),
  });
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
    await miniAppFetchJson(`./api/picker/result?requestId=${encodeURIComponent(String(requestId))}`);
  return response.result;
}

/**
 * 按页码拉取当前配置的图库图片列表。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页张数
 * @returns 图库分页结果
 */
export async function fetchMiniAppGallery(
  page: number, pageSize: number
): Promise<MiniAppGalleryPage> {
  return miniAppFetchJson(`./api/gallery?page=${page}&pageSize=${pageSize}`);
}

/**
 * 为图片或 SVG 资源路径附加跨重开稳定的受保护资源令牌 `?token=`（未下发稳定令牌时回退附加 `initData` 与可选 `session` 查询参数）。
 * @param basePrefix 资源路由前缀（如 `"./api/gallery/file"`）
 * @param fileName 资源文件名
 * @returns 带鉴权查询参数的受保护资源 URL
 */
function buildProtectedAssetUrl(basePrefix: string, fileName: string): string {
  const encodedName: string = encodeURIComponent(fileName);
  const assetToken: string = readMiniAppAssetToken();
  if (assetToken.length > 0) {
    return `${basePrefix}/${encodedName}?token=${encodeURIComponent(assetToken)}`;
  }
  const initData: string = readMiniAppInitData();
  const sessionToken: string = readMiniAppSessionToken();
  if (initData.length === 0) return `${basePrefix}/${encodedName}`;
  const sessionQuery: string =
    sessionToken.length > 0 ? `&session=${encodeURIComponent(sessionToken)}` : "";
  return `${basePrefix}/${encodedName}?initData=${encodeURIComponent(initData)}${sessionQuery}`;
}

/**
 * 构造携带当前 SuperAdmin `initData` 签名与 90 分钟会话令牌的图库单张图片预览地址。
 * @param fileName 图库图片文件名
 * @returns 供 `<img>` 使用的受保护预览 URL
 */
export function buildMiniAppGalleryImageUrl(fileName: string): string {
  return buildProtectedAssetUrl("./api/gallery/file", fileName);
}

/**
 * 构造携带当前 SuperAdmin `initData` 签名的受保护 SVG 图标资源地址。
 * @param fileName `miniAppResoures` 下的 SVG 文件名（如 `"status.svg"`）
 * @returns 供受保护访问的 SVG 资源 URL
 */
export function buildMiniAppSvgResourceUrl(fileName: string): string {
  return buildProtectedAssetUrl("./api/resources/svg", fileName);
}

/**
 * 按现有 `/h_image add` 协议（字节上限、魔数格式、像素尺寸与内容 SHA-256 去重）上传单张图片到图库目录。
 * @param bytes 待上传的图片原始字节
 * @returns 结构化的上传入库结果
 */
export async function uploadMiniAppGalleryImageBytes(
  bytes: Uint8Array
): Promise<MiniAppGalleryUploadResult> {
  const response: Response = await fetch("./api/gallery/upload", {
    method: "POST",
    headers: buildMiniAppAuthHeaders(true, "application/octet-stream"),
    body: bytes,
  });
  const payload: unknown = await response.json().catch((): null => null);
  const record: Record<string, unknown> = asPayloadRecord(payload);
  if (typeof record.outcome === "string" && typeof record.message === "string") {
    return payload as MiniAppGalleryUploadResult;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { ok: false, outcome: "failed", message: "未收到有效的上传回执。" };
}

/**
 * 从图库目录删除指定文件名的单张图片。
 * @param fileName 待删除的图库图片文件名
 * @returns 结构化的删除结果
 */
export async function deleteMiniAppGalleryImageByName(
  fileName: string
): Promise<MiniAppGalleryDeleteResult> {
  return miniAppFetchJson<MiniAppGalleryDeleteResult>(
    `./api/gallery/file/${encodeURIComponent(fileName)}`,
    { method: "DELETE" }
  );
}

/**
 * 构造携带受保护资源令牌（或 `initData`）与 90 分钟 `session` 会话令牌的图库单张图片附件下载 URL。
 * @param fileName 图库图片文件名
 * @returns 带完整双层鉴权查询参数的下载 URL
 */
export function buildMiniAppGalleryDownloadUrl(fileName: string): string {
  const encodedName: string = encodeURIComponent(fileName);
  const basePath: string = `./api/gallery/download/${encodedName}`;
  const assetToken: string = readMiniAppAssetToken();
  const initData: string = readMiniAppInitData();
  const sessionToken: string = readMiniAppSessionToken();
  const params: URLSearchParams = new URLSearchParams();
  if (assetToken.length > 0) {
    params.set("token", assetToken);
  } else if (initData.length > 0) {
    params.set("initData", initData);
  }
  if (sessionToken.length > 0) {
    params.set("session", sessionToken);
  }
  const query: string = params.toString();
  return query.length > 0 ? `${basePath}?${query}` : basePath;
}

/**
 * 先通过完整双层鉴权 `HEAD /api/gallery/download/:fileName` 校验 90 分钟会话与文件存在性，随后优先调用 Telegram 原生 `WebApp.downloadFile({ url, file_name })`（或浏览器原生 `Content-Disposition: attachment` 直连下载）并以秒级时间戳文件名将图片保存至系统默认下载目录。
 * @param fileName 待下载的图库图片文件名
 * @returns 用户确认或触发原生下载时返回 `true`，在 Telegram 原生弹窗中取消时返回 `false`
 */
export async function downloadMiniAppGalleryImageByName(fileName: string): Promise<boolean> {
  const relativeUrl: string = buildMiniAppGalleryDownloadUrl(fileName);
  const response: Response = await fetch(relativeUrl, {
    method: "HEAD",
    headers: buildMiniAppAuthHeaders(true),
  });
  if (!response.ok) {
    const getRes: Response = await fetch(
      `./api/gallery/download/${encodeURIComponent(fileName)}`,
      { method: "GET", headers: buildMiniAppAuthHeaders(true) }
    );
    const payload: unknown = await getRes.json().catch((): null => null);
    const record: Record<string, unknown> = asPayloadRecord(payload);
    if (record.code === "PASSWORD_REQUIRED" || record.code === "PASSWORD_LOCKED") {
      clearMiniAppSessionToken();
    }
    const errText: string =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : `HTTP ${String(response.status)}`;
    throw new Error(errText);
  }
  const downloadFileName: string = buildMiniAppGalleryDownloadFileName(fileName);
  const tgWindow: TelegramWindow = globalThis;
  const baseHref: string | undefined = tgWindow.location?.href;
  const absoluteUrl: string =
    typeof baseHref === "string" && baseHref.length > 0
      ? new URL(relativeUrl, baseHref).href
      : relativeUrl;
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const canUseTelegramNativeDownload: boolean =
    typeof webApp?.downloadFile === "function" &&
    (typeof webApp.isVersionAtLeast !== "function" || webApp.isVersionAtLeast("8.0"));
  if (canUseTelegramNativeDownload && webApp?.downloadFile !== undefined) {
    return await new Promise<boolean>((resolve: (accepted: boolean) => void): void => {
      webApp.downloadFile!(
        { url: absoluteUrl, file_name: downloadFileName },
        (accepted: boolean): void => {
          resolve(accepted);
        }
      );
    });
  }
  if (typeof tgWindow.document?.createElement === "function") {
    const anchor: MiniAppDownloadAnchorElement = tgWindow.document.createElement("a");
    anchor.href = absoluteUrl;
    anchor.download = downloadFileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    tgWindow.document.body?.appendChild?.(anchor);
    anchor.click();
    anchor.remove();
  }
  return true;
}

/**
 * 查询当前 Google Authenticator 验证器的启用状态与脱敏摘要。
 * @returns 验证器状态视图
 */
export async function fetchMiniAppTotpStatus(): Promise<MiniAppTotpStatusView> {
  return miniAppFetchJson<MiniAppTotpStatusView>("./api/totp");
}

/**
 * 在前端控制台生成新的待确认 TOTP 密钥、标准 `otpauth://` URI 与内联二维码 SVG。
 * @returns 待绑定密钥与二维码响应
 */
export async function setupMiniAppTotp(): Promise<MiniAppTotpSetupResponse> {
  return miniAppFetchJson<MiniAppTotpSetupResponse>("./api/totp/setup", { method: "POST" });
}

/**
 * 提交 6 位 Google Authenticator 动态码以激活或修改唯一验证器。
 * @param code 6 位十进制验证码
 * @returns 绑定或修改结果
 */
export async function enableMiniAppTotp(code: string): Promise<MiniAppTotpMutationResponse> {
  return miniAppFetchJson<MiniAppTotpMutationResponse>("./api/totp/enable", {
    method: "POST", body: JSON.stringify({ code }),
  });
}

/**
 * 删除当前唯一的 Google Authenticator 验证器并恢复密码登录。
 * @returns 删除结果
 */
export async function deleteMiniAppTotp(): Promise<MiniAppTotpMutationResponse> {
  return miniAppFetchJson<MiniAppTotpMutationResponse>("./api/totp", { method: "DELETE" });
}
