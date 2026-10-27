import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteMatch,
} from "../../types/miniApp";
import { handleGetFaviconRoute, handleHealthzRoute, serveMiniAppIndexHtml } from "../handlers/page";
import { getMiniAppPublicMiddlewareChain } from "../middleware/chains";
import { executeMiniAppMiddlewareChain, withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建公开页面路由（`/healthz`、`/_bundle`、`/`、`/index.html`、`/favicon.ico`）的 `Bun.serve` 原生路由表片段；
 * `/_bundle` 直接挂载前端 HTML import，供 `serveMiniAppIndexHtml` 读取注入打包产物路径后的入口 HTML。
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
