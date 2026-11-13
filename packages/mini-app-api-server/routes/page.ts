import {
  MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN,
  MINI_APP_PROTECTED_ASSET_EXT_PATTERN,
} from "../../consts/miniApp";
import type {
  BundledMiniAppAsset,
  BundledMiniAppAssets,
  MiniAppRouteContext,
} from "../../types/miniApp/server";
import {
  authorizeMiniAppBundleAssetRequest,
  hasValidMiniAppPageGateCookie,
} from "../auth/pageGate";
import {
  handleGetFaviconRoute,
  handleGetMiniAppPageRoute,
  handleHealthzRoute,
  materializeBundledMiniAppAssets,
} from "../handlers/page";
import {
  buildNoStoreHeaders,
  jsonResponse,
  serveBundledAssetResponse,
} from "../libs/response";
import { hasMiniAppInitDataHeader } from "../middleware/initData";

/**
 * 构建页面与基础路由（`/healthz`、`/`、`/index.html`、`/favicon.ico`）的 `Bun.serve` 原生路由表片段；
 * 不向 `Bun.serve` 挂载 `HTMLBundle`，彻底避免暴露未鉴权的 `/_bundle` 与自动注册的 `/chunk-*` 静态路由。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 页面与基础路由表片段。
 */
export function createPageBunRoutes(
  indexHtml: Bun.HTMLBundle
): Bun.Serve.Routes<undefined, string> {
  const indexRoute: Partial<Record<Bun.Serve.HTTPMethod, (request: Request) => Promise<Response>>> = {
    GET: (request: Request): Promise<Response> =>
      handleGetMiniAppPageRoute(request, indexHtml, false),
    HEAD: (request: Request): Promise<Response> =>
      handleGetMiniAppPageRoute(request, indexHtml, true),
  };
  return {
    "/healthz": {
      GET: (): Response => handleHealthzRoute(false),
      HEAD: (): Response => handleHealthzRoute(true),
    },
    "/": indexRoute,
    "/index.html": indexRoute,
    "/favicon.ico": { GET: handleGetFaviconRoute, HEAD: handleGetFaviconRoute },
  };
}

/**
 * 在兜底分发中同时处理根路径与 `${basePath}` 子路径下的前端打包静态资源请求（如 `/chunk-*.js`、`/chunk-*.css`、`/favicon-*.ico`）：
 * 先拦截跨站与直接导航并强制核验超级管理员门禁 Cookie 或 `initData` 请求头（及未锁定状态），未授权一律返回 `401`/`403` JSON；
 * 鉴权通过且命中已物化的打包产物表时以私有协商缓存头返回（支持 `If-None-Match` `304` 与 `HEAD`），物化失败返回 `500`，未命中打包产物表时返回 `null` 交由后续 404 分支处理。
 * @param ctx 路由请求上下文。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 命中打包产物路径、物化失败或触发门禁拦截时返回响应，否则返回 `null`。
 */
export async function dispatchBundleAssetRoute(
  ctx: Readonly<MiniAppRouteContext>,
  indexHtml: Bun.HTMLBundle
): Promise<Response | null> {
  const { method, routePath, url, request }: Readonly<MiniAppRouteContext> = ctx;
  if (
    (method !== "GET" && method !== "HEAD") ||
    routePath === "/favicon.ico" ||
    routePath.startsWith("/api/") ||
    !MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN.test(routePath)
  ) {
    return null;
  }
  if (
    url.search.length > 1 &&
    MINI_APP_PROTECTED_ASSET_EXT_PATTERN.test(routePath) &&
    (url.searchParams.has("token") || url.searchParams.has("initData")) &&
    !hasMiniAppInitDataHeader(request.headers) &&
    !hasValidMiniAppPageGateCookie(request)
  ) {
    return null;
  }

  const authError: Response | null = authorizeMiniAppBundleAssetRequest(ctx);
  if (authError !== null) {
    return authError;
  }

  const bundled: Readonly<BundledMiniAppAssets> | null =
    await materializeBundledMiniAppAssets(indexHtml);
  if (bundled === null) {
    return method === "HEAD"
      ? new Response(null, { status: 500, headers: buildNoStoreHeaders() })
      : jsonResponse({ error: "Internal server error" }, 500);
  }
  const asset: Readonly<BundledMiniAppAsset> | undefined =
    bundled.assets.get(routePath);
  if (asset === undefined) {
    return null;
  }
  return serveBundledAssetResponse(request, asset);
}
