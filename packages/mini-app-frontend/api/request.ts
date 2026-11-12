import {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
  MINI_APP_TMA_AUTH_PREFIX,
} from "../consts/miniApp";
import {
  clearMiniAppSessionToken,
  readMiniAppAssetToken,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} from "../libs/credentials";
import { asPayloadRecord } from "../libs/record";
import { readMiniAppInitData } from "../libs/telegram";

/**
 * 将服务端毫秒时间戳换算为本机时钟下的同一时刻：以响应 `Date` 头（秒级精度）与本机当前时刻之差作为两端时钟差；
 * 缺少或无法解析 `Date` 头时视为无时钟差。会话到期判定与自动锁定都以换算后的本机时刻为准。
 * @param serverEpochMs 服务端给出的毫秒时间戳
 * @param response 携带该时间戳的 HTTP 响应
 * @returns 本机时钟下的毫秒时间戳
 */
export function toLocalEpochMs(serverEpochMs: number, response: Response): number {
  const serverDateMs: number = Date.parse(response.headers.get("date") ?? "");
  if (!Number.isFinite(serverDateMs)) return serverEpochMs;
  return serverEpochMs - (serverDateMs - Date.now());
}

/**
 * 检查服务端响应头中是否包含超过 5 分钟自动刷新的新会话令牌（`X-Mini-App-Session` 与 `X-Mini-App-Session-Expires-At`），
 * 若存在合法的新令牌则立即同步更新本地持久化凭据，并按 `toLocalEpochMs` 换算后的本机到期时刻延长有效期（无法换算出未来时刻时按本机当前时刻加 45 分钟）。
 * @param response HTTP 响应对象
 */
export function syncRefreshedMiniAppSession(response: Response): void {
  const refreshedToken: string =
    response.headers.get(MINI_APP_SESSION_HEADER)?.trim() ?? "";
  if (!MINI_APP_SHA256_HEX_PATTERN.test(refreshedToken)) return;
  const rawExpiresAt: string =
    response.headers.get(MINI_APP_SESSION_EXPIRES_AT_HEADER)?.trim() ?? "";
  const localExpiresAt: number = toLocalEpochMs(Number(rawExpiresAt), response);
  const nowMs: number = Date.now();
  const nextExpiresAt: number =
    localExpiresAt > nowMs ? localExpiresAt : nowMs + MINI_APP_SESSION_TTL_MS;
  setMiniAppSessionToken(refreshedToken, nextExpiresAt);
}

/**
 * 组装携带当前会话 `initData` 与 45 分钟令牌的认证请求头。
 * @param includeSession 是否附加 45 分钟会话令牌头
 * @param contentType 可选的 `Content-Type`
 * @returns 组装好的请求头字典
 */
export function buildMiniAppAuthHeaders(includeSession: boolean, contentType?: string): Record<string, string> {
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
 * 判断错误文案是否携带服务端鉴权失效或锁定前缀（`[PASSWORD_REQUIRED]` 或 `[PASSWORD_LOCKED]`）。
 * @param message 错误消息文本
 * @returns 命中鉴权失效或锁定前缀时返回 `true`
 */
export function isMiniAppAuthErrorMessage(message: string): boolean {
  return (
    message.includes("[PASSWORD_REQUIRED]") ||
    message.includes("[PASSWORD_LOCKED]")
  );
}

/**
 * 核对服务端错误响应记录中的鉴权失败状态码：命中 `PASSWORD_REQUIRED` 或 `PASSWORD_LOCKED` 时
 * 清除本地会话令牌并返回 `"[<状态码>] "` 前缀，否则返回空字符串。
 * @param record 服务端响应 JSON 解析出的字典
 * @returns 鉴权失败前缀或空字符串
 */
export function consumeMiniAppAuthErrorPrefix(
  record: Readonly<Record<string, unknown>>
): string {
  const code: string = typeof record.code === "string" ? record.code : "";
  if (code === "PASSWORD_REQUIRED" || code === "PASSWORD_LOCKED") {
    clearMiniAppSessionToken();
    return `[${code}] `;
  }
  return "";
}

/**
 * 调用 Mini App 后端 JSON 接口并附带 SuperAdmin `initData` 与 45 分钟密码会话令牌请求头。
 * 非 2xx 响应抛出 `Error`：会话缺失或锁定（`PASSWORD_REQUIRED` / `PASSWORD_LOCKED`）时先清除本地会话令牌，并在消息前加 `[代号] ` 前缀。
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
  syncRefreshedMiniAppSession(response);
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    const record: Record<string, unknown> = asPayloadRecord(payload);
    const prefix: string = consumeMiniAppAuthErrorPrefix(record);
    const errorMessage: string =
      typeof record.error === "string"
        ? record.error
        : typeof record.message === "string"
          ? record.message
          : `HTTP ${response.status}`;
    throw new Error(`${prefix}${errorMessage}`, { cause: record });
  }
  return payload as T;
}

/**
 * 为图片或 SVG 资源路径附加跨重开稳定的受保护资源令牌 `?token=`（未下发稳定令牌时回退附加 `initData` 与可选 `session` 查询参数）。
 * @param basePrefix 资源路由前缀（如 `"./api/gallery/file"`）
 * @param fileName 资源文件名
 * @returns 带鉴权查询参数的受保护资源 URL
 */
export function buildProtectedAssetUrl(basePrefix: string, fileName: string): string {
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
