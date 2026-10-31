import {
  MINI_APP_ASSET_CACHE_CONTROL, MINI_APP_CSP_HEADER_VALUE, MINI_APP_IPV4_HOST_PATTERN,
  MINI_APP_NO_STORE_CACHE_CONTROL, MINI_APP_X_FRAME_OPTIONS_VALUE,
} from "../../consts/miniApp";
import type { MiniAppAccessDiagnostics } from "../../types/miniApp";
import { resolveSafeClientIp } from "./request";

/** `serveCachedAssetResponse` 所需的已解析资源元数据。 */
interface CachedAssetMeta {
  /** 资源的 `Content-Type` 响应头值。 */
  readonly mimeType: string;
  /** 资源字节长度。 */
  readonly sizeBytes: number;
  /** 资源强校验 `ETag` 响应头值。 */
  readonly etag: string;
}

/**
 * 生成统一的防缓存响应头（防止 Cloudflare Tunnel 边缘节点或浏览器缓存动态状态）。
 * @param contentType 可选的 `Content-Type` 响应头值。
 * @param requestId 可选的请求追踪 ID（写入 `X-Request-Id` 响应头）。
 * @returns 响应头键值对。
 */
export function buildNoStoreHeaders(
  contentType?: string,
  requestId?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": MINI_APP_NO_STORE_CACHE_CONTROL,
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": MINI_APP_X_FRAME_OPTIONS_VALUE,
    "Content-Security-Policy": MINI_APP_CSP_HEADER_VALUE,
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  if (requestId !== undefined) headers["X-Request-Id"] = requestId;
  return headers;
}

/**
 * 生成允许已鉴权 Telegram WebView 客户端与 Cloudflare CDN 边缘节点持久化缓存 7 天的图片/SVG/图标资源响应头。
 * @param contentType 资源的 `Content-Type` 响应头值。
 * @param contentLength 资源字节长度。
 * @param etag 资源强校验 `ETag` 响应头值。
 * @returns 响应头键值对。
 */
function buildAssetCacheHeaders(
  contentType: string,
  contentLength: number,
  etag: string
): Record<string, string> {
  return {
    "Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
    "CDN-Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
    "Cloudflare-CDN-Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
    "ETag": etag,
    "Content-Type": contentType,
    "Content-Length": String(contentLength),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": MINI_APP_X_FRAME_OPTIONS_VALUE,
    "Content-Security-Policy": MINI_APP_CSP_HEADER_VALUE,
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

/**
 * 使用 Bun 原生 `Response.json` 构造带防缓存头的 JSON 响应。
 * @param payload 待序列化的 JSON 载荷。
 * @param status HTTP 状态码（默认 200）。
 * @param requestId 可选的请求追踪 ID。
 * @returns `Response` 实例。
 */
export function jsonResponse(
  payload: unknown,
  status: number = 200,
  requestId?: string
): Response {
  return Response.json(payload, {
    status,
    headers: buildNoStoreHeaders("application/json; charset=utf-8", requestId),
  });
}

/**
 * 构造带防缓存头的 HTML 响应。
 * @param html HTML 文本。
 * @param headOnly 是否为 `HEAD` 请求（仅返回响应头，无响应体）。
 * @returns `Response` 实例。
 */
export function htmlResponse(html: string, headOnly: boolean): Response {
  return new Response(headOnly ? null : html, {
    status: 200,
    headers: buildNoStoreHeaders("text/html; charset=utf-8"),
  });
}

/**
 * 构造带浏览器与 CDN 缓存头及 `ETag` 强校验（命中 `If-None-Match` 返回 `304 Not Modified`）的受保护资源或公开图标响应；`HEAD` 请求不带响应体。
 * @param request HTTP 请求对象。
 * @param body 响应体（`Bun.BunFile`）。
 * @param meta 已解析资源的 MIME、字节长度与 `ETag`。
 * @returns `200 OK` 或 `304 Not Modified` 的 `Response` 实例。
 */
export function serveCachedAssetResponse(
  request: Request,
  body: Bun.BunFile,
  meta: Readonly<CachedAssetMeta>
): Response {
  const headers: Record<string, string> = buildAssetCacheHeaders(
    meta.mimeType,
    meta.sizeBytes,
    meta.etag
  );
  if (request.headers.get("if-none-match") === meta.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method.toUpperCase() === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

/** `accessErrorResponse` 所需的鉴权拒绝参数。 */
export interface AccessErrorResponseParams {
  /** HTTP 状态码（`401` 或 `403`）。 */
  readonly status: number;
  /** 英文错误状态码（如 `"PASSWORD_REQUIRED"`、`"INVALID_PASSWORD"`）。 */
  readonly code: string;
  /** 验签或鉴权失败原因分类标识。 */
  readonly reason: string;
  /** 英文错误状态码字串（与 `code` 对应，供前端统一映射多语言提示）。 */
  readonly error: string;
  /** 凭据校验失败时剩余的可尝试次数。 */
  readonly remainingAttempts?: number;
  /** 处于 30 分钟锁定期时剩余的锁定分钟数。 */
  readonly remainingMinutes?: number;
}

/**
 * 构造携带真实请求 ID、时间戳、客户端出口 IP 与 Host 的 401/403 JSON 响应（严禁暴露源站服务器 IP）。
 * @param request HTTP 请求对象。
 * @param params 状态码、错误代号、原因标识与可选锁定参数。
 * @returns 带 `X-Request-Id` 响应头的 JSON `Response`。
 */
export function accessErrorResponse(
  request: Request,
  params: Readonly<AccessErrorResponseParams>
): Response {
  const randomBytes: Uint8Array = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  const requestId: string = randomBytes.toHex();
  const timestamp: string = `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  const clientIp: string = resolveSafeClientIp(request);
  let parsedUrl: URL | null;
  try {
    parsedUrl = new URL(request.url);
  } catch (_error: unknown) {
    parsedUrl = null;
  }
  const rawHost: string =
    request.headers.get("x-forwarded-host")?.trim() ??
    request.headers.get("host")?.trim() ??
    parsedUrl?.host ??
    "localhost";
  const hostNoPort: string = rawHost.split(":")[0]?.trim().toLowerCase() ?? "";
  const isIpHost: boolean =
    hostNoPort.startsWith("[") || MINI_APP_IPV4_HOST_PATTERN.test(hostNoPort);
  const host: string = rawHost.length > 0 && !isIpHost ? rawHost : "localhost";
  const path: string = parsedUrl?.pathname ?? "/";
  const diag: Readonly<MiniAppAccessDiagnostics> = {
    requestId,
    timestamp,
    clientIp,
    host,
    path,
    status: params.status,
    code: params.code,
    error: params.error,
    ...(params.remainingAttempts !== undefined
      ? { remainingAttempts: params.remainingAttempts }
      : {}),
    ...(params.remainingMinutes !== undefined
      ? { remainingMinutes: params.remainingMinutes }
      : {}),
  };
  return jsonResponse({ ok: false, reason: params.reason, ...diag }, params.status, diag.requestId);
}
