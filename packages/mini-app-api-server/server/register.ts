import {
  MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN,
  MINI_APP_GALLERY_FILE_ROUTE_PATTERN,
  MINI_APP_PROTECTED_ASSET_EXT_PATTERN,
} from "../../consts/miniApp";
import type { MiniAppRouteContext, MiniAppRouteMatch } from "../../types/miniApp";
import { buildNoStoreHeaders, jsonResponse } from "../libs/response";
import { normalizeRoutePathname } from "../libs/routePath";
import type { NormalizedRoutePath } from "../libs/routePath";
import {
  getMiniAppApiAuthMiddlewareChain,
  getMiniAppProtectedAssetMiddlewareChain,
} from "../middleware/chains";
import { executeMiniAppMiddlewareChain } from "../middleware/pipeline";
import { createAuthBunRoutes, dispatchAuthRoute } from "../routes/auth";
import { createChatsBunRoutes, dispatchChatsApiRoute } from "../routes/chats";
import {
  createGalleryBunRoutes,
  dispatchGalleryApiRoute,
  dispatchGalleryDownloadRoute,
  dispatchGalleryFileRoute,
} from "../routes/gallery";
import { createIdentitiesBunRoutes, dispatchIdentitiesApiRoute } from "../routes/identities";
import { createPageBunRoutes, dispatchBundleAssetRoute, dispatchPageRoute } from "../routes/page";
import { createStatusBunRoutes, dispatchStatusApiRoute } from "../routes/status";
import { createTotpBunRoutes, dispatchTotpApiRoute } from "../routes/totp";
import indexHtml from "../../mini-app-frontend/index.html";

/**
 * 合并各领域路由表片段（`routes/` 目录）为传给 `Bun.serve({ routes })` 的原生路由表；所有业务 API 与资源路由均由前置中间件链包装。
 * @returns `Bun.serve` 原生路由定义对象。
 */
export function createMiniAppBunRoutes(): Bun.Serve.Routes<undefined, string> {
  return {
    ...createPageBunRoutes(indexHtml),
    ...createAuthBunRoutes(),
    ...createTotpBunRoutes(),
    ...createStatusBunRoutes(),
    ...createChatsBunRoutes(),
    ...createIdentitiesBunRoutes(),
    ...createGalleryBunRoutes(),
  };
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
 * 处理未命中原生路由表的请求（`mini_app.url` 子路径前缀、方法不匹配或未知路径），按以下顺序兜底分发：
 * 公开页面 → 打包入口静态资源 → 预检与登录 → 图库附件下载 → 受保护图库图片资源 → 业务 API（状态与情绪、TOTP、图库、受管群、名单与选择器）；
 * 每类均经与原生路由表相同的前置中间件链（跨站拦截、浏览器直接导航拦截、Telegram WebApp 超管签名与会话校验）。
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

  const preApiResponse: MiniAppRouteMatch =
    dispatchPageRoute(ctx, indexHtml) ??
    (await dispatchBundleAssetRoute(ctx)) ??
    dispatchAuthRoute(ctx) ??
    dispatchGalleryDownloadRoute(ctx);
  if (preApiResponse !== null) return preApiResponse;

  if (method !== "DELETE" && isProtectedMiniAppAssetPath(routePath)) {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppProtectedAssetMiddlewareChain(),
      (routeCtx: Readonly<MiniAppRouteContext>): Response | Promise<Response> =>
        dispatchGalleryFileRoute(routeCtx) ??
        jsonResponse({ error: "Resource not found" }, 404)
    );
  }

  if (!routePath.startsWith("/api/")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  return executeMiniAppMiddlewareChain(
    ctx,
    getMiniAppApiAuthMiddlewareChain(),
    (routeCtx: Readonly<MiniAppRouteContext>): Response | Promise<Response> =>
      dispatchStatusApiRoute(routeCtx) ??
      dispatchTotpApiRoute(routeCtx) ??
      dispatchGalleryApiRoute(routeCtx) ??
      dispatchChatsApiRoute(routeCtx) ??
      dispatchIdentitiesApiRoute(routeCtx) ??
      jsonResponse({ error: "API route not found" }, 404)
  );
}
