import {
  MINI_APP_ASSET_CACHE_CONTROL, MINI_APP_BUNDLE_CACHE_CONTROL,
  MINI_APP_BUNDLE_VARY_HEADER_VALUE, MINI_APP_CSP_HEADER_VALUE,
  MINI_APP_IPV4_HOST_PATTERN, MINI_APP_NO_STORE_CACHE_CONTROL,
  MINI_APP_X_FRAME_OPTIONS_VALUE,
} from "../../consts/miniApp";
import type { MiniAppAccessDiagnostics } from "../../types/miniApp/auth";
import type { BundledMiniAppAsset } from "../../types/miniApp/server";
import { firstForwardedHost, resolveSafeClientIp } from "./request";

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

/** 无 `requestId` 时复用的 JSON 防缓存响应头。 */
const JSON_NO_STORE_HEADERS: Readonly<Record<string, string>> =
  buildNoStoreHeaders("application/json; charset=utf-8");

/** 鉴权通过后的单页 HTML 入口响应复用的防缓存响应头。 */
const HTML_NO_STORE_HEADERS: Readonly<Record<string, string>> =
  buildNoStoreHeaders("text/html; charset=utf-8");

/** 受保护静态资源与前端打包产物共用的安全响应头集合。 */
const ASSET_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": MINI_APP_X_FRAME_OPTIONS_VALUE,
  "Content-Security-Policy": MINI_APP_CSP_HEADER_VALUE,
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/**
 * 生成允许已鉴权 Telegram WebView 客户端与 Cloudflare CDN 边缘节点持久化缓存 7 天的图片/SVG/图标资源响应头；
 * 仅在传入实体元数据时写入 `Content-Type` 与 `Content-Length`（`304 Not Modified` 省略实体头）。
 * @param etag 资源校验 `ETag` 响应头值。
 * @param contentType 资源的 `Content-Type` 响应头值（`304` 时省略）。
 * @param contentLength 资源字节长度（`304` 时省略）。
 * @returns 响应头键值对。
 */
function buildAssetCacheHeaders(
  etag: string,
  contentType?: string,
  contentLength?: number
): Record<string, string> {
  if (contentType !== undefined && contentLength !== undefined) {
    return {
      "Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
      "CDN-Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
      "Cloudflare-CDN-Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
      "ETag": etag,
      ...ASSET_SECURITY_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
    };
  }
  return {
    "Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
    "CDN-Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
    "Cloudflare-CDN-Cache-Control": MINI_APP_ASSET_CACHE_CONTROL,
    "ETag": etag,
    ...ASSET_SECURITY_HEADERS,
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
    headers:
      requestId === undefined
        ? JSON_NO_STORE_HEADERS
        : buildNoStoreHeaders("application/json; charset=utf-8", requestId),
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
    headers: HTML_NO_STORE_HEADERS,
  });
}

/**
 * 构造带浏览器与 CDN 缓存头及 `ETag` 协商校验（按弱比较命中 `If-None-Match` 时返回 `304 Not Modified` 且不附带 `Content-Type`/`Content-Length`）的受保护资源或公开图标响应；`HEAD` 请求不带响应体。
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
  if (ifNoneMatchMatchesEtag(request.headers.get("if-none-match"), meta.etag)) {
    return new Response(null, {
      status: 304,
      headers: buildAssetCacheHeaders(meta.etag),
    });
  }
  return new Response(request.method.toUpperCase() === "HEAD" ? null : body, {
    status: 200,
    headers: buildAssetCacheHeaders(meta.etag, meta.mimeType, meta.sizeBytes),
  });
}

/**
 * 生成已通过超级管理员门禁校验的前端打包产物响应头（仅允许客户端私有协商重验，严禁 CDN 缓存完整前端包）；
 * 仅在传入实体元数据时写入 `Content-Type` 与 `Content-Length`（`304 Not Modified` 省略实体头）。
 * @param etag 资源校验 `ETag` 响应头值。
 * @param contentType 资源的 `Content-Type` 响应头值（`304` 时省略）。
 * @param contentLength 资源字节长度（`304` 时省略）。
 * @returns 响应头键值对。
 */
function buildBundleAssetHeaders(
  etag: string,
  contentType?: string,
  contentLength?: number
): Record<string, string> {
  if (contentType !== undefined && contentLength !== undefined) {
    return {
      "Cache-Control": MINI_APP_BUNDLE_CACHE_CONTROL,
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      "Vary": MINI_APP_BUNDLE_VARY_HEADER_VALUE,
      "ETag": etag,
      ...ASSET_SECURITY_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
    };
  }
  return {
    "Cache-Control": MINI_APP_BUNDLE_CACHE_CONTROL,
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Vary": MINI_APP_BUNDLE_VARY_HEADER_VALUE,
    "ETag": etag,
    ...ASSET_SECURITY_HEADERS,
  };
}

/**
 * 剥离弱 ETag 前缀 `W/`，用于对称执行 HTTP 弱比较。
 * @param tag 原始 ETag 令牌（如 `"etag"` 或 `W/"etag"`）。
 * @returns 去掉 `W/` 前缀后的实体标签字符串。
 */
function stripWeakEtagPrefix(tag: string): string {
  return tag.startsWith('W/"') ? tag.slice(2) : tag;
}

/**
 * 按 HTTP 弱比较与引号感知的逗号分隔规则，判断请求头 `If-None-Match` 是否命中当前静态资源或打包资源的 `ETag`。
 * @param ifNoneMatchHeader 原始 `If-None-Match` 请求头值。
 * @param etag 当前资源的 `ETag` 值。
 * @returns 命中时返回 `true`。
 */
function ifNoneMatchMatchesEtag(
  ifNoneMatchHeader: string | null,
  etag: string
): boolean {
  if (ifNoneMatchHeader === null) return false;
  const trimmed: string = ifNoneMatchHeader.trim();
  if (trimmed.length === 0) return false;
  const normalizedTarget: string = stripWeakEtagPrefix(etag);
  if (
    normalizedTarget.length < 2 ||
    !normalizedTarget.startsWith('"') ||
    !normalizedTarget.endsWith('"')
  ) {
    return false;
  }
  if (trimmed === "*") return true;
  if (!trimmed.includes(",")) {
    return stripWeakEtagPrefix(trimmed) === normalizedTarget;
  }
  const len: number = trimmed.length;
  let segmentStart: number = 0;
  let inQuotes: boolean = false;
  for (let i: number = 0; i < len; i += 1) {
    const ch: string = trimmed.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      const candidate: string = trimmed.slice(segmentStart, i).trim();
      if (
        candidate === "*" ||
        stripWeakEtagPrefix(candidate) === normalizedTarget
      ) {
        return true;
      }
      segmentStart = i + 1;
    }
  }
  const tail: string = trimmed.slice(segmentStart).trim();
  return tail === "*" || stripWeakEtagPrefix(tail) === normalizedTarget;
}

/**
 * 构造已通过超级管理员门禁核验的前端打包资源响应（命中 `If-None-Match` 返回 `304 Not Modified` 且不附带 `Content-Type`/`Content-Length`，`HEAD` 请求不返回正文）。
 * @param request HTTP 请求对象。
 * @param asset 已物化的打包静态资源条目。
 * @returns `200 OK` 或 `304 Not Modified` 的 `Response` 实例。
 */
export function serveBundledAssetResponse(
  request: Request,
  asset: Readonly<BundledMiniAppAsset>
): Response {
  if (ifNoneMatchMatchesEtag(request.headers.get("if-none-match"), asset.etag)) {
    return new Response(null, {
      status: 304,
      headers: buildBundleAssetHeaders(asset.etag),
    });
  }
  return new Response(
    request.method.toUpperCase() === "HEAD"
      ? null
      : (asset.content as Uint8Array<ArrayBuffer>),
    {
      status: 200,
      headers: buildBundleAssetHeaders(
        asset.etag,
        asset.contentType,
        asset.content.byteLength
      ),
    }
  );
}

/** `buildMiniAppAccessDiagnostics` 构造拒绝诊断快照所需的参数。 */
export interface BuildMiniAppAccessDiagnosticsParams {
  /** HTTP 状态码（`401` 或 `403`）。 */
  readonly status: number;
  /** 英文错误状态码（如 `"MISSING_INIT_DATA"`、`"FORBIDDEN_USER"`、`"PASSWORD_LOCKED"`）。 */
  readonly code: string;
  /** 英文错误状态码字串（与 `code` 对应，供前端统一映射多语言提示）。 */
  readonly error: string;
  /** 凭据校验失败时剩余的可尝试次数。 */
  readonly remainingAttempts?: number;
  /** 处于 30 分钟锁定期时剩余的锁定分钟数。 */
  readonly remainingMinutes?: number;
}

/** `accessErrorResponse` 所需的鉴权拒绝参数。 */
export interface AccessErrorResponseParams extends BuildMiniAppAccessDiagnosticsParams {
  /** 验签或鉴权失败原因分类标识。 */
  readonly reason: string;
}

/**
 * 构造包含真实请求追踪 ID、UTC 时间戳、客户端出口 IP 与已脱敏源站 IP 字面量 Host 的访问拒绝诊断对象。
 * @param request HTTP 请求对象。
 * @param params 状态码、错误代号与可选剩余次数/锁定分钟数。
 * @returns 只读的 `MiniAppAccessDiagnostics` 快照。
 */
export function buildMiniAppAccessDiagnostics(
  request: Request,
  params: Readonly<BuildMiniAppAccessDiagnosticsParams>
): Readonly<MiniAppAccessDiagnostics> {
  const randomBytes: Uint8Array = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  const requestId: string = randomBytes.toHex();
  const timestamp: string = `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  const clientIp: string = resolveSafeClientIp(request);
  const parsedUrl: URL | null = URL.parse(request.url);
  const hostHeader: string = request.headers.get("host")?.trim() ?? "";
  const urlHost: string = parsedUrl?.host ?? "";
  const rawHost: string =
    firstForwardedHost(request.headers) ??
    (hostHeader.length > 0
      ? hostHeader
      : urlHost.length > 0
        ? urlHost
        : "localhost");
  const firstColon: number = rawHost.indexOf(":");
  const hasMultipleColons: boolean =
    firstColon >= 0 && rawHost.includes(":", firstColon + 1);
  const hostNoPort: string = (firstColon >= 0 ? rawHost.slice(0, firstColon) : rawHost)
    .trim()
    .toLowerCase();
  const isIpHost: boolean =
    rawHost.startsWith("[") ||
    hasMultipleColons ||
    MINI_APP_IPV4_HOST_PATTERN.test(hostNoPort);
  const host: string = rawHost.length > 0 && !isIpHost ? rawHost : "localhost";
  const path: string = parsedUrl?.pathname ?? "/";
  return {
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
  const diag: Readonly<MiniAppAccessDiagnostics> = buildMiniAppAccessDiagnostics(
    request,
    params
  );
  return jsonResponse({ ok: false, reason: params.reason, ...diag }, params.status, diag.requestId);
}
