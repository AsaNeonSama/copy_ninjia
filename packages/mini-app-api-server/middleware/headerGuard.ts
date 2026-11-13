import { miniAppActiveUrlPartsHolder } from "../../cache/main/miniApp";
import { getBotMiniAppConfig } from "../../config/bot";
import {
  MINI_APP_CONTROL_CHARS_PATTERN,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_MAX_INIT_DATA_LENGTH,
  MINI_APP_TMA_AUTH_PREFIX,
} from "../../consts/miniApp";
import type { MiniAppMiddleware, MiniAppRouteContext } from "../../types/miniApp/server";
import { accessErrorResponse } from "../libs/response";
import type { AccessErrorResponseParams } from "../libs/response";
import { firstForwardedHost } from "../libs/request";
import { deriveMiniAppPublicUrlParts } from "../libs/routePath";

/**
 * 校验请求头中的 `Origin` 或 `Referer` URL 是否与当前 Mini App 源站或反向代理 Host 同源。
 * @param rawUrl 待核验的 `Origin` 或 `Referer` 原始头值。
 * @param request HTTP 请求对象。
 * @param parsedRequestUrl 调用方已解析好的请求 `URL`（缺省时按需以 `URL.parse` 解析 `request.url`）。
 * @returns 同源合法时返回 `true`，伪造或跨源时返回 `false`。
 */
export function isAllowedRequestOriginUrl(
  rawUrl: string,
  request: Request,
  parsedRequestUrl?: URL
): boolean {
  const trimmed: string = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "null") {
    return false;
  }
  const parsedOrigin: URL | null = URL.parse(trimmed);
  if (
    parsedOrigin === null ||
    (parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:")
  ) {
    return false;
  }
  const candidateHost: string = parsedOrigin.host.toLowerCase();
  const headers: Headers = request.headers;
  const forwardedHost: string | null = firstForwardedHost(headers);
  if (forwardedHost !== null && candidateHost === forwardedHost.toLowerCase()) {
    return true;
  }
  const hostHeader: string = headers.get("host")?.trim().toLowerCase() ?? "";
  if (hostHeader.length > 0 && candidateHost === hostHeader) {
    return true;
  }
  const reqUrlHost: string =
    (parsedRequestUrl ?? URL.parse(request.url))?.host.toLowerCase() ?? "";
  if (reqUrlHost.length > 0 && candidateHost === reqUrlHost) {
    return true;
  }
  const configHost: string = (
    miniAppActiveUrlPartsHolder.current ??
    deriveMiniAppPublicUrlParts(getBotMiniAppConfig())
  ).host;
  return configHost.length > 0 && candidateHost === configHost;
}

/**
 * 判断 `Sec-Fetch-Site` 请求头是否明确指示非同源跨站请求。
 * @param headers HTTP 请求头对象。
 * @returns 存在非空且不属于 `"same-origin"`、`"same-site"`、`"none"` 的值时返回 `true`。
 */
export function hasDisallowedSecFetchSite(headers: Headers): boolean {
  const secFetchSite: string | null = headers.get("sec-fetch-site")?.trim().toLowerCase() ?? null;
  return (
    secFetchSite !== null &&
    secFetchSite.length > 0 &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "same-site" &&
    secFetchSite !== "none"
  );
}

/**
 * 判断子资源请求的 `Sec-Fetch-Mode` 或 `Sec-Fetch-Dest` 是否属于直接文档导航或嵌套容器加载。
 * @param headers HTTP 请求头对象。
 * @returns 命中导航或文档/框架嵌入模式时返回 `true`。
 */
export function hasDisallowedSubresourceFetchMetadata(headers: Headers): boolean {
  const secFetchMode: string | null = headers.get("sec-fetch-mode")?.trim().toLowerCase() ?? null;
  const secFetchDest: string | null = headers.get("sec-fetch-dest")?.trim().toLowerCase() ?? null;
  return (
    secFetchMode === "navigate" ||
    secFetchMode === "nested-navigate" ||
    secFetchMode === "websocket" ||
    secFetchDest === "document" ||
    secFetchDest === "iframe" ||
    secFetchDest === "frame" ||
    secFetchDest === "object" ||
    secFetchDest === "embed"
  );
}

/**
 * 从请求头中提取并快路径校验 `X-Telegram-Init-Data` 与 `Authorization: tma <initData>` 凭据：
 * 两个凭据头均缺省或全空白时返回 `null`；形态合法时返回去空白后的 `initData` 字符串；
 * 认证方案非法、双头冲突或凭据畸形时返回对应的 `AccessErrorResponseParams`。
 * @param headers HTTP 请求头对象。
 * @returns 已通过形态快路径核验的 `initData` 字符串、两个凭据头均缺省时的 `null`，或拒绝参数。
 */
export function extractVerifiedMiniAppHeaderInitData(
  headers: Headers
): string | Readonly<AccessErrorResponseParams> | null {
  const rawInitHeader: string | null = headers.get(MINI_APP_INIT_DATA_HEADER);
  const trimmedInitHeader: string = rawInitHeader !== null ? rawInitHeader.trim() : "";
  const rawAuthHeader: string | null = headers.get("authorization");
  let trimmedAuthInitData: string = "";

  if (rawAuthHeader !== null && rawAuthHeader.trim().length > 0) {
    const trimmedAuth: string = rawAuthHeader.trim();
    if (!trimmedAuth.toLowerCase().startsWith(MINI_APP_TMA_AUTH_PREFIX)) {
      return {
        status: 401,
        code: "MISSING_INIT_DATA",
        reason: "missing_init_data",
        error: "MISSING_INIT_DATA",
      };
    }
    trimmedAuthInitData = trimmedAuth.slice(MINI_APP_TMA_AUTH_PREFIX.length).trim();
  }

  if (
    trimmedInitHeader.length > 0 &&
    trimmedAuthInitData.length > 0 &&
    trimmedInitHeader !== trimmedAuthInitData
  ) {
    return {
      status: 401,
      code: "INVALID_SIGNATURE",
      reason: "invalid_signature",
      error: "INVALID_SIGNATURE",
    };
  }

  const headerInitData: string =
    trimmedInitHeader.length > 0 ? trimmedInitHeader : trimmedAuthInitData;
  if (headerInitData.length === 0) {
    return null;
  }
  if (
    headerInitData.length > MINI_APP_MAX_INIT_DATA_LENGTH ||
    MINI_APP_CONTROL_CHARS_PATTERN.test(headerInitData) ||
    !headerInitData.includes("hash=") ||
    !headerInitData.includes("auth_date=")
  ) {
    return {
      status: 401,
      code: "MALFORMED_INIT_DATA",
      reason: "malformed_init_data",
      error: "MALFORMED_INIT_DATA",
    };
  }
  return headerInitData;
}

/**
 * 在鉴权链最开头对请求头与凭据载体形态执行 O(1) 快路径严格校验：拦截非同源 `Sec-Fetch-Site`、
 * 直接导航/非预期 `Sec-Fetch-Mode` 与 `Sec-Fetch-Dest`、跨源 `Origin`/`Referer`，
 * 以及缺失、双头不一致或畸形的 Telegram WebApp `initData` 请求头。
 * @param ctx 路由请求上下文。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取凭据。
 * @returns 快路径拦截命中时返回 `401` 或 `403` 诊断响应，通过时返回 `null`。
 */
function verifyMiniAppRequestHeadersFast(
  ctx: Readonly<MiniAppRouteContext>,
  allowQueryAuth: boolean
): Response | null {
  const request: Request = ctx.request;
  const headers: Headers = request.headers;

  if (hasDisallowedSecFetchSite(headers)) {
    return accessErrorResponse(request, {
      status: 403,
      code: "CROSS_SITE_FORBIDDEN",
      reason: "forbidden_user",
      error: "CROSS_SITE_FORBIDDEN",
    });
  }

  const secFetchMode: string | null = headers.get("sec-fetch-mode")?.trim().toLowerCase() ?? null;
  const secFetchDest: string | null = headers.get("sec-fetch-dest")?.trim().toLowerCase() ?? null;
  if (!allowQueryAuth) {
    if (
      secFetchMode === "navigate" ||
      secFetchMode === "nested-navigate" ||
      secFetchMode === "websocket" ||
      (secFetchDest !== null && secFetchDest.length > 0 && secFetchDest !== "empty")
    ) {
      return accessErrorResponse(request, {
        status: 403,
        code: "DIRECT_NAVIGATION_FORBIDDEN",
        reason: "forbidden_user",
        error: "DIRECT_NAVIGATION_FORBIDDEN",
      });
    }
    const accept: string | null = headers.get("accept")?.toLowerCase() ?? null;
    if (
      accept !== null &&
      accept.includes("text/html") &&
      !accept.includes("application/json")
    ) {
      return accessErrorResponse(request, {
        status: 403,
        code: "DIRECT_NAVIGATION_FORBIDDEN",
        reason: "forbidden_user",
        error: "DIRECT_NAVIGATION_FORBIDDEN",
      });
    }
  } else if (hasDisallowedSubresourceFetchMetadata(headers)) {
    return accessErrorResponse(request, {
      status: 403,
      code: "DIRECT_NAVIGATION_FORBIDDEN",
      reason: "forbidden_user",
      error: "DIRECT_NAVIGATION_FORBIDDEN",
    });
  }

  const originHeader: string | null = headers.get("origin");
  if (
    originHeader !== null &&
    originHeader.trim().length > 0 &&
    !isAllowedRequestOriginUrl(originHeader, request, ctx.url)
  ) {
    return accessErrorResponse(request, {
      status: 403,
      code: "CROSS_SITE_FORBIDDEN",
      reason: "forbidden_user",
      error: "CROSS_SITE_FORBIDDEN",
    });
  }

  const refererHeader: string | null = headers.get("referer");
  if (
    refererHeader !== null &&
    refererHeader.trim().length > 0 &&
    !isAllowedRequestOriginUrl(refererHeader, request, ctx.url)
  ) {
    return accessErrorResponse(request, {
      status: 403,
      code: "CROSS_SITE_FORBIDDEN",
      reason: "forbidden_user",
      error: "CROSS_SITE_FORBIDDEN",
    });
  }

  const headerInitCheck: string | Readonly<AccessErrorResponseParams> | null =
    extractVerifiedMiniAppHeaderInitData(headers);
  if (typeof headerInitCheck === "string") {
    return null;
  }
  if (headerInitCheck !== null) {
    return accessErrorResponse(request, headerInitCheck);
  }

  if (!allowQueryAuth) {
    return accessErrorResponse(request, {
      status: 401,
      code: "MISSING_INIT_DATA",
      reason: "missing_init_data",
      error: "MISSING_INIT_DATA",
    });
  }

  if (ctx.method === "GET" || ctx.method === "HEAD") {
    const queryInitData: string = ctx.url.searchParams.get("initData")?.trim() ?? "";
    if (
      queryInitData.length > 0 &&
      (queryInitData.length > MINI_APP_MAX_INIT_DATA_LENGTH ||
        MINI_APP_CONTROL_CHARS_PATTERN.test(queryInitData) ||
        !queryInitData.includes("hash=") ||
        !queryInitData.includes("auth_date="))
    ) {
      return accessErrorResponse(request, {
        status: 401,
        code: "MALFORMED_INIT_DATA",
        reason: "malformed_init_data",
        error: "MALFORMED_INIT_DATA",
      });
    }
  }

  return null;
}

/**
 * 创建位于每条受保护鉴权链最开头的请求头与凭据形态快路径拦截中间件。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取凭据。
 * @returns 构造好的 `MiniAppMiddleware`。
 */
export function createMiniAppHeaderGuardMiddleware(
  allowQueryAuth: boolean
): MiniAppMiddleware {
  return (
    ctx: Readonly<MiniAppRouteContext>,
    next: () => Response | Promise<Response>
  ): Response | Promise<Response> =>
    verifyMiniAppRequestHeadersFast(ctx, allowQueryAuth) ?? next();
}
