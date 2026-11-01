import { miniAppServerHolder } from "../../cache/main/miniApp";
import type { MiniAppRouteContext } from "../../types/miniApp";
import {
  handleGetFaviconRoute,
  handleHealthzRoute,
  readBundledMiniAppIndex,
  serveMiniAppIndexHtml,
} from "../handlers/page";
import type { BundledMiniAppIndex } from "../handlers/page";

/**
 * 构建公开页面路由（`/healthz`、`/_bundle`、`/`、`/index.html`、`/favicon.ico`）的 `Bun.serve` 原生路由表片段；
 * 公开路由无需鉴权中间件，直接挂载处理函数；`/_bundle` 直接挂载前端 HTML import，供 `readBundledMiniAppIndex` 读取注入打包产物路径后的入口 HTML 与资源集合。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 公开页面路由表片段。
 */
export function createPageBunRoutes(
  indexHtml: Bun.HTMLBundle
): Bun.Serve.Routes<undefined, string> {
  const indexRoute: Partial<Record<Bun.Serve.HTTPMethod, () => Promise<Response>>> = {
    GET: (): Promise<Response> => serveMiniAppIndexHtml(indexHtml, false),
    HEAD: (): Promise<Response> => serveMiniAppIndexHtml(indexHtml, true),
  };
  return {
    "/healthz": {
      GET: (): Response => handleHealthzRoute(false),
      HEAD: (): Response => handleHealthzRoute(true),
    },
    "/_bundle": indexHtml,
    "/": indexRoute,
    "/index.html": indexRoute,
    "/favicon.ico": { GET: handleGetFaviconRoute, HEAD: handleGetFaviconRoute },
  };
}

/**
 * 在兜底分发中匹配 `/_bundle` 入口 HTML 所引用的本地打包产物路径（如 `/chunk-*.js`、`/chunk-*.css`、`/favicon-*.ico`），
 * 仅在请求携带 `mini_app.url` 子路径前缀（`ctx.routePath !== ctx.url.pathname`）时回环读取 `Bun.serve` 原生静态资源并透传 `If-None-Match`；
 * 根路径或已由反向代理剥离前缀的请求直接由 `Bun.serve` 原生静态路由命中，`/api/` 下的业务路径不属于打包产物，均直接返回 `null`。
 * @param ctx 路由请求上下文。
 * @returns 命中打包产物路径时返回响应，未命中或服务未启动时返回 `null`。
 */
export async function dispatchBundleAssetRoute(
  ctx: Readonly<MiniAppRouteContext>
): Promise<Response | null> {
  const { method, routePath, url, request }: Readonly<MiniAppRouteContext> = ctx;
  if (
    routePath === url.pathname ||
    (method !== "GET" && method !== "HEAD") ||
    routePath.startsWith("/api/")
  ) {
    return null;
  }
  const activeServer: ReturnType<typeof Bun.serve> | null = miniAppServerHolder.current;
  if (activeServer === null) return null;
  const bundled: Readonly<BundledMiniAppIndex> | null = await readBundledMiniAppIndex();
  if (!bundled?.assetPaths.has(routePath)) return null;
  const assetUrl: URL = new URL(routePath, activeServer.url);
  const ifNoneMatch: string | null = request.headers.get("if-none-match");
  return fetch(assetUrl, {
    method,
    headers: ifNoneMatch !== null ? { "If-None-Match": ifNoneMatch } : undefined,
  });
}
