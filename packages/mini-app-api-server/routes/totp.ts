import type { MiniAppRouteContext } from "../../types/miniApp";
import {
  handleDeleteTotpRoute,
  handleGetTotpRoute,
  handlePostTotpEnableRoute,
  handlePostTotpSetupRoute,
} from "../handlers/totp";
import { MINI_APP_API_AUTH_MIDDLEWARE_CHAIN } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建 Google Authenticator 验证器管理路由（`/api/totp`、`/api/totp/setup`、`/api/totp/enable`、`/api/totp/delete`）的
 * `Bun.serve` 原生路由表片段，经完整双层鉴权中间件链。
 * @returns TOTP 路由表片段。
 */
export function createTotpBunRoutes(): Bun.Serve.Routes<undefined, string> {
  return {
    "/api/totp": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (): Promise<Response> => handleGetTotpRoute()
      ),
      DELETE: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (): Promise<Response> => handleDeleteTotpRoute()
      ),
    },
    "/api/totp/setup": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (): Response => handlePostTotpSetupRoute()
      ),
    },
    "/api/totp/enable": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostTotpEnableRoute(ctx.request)
      ),
    },
    "/api/totp/delete": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (): Promise<Response> => handleDeleteTotpRoute()
      ),
    },
  };
}
