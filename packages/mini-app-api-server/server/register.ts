import {
  MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN,
  MINI_APP_GALLERY_FILE_ROUTE_PATTERN,
  MINI_APP_PROTECTED_ASSET_EXT_PATTERN,
} from "../../consts/miniApp";
import type { MiniAppRouteContext } from "../../types/miniApp";
import { buildNoStoreHeaders, jsonResponse } from "../libs/response";
import { configuredBasePathname, normalizeRoutePathname } from "../libs/routePath";
import type { NormalizedRoutePath } from "../libs/routePath";
import {
  MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
  MINI_APP_PROTECTED_ASSET_MIDDLEWARE_CHAIN,
} from "../middleware/chains";
import { executeMiniAppMiddlewareChain } from "../middleware/pipeline";
import { createAuthBunRoutes } from "../routes/auth";
import { createChatsBunRoutes } from "../routes/chats";
import { createGalleryBunRoutes } from "../routes/gallery";
import { createIdentitiesBunRoutes } from "../routes/identities";
import { createPageBunRoutes, dispatchBundleAssetRoute } from "../routes/page";
import { createStatusBunRoutes } from "../routes/status";
import { createTotpBunRoutes } from "../routes/totp";
import indexHtml from "../../mini-app-frontend/index.html";

/**
 * 合并各领域路由表片段（`routes/` 目录）为传给 `Bun.serve({ routes })` 的原生路由表；
 * 当 `mini_app.url` 配置了子路径前缀（`basePath !== "/"`）时，为除 `/_bundle` 外的每条路由同步注册 `${basePath}` 前缀别名（`/` 对应 `${basePath}/`），同时覆盖反向代理保留前缀与剥离前缀两种转发模式。
 * @returns `Bun.serve` 原生路由定义对象。
 */
export function createMiniAppBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const baseRoutes: Bun.Serve.Routes<undefined, string> = {
    ...createPageBunRoutes(indexHtml),
    ...createAuthBunRoutes(),
    ...createTotpBunRoutes(),
    ...createStatusBunRoutes(),
    ...createChatsBunRoutes(),
    ...createIdentitiesBunRoutes(),
    ...createGalleryBunRoutes(),
  };
  const basePath: string = configuredBasePathname();
  if (basePath === "/") return baseRoutes;

  const routes: Bun.Serve.Routes<undefined, string> = { ...baseRoutes };
  for (const [routeKey, routeValue] of Object.entries(baseRoutes)) {
    if (routeKey === "/_bundle" || routeValue === undefined) continue;
    const prefixedKey: string = routeKey === "/" ? `${basePath}/` : `${basePath}${routeKey}`;
    routes[prefixedKey] = routeValue;
  }
  return routes;
}

/**
 * 判断归一化后的内部路由路径是否属于受保护的图库图片或图片后缀路径（排除走完整双层 API 鉴权的 `/api/gallery/download/:fileName`）。
 * @param routePath 归一化后的内部路由路径。
 * @returns 命中受保护图片路径时返回 `true`。
 */
function isProtectedMiniAppAssetPath(routePath: string): boolean {
  if (MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN.test(routePath)) {
    return false;
  }
  return (
    MINI_APP_GALLERY_FILE_ROUTE_PATTERN.test(routePath) ||
    MINI_APP_PROTECTED_ASSET_EXT_PATTERN.test(routePath)
  );
}

/**
 * 处理未命中 `Bun.serve` 原生路由表的请求（子路径末尾斜杠重定向、携带子路径前缀的本地打包静态资源、方法不匹配或未知路径），按以下顺序兜底：
 * `${basePath}` 的 `308` 补斜杠 → 子路径打包静态资源回环读取 → 受保护图片后缀路径经受保护资源鉴权链后返回 404 → 非 `/api/` 未知路径返回 404 → `/api/` 下未知路径或方法不匹配经完整双层业务 API 鉴权链后返回 404。
 * @param request 传入的 HTTP `Request`。
 * @returns 完整的 HTTP `Response`。
 */
export async function handleMiniAppHttpRequest(request: Request): Promise<Response> {
  const url: URL = new URL(request.url);
  const method: string = request.method.toUpperCase();
  const normalized: NormalizedRoutePath = normalizeRoutePathname(url.pathname);

  if (normalized.redirectTo !== undefined && (method === "GET" || method === "HEAD")) {
    const headers: Record<string, string> = buildNoStoreHeaders();
    headers.Location = `${normalized.redirectTo}${url.search}`;
    return new Response(null, {
      status: 308,
      headers,
    });
  }

  const routePath: string = normalized.routePath;
  const ctx: Readonly<MiniAppRouteContext> = {
    request,
    url,
    method,
    routePath,
    params: {},
  };

  const bundleAssetResponse: Response | null = await dispatchBundleAssetRoute(ctx);
  if (bundleAssetResponse !== null) return bundleAssetResponse;

  if (method !== "DELETE" && isProtectedMiniAppAssetPath(routePath)) {
    return executeMiniAppMiddlewareChain(
      ctx,
      MINI_APP_PROTECTED_ASSET_MIDDLEWARE_CHAIN,
      (): Response => jsonResponse({ error: "Resource not found" }, 404)
    );
  }

  if (!routePath.startsWith("/api/")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  return executeMiniAppMiddlewareChain(
    ctx,
    MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
    (): Response => jsonResponse({ error: "API route not found" }, 404)
  );
}
