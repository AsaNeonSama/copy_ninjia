import type { MiniAppBunRouteTable, MiniAppRouteContext } from "../../types/miniApp/server";
import {
  handleGetBlocklistRoute,
  handleGetPickerResultRoute,
  handleGetWhitelistRoute,
  handlePostBlocklistRoute,
  handlePostPermissionRoute,
  handlePostPickerPrepareRoute,
  handlePostWhitelistRoute,
} from "../handlers/identities";
import { MINI_APP_API_AUTH_POLICY } from "../middleware/chains";
import { withMiniAppAuth } from "../middleware/pipeline";

/**
 * 黑白名单、权限与原生选择器路由（`/api/identities/whitelist`、`/api/identities/blocklist`、
 * `/api/identities/permission`、`/api/picker/prepare`、`/api/picker/result`）的 `Bun.serve` 原生路由表片段，
 * 经完整双层鉴权策略。
 */
export const MINI_APP_IDENTITIES_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/identities/whitelist": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetWhitelistRoute(ctx.url)
    ),
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostWhitelistRoute(ctx.request)
    ),
  },
  "/api/identities/blocklist": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetBlocklistRoute(ctx.url)
    ),
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostBlocklistRoute(ctx.request)
    ),
  },
  "/api/identities/permission": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostPermissionRoute(ctx.request)
    ),
  },
  "/api/picker/prepare": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostPickerPrepareRoute(ctx.request)
    ),
  },
  "/api/picker/result": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Response =>
        handleGetPickerResultRoute(ctx.url)
    ),
  },
};
