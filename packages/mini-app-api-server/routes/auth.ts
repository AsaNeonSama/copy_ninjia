import type {
  MiniAppBunRouteHandler,
  MiniAppBunRouteTable,
  MiniAppRouteContext,
} from "../../types/miniApp/server";
import { clearMiniAppPageGateCookieIfPresent } from "../auth/pageGate";
import {
  handleGetAuthPrecheckRoute,
  handlePostAuthLoginRoute,
  handlePostAuthLogoutRoute,
} from "../handlers/auth";
import { MINI_APP_INIT_DATA_MIDDLEWARE_CHAIN } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/** 经前置 `initData` 与锁定校验中间件包装的首屏预检处理器。 */
const precheckWithInitDataChain: MiniAppBunRouteHandler =
  withMiniAppMiddlewareChain(
    MINI_APP_INIT_DATA_MIDDLEWARE_CHAIN,
    (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleGetAuthPrecheckRoute(ctx.request)
  );

/**
 * 首屏预检、登录与登出路由（`GET /api/auth/precheck`、`POST /api/auth/login`、`POST /api/auth/logout`）的 `Bun.serve` 原生路由表片段，
 * 只经 `initData` 签名与密码锁定中间件链（不要求 45 分钟会话，登出因此不会先刷新待吊销的会话）；预检失败且请求携带门禁 Cookie 时同步清除门禁 Cookie。
 */
export const MINI_APP_AUTH_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/auth/precheck": {
    GET: async (request: Request): Promise<Response> => {
      const response: Response = await precheckWithInitDataChain(request);
      if (!response.ok) {
        return clearMiniAppPageGateCookieIfPresent(response, request);
      }
      return response;
    },
  },
  "/api/auth/login": {
    POST: withMiniAppMiddlewareChain(
      MINI_APP_INIT_DATA_MIDDLEWARE_CHAIN,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostAuthLoginRoute(ctx.request)
    ),
  },
  "/api/auth/logout": {
    POST: withMiniAppMiddlewareChain(
      MINI_APP_INIT_DATA_MIDDLEWARE_CHAIN,
      (ctx: Readonly<MiniAppRouteContext>): Response =>
        handlePostAuthLogoutRoute(ctx.request)
    ),
  },
};
