import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteMatch,
} from "../../types/miniApp";
import { handleGetMoodRoute, handleGetStatusRoute, handlePostMoodSwitchRoute } from "../handlers/status";
import { getMiniAppApiAuthMiddlewareChain } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建运行状态与 AI 情绪路由（`GET /api/status`、`GET /api/mood`、`POST /api/mood/switch`）的 `Bun.serve` 原生路由表片段，
 * 经完整双层鉴权中间件链。
 * @returns 状态与情绪路由表片段。
 */
export function createStatusBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const apiAuthChain: readonly MiniAppMiddleware[] = getMiniAppApiAuthMiddlewareChain();
  return {
    "/api/status": {
      GET: withMiniAppMiddlewareChain(apiAuthChain, (): Response => handleGetStatusRoute()),
    },
    "/api/mood": {
      GET: withMiniAppMiddlewareChain(apiAuthChain, (): Promise<Response> => handleGetMoodRoute()),
    },
    "/api/mood/switch": {
      POST: withMiniAppMiddlewareChain(apiAuthChain, (): Promise<Response> => handlePostMoodSwitchRoute()),
    },
  };
}

/**
 * 在兜底分发的业务 API 中间件链内匹配 `/api/status` 与 `/api/mood` 相关路由。
 * @param ctx 已通过业务 API 中间件链的路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchStatusApiRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  if (ctx.method === "GET" && ctx.routePath === "/api/status") {
    return handleGetStatusRoute();
  }
  if (ctx.method === "GET" && ctx.routePath === "/api/mood") {
    return handleGetMoodRoute();
  }
  if (ctx.method === "POST" && ctx.routePath === "/api/mood/switch") {
    return handlePostMoodSwitchRoute();
  }
  return null;
}
