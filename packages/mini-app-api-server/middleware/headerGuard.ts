import { miniAppActiveUrlPartsHolder } from "../../cache/main/miniApp";
import { getBotMiniAppConfig } from "../../config/bot";
import {
  MINI_APP_CONTROL_CHARS_PATTERN,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_MAX_INIT_DATA_LENGTH,
  MINI_APP_TMA_AUTH_PREFIX,
} from "../../consts/miniApp";
import type { MiniAppRouteContext } from "../../types/miniApp/server";
import { accessErrorResponse } from "../libs/response";
import type { AccessErrorResponseParams } from "../libs/response";
import { deriveMiniAppPublicUrlParts } from "../libs/routePath";

/**
 * 判断主机名是否为本机回环地址（仅本机回环监听器允许按 `request.url` 匹配 `Origin`/`Referer`）。
 * @param hostname 小写主机名。
 * @returns 为 `127.0.0.1`、`localhost` 或 `[::1]` 时返回 `true`。
 */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]"
  );
}

/**
 * 校验请求头中的 `Origin` 或 `Referer` URL 是否与已配置的 Mini App HTTPS 公网源站完整同源（或在直连本机回环时与回环 `request.url` 的协议及主机完整同源）。
 * 安全约束：匹配配置源站固定要求 `https:`，回环匹配严格比对 `request.url` 协议，绝不信任未认证的 `X-Forwarded-Proto`、`X-Forwarded-Host` 或 `Host` 请求头作为跨源放行依据。
 * @param rawUrl 待核验的 `Origin` 或 `Referer` 原始头值。
 * @param request HTTP 请求对象。
 * @param parsedRequestUrl 调用方已解析好的请求 `URL`（缺省时按需以 `URL.parse` 解析 `request.url`）。
 * @returns 同源合法时返回 `true`，伪造、协议降级或跨源时返回 `false`。
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
  const candidateOrigin: string = `${parsedOrigin.protocol}//${parsedOrigin.host.toLowerCase()}`;
  const configOrigin: string = (
    miniAppActiveUrlPartsHolder.current ??
    deriveMiniAppPublicUrlParts(getBotMiniAppConfig())
  ).origin;
  if (configOrigin.length > 0 && candidateOrigin === configOrigin) {
    return true;
  }
  const parsedReq: URL | null = parsedRequestUrl ?? URL.parse(request.url);
  if (
    parsedReq !== null &&
    (parsedReq.protocol === "http:" || parsedReq.protocol === "https:") &&
    isLoopbackHostname(parsedReq.hostname.toLowerCase()) &&
    candidateOrigin === `${parsedReq.protocol}//${parsedReq.host.toLowerCase()}`
  ) {
    return true;
  }
  return false;
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
 * 提取并做基础形态校验的请求头凭据（`X-Telegram-Init-Data` 与 `Authorization: tma <initData>`）：
 * - 两个请求头均缺省或全空白时返回 `null`；
 * - 形态合法且未超长、不含控制字符、具备 `hash=` 与 `auth_date=` 时返回去空白后的 `initData`；
 * - 认证方案非 `tma`、双头内容不一致或字符串畸形时返回对应的拒绝参数。
 * @param headers HTTP 请求头对象。
 * @returns 通过基础校验的 `initData`、双头均缺省时的 `null`，或拒绝参数。
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

/** 网关请求头与凭据形态快路径校验结果（仅接收请求头中的 `initData`）。 */
export type MiniAppHeaderGuardResult =
  | {
    readonly ok: true;
    readonly headerInitData: string;
  }
  | { readonly ok: false; readonly response: Response };

/**
 * 校验跨站请求头与 `Origin`/`Referer` 同源边界（供 API 快路径与一次性下载票据路径复用）。
 * @param ctx 路由请求上下文。
 * @returns 拦截命中时返回 `403 CROSS_SITE_FORBIDDEN` 响应，通过时返回 `null`。
 */
function verifySameOriginRequestHeaders(
  ctx: Readonly<MiniAppRouteContext>
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
  return null;
}

/**
 * 对携带 60 秒一次性下载票据的 `GET`/`HEAD` 下载请求执行跨站与跨源请求头前置校验；
 * 允许 Telegram 原生 `WebApp.downloadFile` 宿主发起的文件下载请求不带 `initData` 与自定义会话请求头，同时严防跨站触发。
 * @param ctx 路由请求上下文。
 * @returns 校验通过返回 `null`，跨站或跨源时返回 `403` 响应。
 */
export function verifyMiniAppDownloadTicketHeaders(
  ctx: Readonly<MiniAppRouteContext>
): Response | null {
  const crossSiteResponse: Response | null = verifySameOriginRequestHeaders(ctx);
  if (crossSiteResponse !== null) {
    return crossSiteResponse;
  }
  if (hasDisallowedSubresourceFetchMetadata(ctx.request.headers)) {
    return accessErrorResponse(ctx.request, {
      status: 403,
      code: "DIRECT_NAVIGATION_FORBIDDEN",
      reason: "forbidden_user",
      error: "DIRECT_NAVIGATION_FORBIDDEN",
    });
  }
  return null;
}

/**
 * 在鉴权管道入口对 API 请求头与 `initData` 凭据形态做同步前置校验：
 * 1. 拦截跨站 `Sec-Fetch-Site`、直接导航或非预期容器的 `Sec-Fetch-Mode`/`Sec-Fetch-Dest`/`Accept`，以及跨源 `Origin`/`Referer`；
 * 2. 强制要求请求头携带形态合法的 `X-Telegram-Init-Data` 或 `Authorization: tma <initData>`，禁止从查询参数回退读取 `initData`。
 * @param ctx 路由请求上下文。
 * @returns 拦截命中时返回 `401` 或 `403` 诊断响应；通过时返回提取出的 `headerInitData`。
 */
export function verifyMiniAppRequestHeadersFast(
  ctx: Readonly<MiniAppRouteContext>
): MiniAppHeaderGuardResult {
  const request: Request = ctx.request;
  const headers: Headers = request.headers;

  const crossSiteResponse: Response | null = verifySameOriginRequestHeaders(ctx);
  if (crossSiteResponse !== null) {
    return { ok: false, response: crossSiteResponse };
  }

  const secFetchMode: string | null = headers.get("sec-fetch-mode")?.trim().toLowerCase() ?? null;
  const secFetchDest: string | null = headers.get("sec-fetch-dest")?.trim().toLowerCase() ?? null;
  if (
    secFetchMode === "navigate" ||
    secFetchMode === "nested-navigate" ||
    secFetchMode === "websocket" ||
    (secFetchDest !== null && secFetchDest.length > 0 && secFetchDest !== "empty")
  ) {
    return {
      ok: false,
      response: accessErrorResponse(request, {
        status: 403,
        code: "DIRECT_NAVIGATION_FORBIDDEN",
        reason: "forbidden_user",
        error: "DIRECT_NAVIGATION_FORBIDDEN",
      }),
    };
  }
  const accept: string | null = headers.get("accept")?.toLowerCase() ?? null;
  if (
    accept !== null &&
    accept.includes("text/html") &&
    !accept.includes("application/json")
  ) {
    return {
      ok: false,
      response: accessErrorResponse(request, {
        status: 403,
        code: "DIRECT_NAVIGATION_FORBIDDEN",
        reason: "forbidden_user",
        error: "DIRECT_NAVIGATION_FORBIDDEN",
      }),
    };
  }

  const headerInitCheck: string | Readonly<AccessErrorResponseParams> | null =
    extractVerifiedMiniAppHeaderInitData(headers);
  if (typeof headerInitCheck === "string") {
    return { ok: true, headerInitData: headerInitCheck };
  }
  if (headerInitCheck !== null) {
    return {
      ok: false,
      response: accessErrorResponse(request, headerInitCheck),
    };
  }

  return {
    ok: false,
    response: accessErrorResponse(request, {
      status: 401,
      code: "MISSING_INIT_DATA",
      reason: "missing_init_data",
      error: "MISSING_INIT_DATA",
    }),
  };
}
