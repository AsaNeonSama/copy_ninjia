import { MINI_APP_API_AUTH_POLICY } from "../../consts/miniApp/auth";
import type {
  MiniAppBunRouteTable,
  MiniAppRouteContext,
} from "../../types/miniApp/server";
import {
  handleGetAdBlacklistPreviewRoute,
  handleGetAdBlacklistsRoute,
  handlePostAdBlacklistsRoute,
} from "../handlers/adBlacklists";
import { withMiniAppAuth } from "../middleware/pipeline";

/**
 * 内容黑名单查询、增删及页内包预览路由（`/api/ad-blacklists`、`/api/ad-blacklists/preview`）的 `Bun.serve` 原生路由表片段，
 * 经完整双层鉴权与会话 256-bit 临时密钥加密传输策略。
 */
export const MINI_APP_AD_BLACKLISTS_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/ad-blacklists": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetAdBlacklistsRoute(ctx.url)
    ),
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostAdBlacklistsRoute(ctx.request)
    ),
  },
  "/api/ad-blacklists/preview": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetAdBlacklistPreviewRoute(ctx.request, ctx.url)
    ),
  },
};
