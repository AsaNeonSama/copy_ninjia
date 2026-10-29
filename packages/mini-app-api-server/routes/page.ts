import { miniAppServerHolder } from "../../cache/main/miniApp";
import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteMatch,
} from "../../types/miniApp";
import {
  handleGetFaviconRoute,
  handleHealthzRoute,
  readBundledMiniAppIndex,
  serveMiniAppIndexHtml,
} from "../handlers/page";
import type { BundledMiniAppIndex } from "../handlers/page";
import { getMiniAppPublicMiddlewareChain } from "../middleware/chains";
import { executeMiniAppMiddlewareChain, withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建公开页面路由（`/healthz`、`/_bundle`、`/`、`/index.html`、`/favicon.ico`）的 `Bun.serve` 原生路由表片段；
 * `/_bundle` 直接挂载前端 HTML import，供 `readBundledMiniAppIndex` 读取注入打包产物路径后的入口 HTML 与资源集合。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 公开页面路由表片段。
 */
export function createPageBunRoutes(
  indexHtml: Bun.HTMLBundle
): Bun.Serve.Routes<undefined, string> {
  const publicChain: readonly MiniAppMiddleware[] = getMiniAppPublicMiddlewareChain();
  const indexRoute: Partial<Record<Bun.Serve.HTTPMethod, (request: Request) => Promise<Response>>> = {
    GET: withMiniAppMiddlewareChain(
      publicChain,
      (): Promise<Response> => serveMiniAppIndexHtml(indexHtml, false)
    ),
    HEAD: withMiniAppMiddlewareChain(
      publicChain,
      (): Promise<Response> => serveMiniAppIndexHtml(indexHtml, true)
    ),
  };
  const faviconHandler: (request: Request) => Promise<Response> = withMiniAppMiddlewareChain(
    publicChain,
    (ctx: Readonly<MiniAppRouteContext>): Response => handleGetFaviconRoute(ctx.request)
  );
  return {
    "/healthz": {
      GET: withMiniAppMiddlewareChain(publicChain, (): Response => handleHealthzRoute(false)),
      HEAD: withMiniAppMiddlewareChain(publicChain, (): Response => handleHealthzRoute(true)),
    },
    "/_bundle": indexHtml,
    "/": indexRoute,
    "/index.html": indexRoute,
    "/favicon.ico": { GET: faviconHandler, HEAD: faviconHandler },
  };
}

/**
 * 在兜底分发中匹配公开页面路由（`GET|HEAD` 的 `/healthz`、`/`、`/index.html`、`/favicon.ico`），经公开中间件链执行。
 * @param ctx 路由请求上下文。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchPageRoute(
  ctx: Readonly<MiniAppRouteContext>,
  indexHtml: Bun.HTMLBundle
): MiniAppRouteMatch {
  const { method, routePath }: Readonly<MiniAppRouteContext> = ctx;
  if (method !== "GET" && method !== "HEAD") return null;
  if (routePath === "/healthz") {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppPublicMiddlewareChain(),
      (): Response => handleHealthzRoute(method === "HEAD")
    );
  }
  if (routePath === "/" || routePath === "/index.html") {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppPublicMiddlewareChain(),
      (): Promise<Response> => serveMiniAppIndexHtml(indexHtml, method === "HEAD")
    );
  }
  if (routePath === "/favicon.ico") {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppPublicMiddlewareChain(),
      (routeCtx: Readonly<MiniAppRouteContext>): Response =>
        handleGetFaviconRoute(routeCtx.request)
    );
  }
  return null;
}

/**
 * 在兜底分发中匹配 `/_bundle` 入口 HTML 所引用的本地打包产物路径（如 `/chunk-*.js`、`/chunk-*.css`、`/favicon-*.ico`），
 * 供 `mini_app.url` 带子路径前缀部署时经公开中间件链回环读取 `Bun.serve` 原生静态资源并透传 `If-None-Match`。
 * @param ctx 路由请求上下文。
 * @returns 命中打包产物路径时返回响应，未命中或服务未启动时返回 `null`。
 */
export async function dispatchBundleAssetRoute(
  ctx: Readonly<MiniAppRouteContext>
): Promise<Response | null> {
  const { method, routePath }: Readonly<MiniAppRouteContext> = ctx;
  if (method !== "GET" && method !== "HEAD") return null;
  const activeServer: ReturnType<typeof Bun.serve> | null = miniAppServerHolder.current;
  if (activeServer === null) return null;
  const bundled: Readonly<BundledMiniAppIndex> | null = await readBundledMiniAppIndex();
  if (!bundled?.assetPaths.has(routePath)) return null;
  return executeMiniAppMiddlewareChain(
    ctx,
    getMiniAppPublicMiddlewareChain(),
    (routeCtx: Readonly<MiniAppRouteContext>): Promise<Response> => {
      const assetUrl: URL = new URL(routeCtx.routePath, activeServer.url);
      const ifNoneMatch: string | null = routeCtx.request.headers.get("if-none-match");
      return fetch(assetUrl, {
        method: routeCtx.method,
        headers: ifNoneMatch !== null ? { "If-None-Match": ifNoneMatch } : undefined,
      });
    }
  );
}
