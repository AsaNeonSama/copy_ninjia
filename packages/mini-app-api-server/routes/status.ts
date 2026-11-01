import {
  handleGetMoodRoute,
  handleGetStatusRoute,
  handlePostMoodSwitchRoute,
} from "../handlers/status";
import { MINI_APP_API_AUTH_MIDDLEWARE_CHAIN } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建运行状态与 AI 情绪路由（`GET /api/status`、`GET /api/mood`、`POST /api/mood/switch`）的 `Bun.serve` 原生路由表片段，
 * 经完整双层鉴权中间件链。
 * @returns 状态与情绪路由表片段。
 */
export function createStatusBunRoutes(): Bun.Serve.Routes<undefined, string> {
  return {
    "/api/status": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (): Response => handleGetStatusRoute()
      ),
    },
    "/api/mood": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (): Promise<Response> => handleGetMoodRoute()
      ),
    },
    "/api/mood/switch": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (): Promise<Response> => handlePostMoodSwitchRoute()
      ),
    },
  };
}
