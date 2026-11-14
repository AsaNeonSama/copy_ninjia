import type { MiniAppBunRouteTable, MiniAppRouteContext } from "../../types/miniApp/server";
import {
  handleGetChatDetailById,
  handleGetChatMessagesById,
  handleGetChatTargetsById,
  handleGetChatsRoute,
  handlePostChatBatchKickById,
  handlePostChatFeatureById,
  handlePostChatTargetsById,
} from "../handlers/chats";
import { MINI_APP_API_AUTH_POLICY } from "../middleware/chains";
import { withMiniAppAuth } from "../middleware/pipeline";

/**
 * 受管群路由（`GET /api/chats`、`GET /api/chats/:chatId`、`GET /api/chats/:chatId/messages`、
 * `POST /api/chats/:chatId/feature`、`POST /api/chats/:chatId/batch-kick`、`GET|POST /api/chats/:chatId/targets`）的 `Bun.serve` 原生路由表片段，经完整双层鉴权策略。
 */
export const MINI_APP_CHATS_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/chats": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      handleGetChatsRoute
    ),
  },
  "/api/chats/:chatId": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetChatDetailById(ctx.params.chatId ?? "")
    ),
  },
  "/api/chats/:chatId/messages": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Response =>
        handleGetChatMessagesById(ctx.params.chatId ?? "", ctx.url)
    ),
  },
  "/api/chats/:chatId/feature": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostChatFeatureById(ctx.request, ctx.params.chatId ?? "")
    ),
  },
  "/api/chats/:chatId/batch-kick": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostChatBatchKickById(ctx.request, ctx.params.chatId ?? "")
    ),
  },
  "/api/chats/:chatId/targets": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Response =>
        handleGetChatTargetsById(ctx.params.chatId ?? "")
    ),
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostChatTargetsById(ctx.request, ctx.params.chatId ?? "")
    ),
  },
};
