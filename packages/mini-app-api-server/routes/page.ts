import { MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN } from "../../consts/miniApp";
import type {
  BundledMiniAppAsset,
  BundledMiniAppAssets,
  MiniAppRouteContext,
} from "../../types/miniApp/server";
import { authorizeMiniAppBundleAssetRequest } from "../auth/pageGate";
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

/**
 * 构建页面与基础路由（`/healthz`、`/`、`/index.html`、`/favicon.ico`）的 `Bun.serve` 原生路由表片段。
 * 页面入口只挂载门禁函数处理器而不直接挂载 `HTMLBundle`，前端打包块统一交由 `dispatchBundleAssetRoute` 验明门禁后分发。
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
 * 分发根路径或 `${basePath}` 子路径下的前端打包静态资源请求（如 `/chunk-*.js`、`/chunk-*.css`、`/favicon-*.ico`）：
 * 1. 核验跨站/直接导航请求头与超级管理员门禁凭据，未通过时返回 `401`/`403` JSON；
 * 2. 物化并查找打包产物：命中时以私有协商缓存头返回（支持 `If-None-Match` `304` 与 `HEAD`），物化失败返回 `500`，未命中产物表返回 `null` 交由后续受保护资源或 404 分支处理。
 * @param ctx 路由请求上下文。
 * @param routePath 归一化后的内部路由路径。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 命中打包产物、物化失败或触发门禁拦截时返回 `Response`，否则返回 `null`。
 */
export async function dispatchBundleAssetRoute(
  ctx: Readonly<MiniAppRouteContext>,
  routePath: string,
  indexHtml: Bun.HTMLBundle
): Promise<Response | null> {
  const { method, request }: Readonly<MiniAppRouteContext> = ctx;
  if (
    (method !== "GET" && method !== "HEAD") ||
    routePath === "/favicon.ico" ||
    routePath.startsWith("/api/") ||
    !MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN.test(routePath)
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
