import type { MiniAppBunRouteTable } from "../../types/miniApp";
import {
  handleGetMoodRoute,
  handleGetStatusRoute,
  handlePostMoodSwitchRoute,
} from "../handlers/status";
import { MINI_APP_API_AUTH_MIDDLEWARE_CHAIN } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 运行状态与 AI 情绪路由（`GET /api/status`、`GET /api/mood`、`POST /api/mood/switch`）的 `Bun.serve` 原生路由表片段，
 * 经完整双层鉴权中间件链。
 */
export const MINI_APP_STATUS_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/status": {
    GET: withMiniAppMiddlewareChain(
      MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
      handleGetStatusRoute
    ),
  },
  "/api/mood": {
    GET: withMiniAppMiddlewareChain(
      MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
      handleGetMoodRoute
    ),
  },
  "/api/mood/switch": {
    POST: withMiniAppMiddlewareChain(
      MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
      handlePostMoodSwitchRoute
    ),
  },
};
