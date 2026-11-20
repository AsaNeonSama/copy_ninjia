import { MINI_APP_API_AUTH_POLICY } from "../../consts/miniApp";
import { MINI_APP_CONFIG_SAVE_AUTH_POLICY } from "../../consts/miniAppCrypto";
import type {
  MiniAppBunRouteTable,
  MiniAppRouteContext,
} from "../../types/miniApp/server";
import {
  handleGetConfigFileRoute,
  handleGetConfigsRoute,
  handlePostConfigRestartRoute,
  handlePostConfigSaveRoute,
} from "../handlers/configs";
import { withMiniAppAuth } from "../middleware/pipeline";

/**
 * 部署配置查看、配置保存与服务重启路由的 `Bun.serve` 原生路由表片段。
 * 全部直接走完整双层鉴权与会话 256-bit 临时密钥加密传输策略（`POST /api/configs/save` 放宽请求体上限至 4 MiB）。
 */
export const MINI_APP_CONFIGS_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/configs": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (): Promise<Response> => handleGetConfigsRoute()
    ),
  },
  "/api/configs/file": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetConfigFileRoute(ctx.url)
    ),
  },
  "/api/configs/save": {
    POST: withMiniAppAuth(
      MINI_APP_CONFIG_SAVE_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostConfigSaveRoute(ctx.request)
    ),
  },
  "/api/configs/restart": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (): Promise<Response> => handlePostConfigRestartRoute()
    ),
  },
};
