import { MINI_APP_CHAT_ROUTE_PATTERN } from "../../consts/miniApp";
import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteMatch,
} from "../../types/miniApp";
import {
  handleGetChatDetailById,
  handleGetChatMessagesById,
  handleGetChatsRoute,
  handlePostChatFeatureById,
} from "../handlers/chats";
import { getMiniAppApiAuthMiddlewareChain, withMiniAppMiddlewareChain } from "../middleware";

/**
 * 构建受管群路由（`GET /api/chats`、`GET /api/chats/:chatId`、`GET /api/chats/:chatId/messages`、
 * `POST /api/chats/:chatId/feature`）的 `Bun.serve` 原生路由表片段，经完整双层鉴权中间件链。
 * @returns 受管群路由表片段。
 */
export function createChatsBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const apiAuthChain: readonly MiniAppMiddleware[] = getMiniAppApiAuthMiddlewareChain();
  return {
    "/api/chats": {
      GET: withMiniAppMiddlewareChain(apiAuthChain, (): Response => handleGetChatsRoute()),
    },
    "/api/chats/:chatId": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Response =>
          handleGetChatDetailById(ctx.params.chatId ?? "")
      ),
    },
    "/api/chats/:chatId/messages": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Response =>
          handleGetChatMessagesById(ctx.params.chatId ?? "", ctx.url)
      ),
    },
    "/api/chats/:chatId/feature": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostChatFeatureById(ctx.request, ctx.params.chatId ?? "")
      ),
    },
  };
}

/**
 * 在兜底分发的业务 API 中间件链内匹配 `/api/chats/*` 路由。
 * @param ctx 已通过业务 API 中间件链的路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchChatsApiRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  if (ctx.method === "GET" && ctx.routePath === "/api/chats") {
    return handleGetChatsRoute();
  }
  const chatMatch: RegExpExecArray | null =
    MINI_APP_CHAT_ROUTE_PATTERN.exec(ctx.routePath);
  if (chatMatch === null) return null;

  const rawChatId: string = chatMatch[1] ?? "";
  const subResource: string | undefined = chatMatch[2];
  if (subResource === undefined && ctx.method === "GET") {
    return handleGetChatDetailById(rawChatId);
  }
  if (subResource === "messages" && ctx.method === "GET") {
    return handleGetChatMessagesById(rawChatId, ctx.url);
  }
  if (subResource === "feature" && ctx.method === "POST") {
    return handlePostChatFeatureById(ctx.request, rawChatId);
  }
  return null;
}
