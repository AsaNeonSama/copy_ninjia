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
import { MINI_APP_INIT_DATA_AUTH_POLICY } from "../../consts/miniApp";
import { withMiniAppAuth } from "../middleware/pipeline";

/** 经前置 `initData` 与锁定校验策略包装的首屏预检处理器。 */
const precheckWithInitDataChain: MiniAppBunRouteHandler = withMiniAppAuth(
  MINI_APP_INIT_DATA_AUTH_POLICY,
  (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
    handleGetAuthPrecheckRoute(ctx.request)
);

/**
 * 首屏预检、登录与登出路由（`GET /api/auth/precheck`、`POST /api/auth/login`、`POST /api/auth/logout`）的 `Bun.serve` 原生路由表片段。
 * 统一挂载 `MINI_APP_INIT_DATA_AUTH_POLICY`（仅核验 `initData` 签名与登录锁定，不在前置层要求或续期 45 分钟会话，使登出可直接吊销原会话）；预检失败时一并清除客户端携带的门禁 Cookie。
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
    POST: withMiniAppAuth(
      MINI_APP_INIT_DATA_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostAuthLoginRoute(ctx.request)
    ),
  },
  "/api/auth/logout": {
    POST: withMiniAppAuth(
      MINI_APP_INIT_DATA_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Response =>
        handlePostAuthLogoutRoute(ctx.request)
    ),
  },
};
