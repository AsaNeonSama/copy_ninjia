import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteMatch,
} from "../../types/miniApp";
import { handleGetAuthPrecheckRoute, handlePostAuthLoginRoute } from "../handlers/auth";
import { getMiniAppInitDataMiddlewareChain } from "../middleware/chains";
import { executeMiniAppMiddlewareChain, withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建首屏预检与登录路由（`GET /api/auth/precheck`、`POST /api/auth/login`）的 `Bun.serve` 原生路由表片段，
 * 只经 `initData` 签名与密码锁定中间件链（不要求 45 分钟会话）。
 * @returns 鉴权路由表片段。
 */
export function createAuthBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const initDataChain: readonly MiniAppMiddleware[] = getMiniAppInitDataMiddlewareChain();
  return {
    "/api/auth/precheck": {
      GET: withMiniAppMiddlewareChain(
        initDataChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetAuthPrecheckRoute(ctx.request)
      ),
    },
    "/api/auth/login": {
      POST: withMiniAppMiddlewareChain(
        initDataChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostAuthLoginRoute(ctx.request)
      ),
    },
  };
}

/**
 * 在兜底分发中匹配首屏预检与登录路由，经 `initData` 中间件链执行。
 * @param ctx 路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchAuthRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  if (ctx.method === "GET" && ctx.routePath === "/api/auth/precheck") {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppInitDataMiddlewareChain(),
      (routeCtx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetAuthPrecheckRoute(routeCtx.request)
    );
  }
  if (ctx.method === "POST" && ctx.routePath === "/api/auth/login") {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppInitDataMiddlewareChain(),
      (routeCtx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostAuthLoginRoute(routeCtx.request)
    );
  }
  return null;
}
