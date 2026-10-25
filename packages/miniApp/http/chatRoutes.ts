import {
  MINI_APP_CHAT_ROUTE_PATTERN,
  MINI_APP_FEATURE_KEYS,
} from "../../consts/miniApp";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type {
  MiniAppChatDetail,
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
  MiniAppMessagePage,
} from "../../types/miniApp";
import {
  getManagedChatDetail,
  listManagedChats,
  setManagedChatFeature,
} from "../chatsView";
import { readManagedChatMessages } from "../messagesView";
import {
  jsonResponse,
  parseOptionalSafeInt,
  readJsonObjectBody,
} from "./common";

/**
 * 解析并校验路由中的群聊 ID。
 * @param rawChatId 路由参数中的原始群聊 ID 字符串。
 * @returns 合法的负数群聊 ID，非法时返回 `null`。
 */
function parseGroupChatIdParam(rawChatId: string): number | null {
  const parsed: number | undefined = parseOptionalSafeInt(rawChatId);
  if (parsed === undefined || !isTelegramGroupChatId(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * 处理 `GET /api/chats`：列出所有已开启 `/init` 的群聊摘要。
 * @returns JSON 响应。
 */
export function handleGetChatsRoute(): Response {
  return jsonResponse({ items: listManagedChats() });
}

/**
 * 处理 `GET /api/chats/:chatId`：读取指定已 `/init` 群的详细状态。
 * @param rawChatId 路径中的群聊 ID 字符串。
 * @returns JSON 响应。
 */
export function handleGetChatDetailById(rawChatId: string): Response {
  const chatId: number | null = parseGroupChatIdParam(rawChatId);
  if (chatId === null) {
    return jsonResponse({ error: "无效的群聊 ID。" }, 400);
  }
  const detail: Readonly<MiniAppChatDetail> | null = getManagedChatDetail(chatId);
  if (detail === null) {
    return jsonResponse({ error: "该群未开启 /init 或不存在。" }, 404);
  }
  return jsonResponse({ detail });
}

/**
 * 处理 `GET /api/chats/:chatId/messages`：读取指定已 `/init` 群的热 256 条发言记录。
 * @param request HTTP 请求。
 * @param rawChatId 路径中的群聊 ID 字符串。
 * @param parsedUrl 已解析的 URL（缺省由 `request.url` 解析）。
 * @returns JSON 响应。
 */
export function handleGetChatMessagesById(
  request: Request,
  rawChatId: string,
  parsedUrl?: URL
): Response {
  const chatId: number | null = parseGroupChatIdParam(rawChatId);
  if (chatId === null) {
    return jsonResponse({ error: "无效的群聊 ID。" }, 400);
  }
  const url: URL = parsedUrl ?? new URL(request.url);
  const page: number | undefined = parseOptionalSafeInt(url.searchParams.get("page"));
  const pageSize: number | undefined = parseOptionalSafeInt(url.searchParams.get("pageSize"));
  const messagesPage: Readonly<MiniAppMessagePage> | null = readManagedChatMessages({
    chatId,
    page,
    pageSize,
  });
  if (messagesPage === null) {
    return jsonResponse({ error: "该群未开启 /init 或不存在。" }, 404);
  }
  return jsonResponse(messagesPage);
}

/**
 * 处理 `POST /api/chats/:chatId/feature`：切换指定群的功能开关。
 * @param request HTTP 请求。
 * @param rawChatId 路径中的群聊 ID 字符串。
 * @returns JSON 响应。
 */
export async function handlePostChatFeatureById(
  request: Request,
  rawChatId: string
): Promise<Response> {
  const chatId: number | null = parseGroupChatIdParam(rawChatId);
  if (chatId === null) {
    return jsonResponse({ error: "无效的群聊 ID。" }, 400);
  }
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.feature !== "string" ||
    !MINI_APP_FEATURE_KEYS.includes(body.feature as MiniAppFeatureKey) ||
    typeof body.enabled !== "boolean"
  ) {
    return jsonResponse(
      { error: "请求参数格式非法：需要合法的 feature 与布尔值 enabled。" },
      400
    );
  }
  const toggleResult: Readonly<MiniAppFeatureToggleResult> =
    await setManagedChatFeature({
      chatId,
      feature: body.feature as MiniAppFeatureKey,
      enabled: body.enabled,
    });
  return jsonResponse(
    toggleResult,
    toggleResult.ok || toggleResult.removedFromList ? 200 : 400
  );
}

/**
 * 在通用请求分发中匹配并处理 `/api/chats/*` 路由。
 * @param method 大写 HTTP 方法。
 * @param routePath 归一化后的内部路由路径。
 * @param request 原始请求对象。
 * @returns 匹配时返回 `Response`，未匹配时返回 `null`。
 */
export async function handleChatsApiRoute(
  method: string,
  routePath: string,
  request: Request
): Promise<Response | null> {
  if (method === "GET" && routePath === "/api/chats") {
    return handleGetChatsRoute();
  }
  const chatMatch: RegExpExecArray | null =
    MINI_APP_CHAT_ROUTE_PATTERN.exec(routePath);
  if (chatMatch === null) return null;

  const rawChatId: string = chatMatch[1] ?? "";
  const subResource: string | undefined = chatMatch[2];
  if (subResource === undefined && method === "GET") {
    return handleGetChatDetailById(rawChatId);
  }
  if (subResource === "messages" && method === "GET") {
    return handleGetChatMessagesById(request, rawChatId);
  }
  if (subResource === "feature" && method === "POST") {
    return handlePostChatFeatureById(request, rawChatId);
  }
  return null;
}
