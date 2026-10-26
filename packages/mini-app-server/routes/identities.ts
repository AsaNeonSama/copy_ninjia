import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteMatch,
} from "../../types/miniApp";
import {
  handleGetBlocklistRoute,
  handleGetPickerResultRoute,
  handleGetWhitelistRoute,
  handlePostBlocklistRoute,
  handlePostPermissionRoute,
  handlePostPickerPrepareRoute,
  handlePostWhitelistRoute,
} from "../handlers/identities";
import { getMiniAppApiAuthMiddlewareChain, withMiniAppMiddlewareChain } from "../middleware";

/**
 * 构建黑白名单、权限与原生选择器路由（`/api/identities/whitelist`、`/api/identities/blocklist`、
 * `/api/identities/permission`、`/api/picker/prepare`、`/api/picker/result`）的 `Bun.serve` 原生路由表片段，
 * 经完整双层鉴权中间件链。
 * @returns 名单与选择器路由表片段。
 */
export function createIdentitiesBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const apiAuthChain: readonly MiniAppMiddleware[] = getMiniAppApiAuthMiddlewareChain();
  return {
    "/api/identities/whitelist": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handleGetWhitelistRoute(ctx.url)
      ),
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handlePostWhitelistRoute(ctx.request)
      ),
    },
    "/api/identities/blocklist": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handleGetBlocklistRoute(ctx.url)
      ),
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handlePostBlocklistRoute(ctx.request)
      ),
    },
    "/api/identities/permission": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handlePostPermissionRoute(ctx.request)
      ),
    },
    "/api/picker/prepare": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handlePostPickerPrepareRoute(ctx.request)
      ),
    },
    "/api/picker/result": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Response => handleGetPickerResultRoute(ctx.url)
      ),
    },
  };
}

/**
 * 在兜底分发的业务 API 中间件链内匹配 `/api/identities/*` 与 `/api/picker/*` 路由。
 * @param ctx 已通过业务 API 中间件链的路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchIdentitiesApiRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  const { method, routePath, request, url }: Readonly<MiniAppRouteContext> = ctx;
  if (routePath === "/api/identities/whitelist") {
    if (method === "GET") return handleGetWhitelistRoute(url);
    if (method === "POST") return handlePostWhitelistRoute(request);
  }
  if (routePath === "/api/identities/blocklist") {
    if (method === "GET") return handleGetBlocklistRoute(url);
    if (method === "POST") return handlePostBlocklistRoute(request);
  }
  if (routePath === "/api/identities/permission" && method === "POST") {
    return handlePostPermissionRoute(request);
  }
  if (routePath === "/api/picker/prepare" && method === "POST") {
    return handlePostPickerPrepareRoute(request);
  }
  if (routePath === "/api/picker/result" && method === "GET") {
    return handleGetPickerResultRoute(url);
  }
  return null;
}
