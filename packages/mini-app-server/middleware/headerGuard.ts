import { miniAppActiveConfigHolder } from "../../cache/main/miniApp";
import { getBotMiniAppConfig } from "../../config/bot";
import {
  MINI_APP_BLOCKED_USER_AGENT_PATTERN,
  MINI_APP_CONTROL_CHARS_PATTERN,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_MAX_INIT_DATA_LENGTH,
  MINI_APP_TMA_AUTH_PREFIX,
} from "../../consts/miniApp";
import type { BotMiniAppConfig } from "../../types/config";
import type { MiniAppMiddleware, MiniAppRouteContext } from "../../types/miniApp";
import { accessErrorResponse } from "../libs/response";

/**
 * 校验请求头中的 `Origin` 或 `Referer` URL 是否与当前 Mini App 源站或反向代理 Host 同源。
 * @param rawUrl 待核验的 `Origin` 或 `Referer` 原始头值。
 * @param request HTTP 请求对象。
 * @returns 同源合法时返回 `true`，伪造或跨源时返回 `false`。
 */
function isAllowedRequestOriginUrl(rawUrl: string, request: Request): boolean {
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
  const rawForwardedHost: string | null = request.headers.get("x-forwarded-host");
  if (rawForwardedHost !== null) {
    const commaIndex: number = rawForwardedHost.indexOf(",");
    const firstForwardedHost: string = (
      commaIndex >= 0 ? rawForwardedHost.slice(0, commaIndex) : rawForwardedHost
    )
      .trim()
      .toLowerCase();
    if (firstForwardedHost.length > 0 && candidateHost === firstForwardedHost) {
      return true;
    }
  }
  const hostHeader: string = request.headers.get("host")?.trim().toLowerCase() ?? "";
  if (hostHeader.length > 0 && candidateHost === hostHeader) {
    return true;
  }
  const reqUrlHost: string = URL.parse(request.url)?.host.toLowerCase() ?? "";
  if (reqUrlHost.length > 0 && candidateHost === reqUrlHost) {
    return true;
  }
  const activeConfig: Readonly<BotMiniAppConfig> | undefined =
    miniAppActiveConfigHolder.current ?? getBotMiniAppConfig();
  if (activeConfig !== undefined) {
    const configHost: string = URL.parse(activeConfig.url)?.host.toLowerCase() ?? "";
    if (configHost.length > 0 && candidateHost === configHost) {
      return true;
    }
  }
  return false;
}

/**
 * 在鉴权链最开头对请求头与凭据载体形态执行 O(1) 快路径严格校验：拦截非同源 `Sec-Fetch-Site`、
 * 直接导航/非預期 `Sec-Fetch-Mode` 与 `Sec-Fetch-Dest`、跨源 `Origin`/`Referer`、自动化扫描器 `User-Agent`，
 * 以及缺失、双头不一致或畸形的 Telegram WebApp `initData` 请求头。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取凭据。
 * @returns 快路径拦截命中时返回 `401` 或 `403` 诊断响应，通过时返回 `null`。
 */
function verifyMiniAppRequestHeadersFast(
  request: Request,
  allowQueryAuth: boolean
): Response | null {
  const headers: Headers = request.headers;

  const secFetchSite: string | null = headers.get("sec-fetch-site")?.trim().toLowerCase() ?? null;
  if (
    secFetchSite !== null &&
    secFetchSite.length > 0 &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "same-site" &&
    secFetchSite !== "none"
  ) {
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
  } else if (
    secFetchMode === "navigate" ||
    secFetchMode === "nested-navigate" ||
    secFetchDest === "document" ||
    secFetchDest === "iframe" ||
    secFetchDest === "frame" ||
    secFetchDest === "object" ||
    secFetchDest === "embed"
  ) {
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
    !isAllowedRequestOriginUrl(originHeader, request)
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
    !isAllowedRequestOriginUrl(refererHeader, request)
  ) {
    return accessErrorResponse(request, {
      status: 403,
      code: "CROSS_SITE_FORBIDDEN",
      reason: "forbidden_user",
      error: "CROSS_SITE_FORBIDDEN",
    });
  }

  const userAgent: string | null = headers.get("user-agent")?.trim() ?? null;
  if (
    userAgent !== null &&
    userAgent.length > 0 &&
    (MINI_APP_CONTROL_CHARS_PATTERN.test(userAgent) ||
      MINI_APP_BLOCKED_USER_AGENT_PATTERN.test(userAgent))
  ) {
    return accessErrorResponse(request, {
      status: 403,
      code: "FORBIDDEN_USER",
      reason: "forbidden_user",
      error: "FORBIDDEN_USER",
    });
  }

  const rawInitHeader: string | null = headers.get(MINI_APP_INIT_DATA_HEADER);
  const trimmedInitHeader: string = rawInitHeader !== null ? rawInitHeader.trim() : "";
  const rawAuthHeader: string | null = headers.get("authorization");
  let trimmedAuthInitData: string = "";

  if (rawAuthHeader !== null && rawAuthHeader.trim().length > 0) {
    const trimmedAuth: string = rawAuthHeader.trim();
    if (!trimmedAuth.toLowerCase().startsWith(MINI_APP_TMA_AUTH_PREFIX)) {
      return accessErrorResponse(request, {
        status: 401,
        code: "MISSING_INIT_DATA",
        reason: "missing_init_data",
        error: "MISSING_INIT_DATA",
      });
    }
    trimmedAuthInitData = trimmedAuth.slice(MINI_APP_TMA_AUTH_PREFIX.length).trim();
  }

  if (
    trimmedInitHeader.length > 0 &&
    trimmedAuthInitData.length > 0 &&
    trimmedInitHeader !== trimmedAuthInitData
  ) {
    return accessErrorResponse(request, {
      status: 401,
      code: "INVALID_SIGNATURE",
      reason: "invalid_signature",
      error: "INVALID_SIGNATURE",
    });
  }

  const headerInitData: string =
    trimmedInitHeader.length > 0 ? trimmedInitHeader : trimmedAuthInitData;
  if (headerInitData.length > 0) {
    if (
      headerInitData.length > MINI_APP_MAX_INIT_DATA_LENGTH ||
      MINI_APP_CONTROL_CHARS_PATTERN.test(headerInitData) ||
      !headerInitData.includes("hash=") ||
      !headerInitData.includes("auth_date=")
    ) {
      return accessErrorResponse(request, {
        status: 401,
        code: "MALFORMED_INIT_DATA",
        reason: "malformed_init_data",
        error: "MALFORMED_INIT_DATA",
      });
    }
    return null;
  }

  if (!allowQueryAuth) {
    return accessErrorResponse(request, {
      status: 401,
      code: "MISSING_INIT_DATA",
      reason: "missing_init_data",
      error: "MISSING_INIT_DATA",
    });
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
    verifyMiniAppRequestHeadersFast(ctx.request, allowQueryAuth) ?? next();
}
