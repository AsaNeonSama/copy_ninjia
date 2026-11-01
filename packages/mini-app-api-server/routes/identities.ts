import type { MiniAppRouteContext } from "../../types/miniApp";
import {
  handleGetBlocklistRoute,
  handleGetPickerResultRoute,
  handleGetWhitelistRoute,
  handlePostBlocklistRoute,
  handlePostPermissionRoute,
  handlePostPickerPrepareRoute,
  handlePostWhitelistRoute,
} from "../handlers/identities";
import { MINI_APP_API_AUTH_MIDDLEWARE_CHAIN } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建黑白名单、权限与原生选择器路由（`/api/identities/whitelist`、`/api/identities/blocklist`、
 * `/api/identities/permission`、`/api/picker/prepare`、`/api/picker/result`）的 `Bun.serve` 原生路由表片段，
 * 经完整双层鉴权中间件链。
 * @returns 名单与选择器路由表片段。
 */
export function createIdentitiesBunRoutes(): Bun.Serve.Routes<undefined, string> {
  return {
    "/api/identities/whitelist": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetWhitelistRoute(ctx.url)
      ),
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostWhitelistRoute(ctx.request)
      ),
    },
    "/api/identities/blocklist": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetBlocklistRoute(ctx.url)
      ),
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostBlocklistRoute(ctx.request)
      ),
    },
    "/api/identities/permission": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostPermissionRoute(ctx.request)
      ),
    },
    "/api/picker/prepare": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostPickerPrepareRoute(ctx.request)
      ),
    },
    "/api/picker/result": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Response =>
          handleGetPickerResultRoute(ctx.url)
      ),
    },
  };
}
