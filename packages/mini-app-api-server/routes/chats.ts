import type { MiniAppBunRouteTable, MiniAppRouteContext } from "../../types/miniApp/server";
import {
  handleGetChatDetailRoute,
  handleGetChatMessagesRoute,
  handleGetChatTargetsRoute,
  handleGetChatsRoute,
  handlePostChatBatchKickRoute,
  handlePostChatFeatureRoute,
  handlePostChatTargetsRoute,
} from "../handlers/chats";
import { MINI_APP_API_AUTH_POLICY } from "../../consts/miniApp";
import { withMiniAppAuth } from "../middleware/pipeline";

/**
 * 受管群路由（`GET /api/chats`、`GET /api/chats/detail`、`GET /api/chats/messages`、
 * `POST /api/chats/feature`、`POST /api/chats/batch-kick`、`GET|POST /api/chats/targets`）的 `Bun.serve` 原生路由表片段，经完整双层鉴权策略。
 */
export const MINI_APP_CHATS_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/chats": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      handleGetChatsRoute
    ),
  },
  "/api/chats/detail": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetChatDetailRoute(ctx.url)
    ),
  },
  "/api/chats/messages": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Response =>
        handleGetChatMessagesRoute(ctx.url)
    ),
  },
  "/api/chats/feature": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostChatFeatureRoute(ctx.request)
    ),
  },
  "/api/chats/batch-kick": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostChatBatchKickRoute(ctx.request)
    ),
  },
  "/api/chats/targets": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Response =>
        handleGetChatTargetsRoute(ctx.url)
    ),
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostChatTargetsRoute(ctx.request)
    ),
  },
};
