import type { MiniAppBunRouteTable, MiniAppRouteContext } from "../../types/miniApp/server";
import {
  handleDeleteTotpRoute,
  handleGetTotpRoute,
  handlePostTotpEnableRoute,
  handlePostTotpSetupRoute,
} from "../handlers/totp";
import { MINI_APP_API_AUTH_POLICY } from "../middleware/chains";
import { withMiniAppAuth } from "../middleware/pipeline";

/**
 * Google Authenticator 验证器管理路由（`/api/totp`、`/api/totp/setup`、`/api/totp/enable`、`/api/totp/delete`）的
 * `Bun.serve` 原生路由表片段，经完整双层鉴权策略。
 */
export const MINI_APP_TOTP_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/totp": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      handleGetTotpRoute
    ),
    DELETE: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleDeleteTotpRoute(ctx.request)
    ),
  },
  "/api/totp/setup": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      handlePostTotpSetupRoute
    ),
  },
  "/api/totp/enable": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostTotpEnableRoute(ctx.request)
    ),
  },
  "/api/totp/delete": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleDeleteTotpRoute(ctx.request)
    ),
  },
};
