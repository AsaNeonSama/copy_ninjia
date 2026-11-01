import type { MiniAppRouteContext } from "../../types/miniApp";
import {
  handleGetChatDetailById,
  handleGetChatMessagesById,
  handleGetChatTargetsById,
  handleGetChatsRoute,
  handlePostChatBatchKickById,
  handlePostChatFeatureById,
  handlePostChatTargetsById,
} from "../handlers/chats";
import { MINI_APP_API_AUTH_MIDDLEWARE_CHAIN } from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建受管群路由（`GET /api/chats`、`GET /api/chats/:chatId`、`GET /api/chats/:chatId/messages`、
 * `POST /api/chats/:chatId/feature`、`POST /api/chats/:chatId/batch-kick`、`GET|POST /api/chats/:chatId/targets`）的 `Bun.serve` 原生路由表片段，经完整双层鉴权中间件链。
 * @returns 受管群路由表片段。
 */
export function createChatsBunRoutes(): Bun.Serve.Routes<undefined, string> {
  return {
    "/api/chats": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (): Response => handleGetChatsRoute()
      ),
    },
    "/api/chats/:chatId": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetChatDetailById(ctx.params.chatId ?? "")
      ),
    },
    "/api/chats/:chatId/messages": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Response =>
          handleGetChatMessagesById(ctx.params.chatId ?? "", ctx.url)
      ),
    },
    "/api/chats/:chatId/feature": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostChatFeatureById(ctx.request, ctx.params.chatId ?? "")
      ),
    },
    "/api/chats/:chatId/batch-kick": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostChatBatchKickById(ctx.request, ctx.params.chatId ?? "")
      ),
    },
    "/api/chats/:chatId/targets": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Response =>
          handleGetChatTargetsById(ctx.params.chatId ?? "")
      ),
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostChatTargetsById(ctx.request, ctx.params.chatId ?? "")
      ),
    },
  };
}
