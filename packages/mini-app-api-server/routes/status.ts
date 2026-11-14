import type { MiniAppBunRouteTable } from "../../types/miniApp/server";
import {
  handleGetMoodRoute,
  handleGetStatusRoute,
  handlePostMoodSwitchRoute,
} from "../handlers/status";
import { MINI_APP_API_AUTH_POLICY } from "../middleware/chains";
import { withMiniAppAuth } from "../middleware/pipeline";

/**
 * 运行状态与 AI 情绪路由（`GET /api/status`、`GET /api/mood`、`POST /api/mood/switch`）的 `Bun.serve` 原生路由表片段，
 * 经完整双层鉴权策略。
 */
export const MINI_APP_STATUS_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/status": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      handleGetStatusRoute
    ),
  },
  "/api/mood": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      handleGetMoodRoute
    ),
  },
  "/api/mood/switch": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      handlePostMoodSwitchRoute
    ),
  },
};
