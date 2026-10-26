import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteMatch,
} from "../../types/miniApp";
import {
  handleDeleteTotpRoute,
  handleGetTotpRoute,
  handlePostTotpEnableRoute,
  handlePostTotpSetupRoute,
} from "../handlers/totp";
import { getMiniAppApiAuthMiddlewareChain } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建 Google Authenticator 验证器管理路由（`/api/totp`、`/api/totp/setup`、`/api/totp/enable`、`/api/totp/delete`）的
 * `Bun.serve` 原生路由表片段，经完整双层鉴权中间件链。
 * @returns TOTP 路由表片段。
 */
export function createTotpBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const apiAuthChain: readonly MiniAppMiddleware[] = getMiniAppApiAuthMiddlewareChain();
  return {
    "/api/totp": {
      GET: withMiniAppMiddlewareChain(apiAuthChain, (): Promise<Response> => handleGetTotpRoute()),
      DELETE: withMiniAppMiddlewareChain(apiAuthChain, (): Promise<Response> => handleDeleteTotpRoute()),
    },
    "/api/totp/setup": {
      POST: withMiniAppMiddlewareChain(apiAuthChain, (): Response => handlePostTotpSetupRoute()),
    },
    "/api/totp/enable": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handlePostTotpEnableRoute(ctx.request)
      ),
    },
    "/api/totp/delete": {
      POST: withMiniAppMiddlewareChain(apiAuthChain, (): Promise<Response> => handleDeleteTotpRoute()),
    },
  };
}

/**
 * 在兜底分发的业务 API 中间件链内匹配 `/api/totp` 及其子路径路由。
 * @param ctx 已通过业务 API 中间件链的路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchTotpApiRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  const { method, routePath }: Readonly<MiniAppRouteContext> = ctx;
  if (method === "GET" && routePath === "/api/totp") {
    return handleGetTotpRoute();
  }
  if (method === "POST" && routePath === "/api/totp/setup") {
    return handlePostTotpSetupRoute();
  }
  if (method === "POST" && routePath === "/api/totp/enable") {
    return handlePostTotpEnableRoute(ctx.request);
  }
  if (
    (method === "DELETE" && routePath === "/api/totp") ||
    (method === "POST" && routePath === "/api/totp/delete")
  ) {
    return handleDeleteTotpRoute();
  }
  return null;
}
