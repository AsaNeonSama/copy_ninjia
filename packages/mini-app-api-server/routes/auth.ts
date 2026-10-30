import type { MiniAppRouteContext } from "../../types/miniApp";
import { handleGetAuthPrecheckRoute, handlePostAuthLoginRoute } from "../handlers/auth";
import { MINI_APP_INIT_DATA_MIDDLEWARE_CHAIN } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建首屏预检与登录路由（`GET /api/auth/precheck`、`POST /api/auth/login`）的 `Bun.serve` 原生路由表片段，
 * 只经 `initData` 签名与密码锁定中间件链（不要求 45 分钟会话）。
 * @returns 鉴权路由表片段。
 */
export function createAuthBunRoutes(): Bun.Serve.Routes<undefined, string> {
  return {
    "/api/auth/precheck": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_INIT_DATA_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetAuthPrecheckRoute(ctx.request)
      ),
    },
    "/api/auth/login": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_INIT_DATA_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostAuthLoginRoute(ctx.request)
      ),
    },
  };
}
