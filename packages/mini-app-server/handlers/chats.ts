import { MINI_APP_FEATURE_KEYS } from "../../consts/miniApp";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type {
  MiniAppChatDetail,
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
  MiniAppMessagePage,
} from "../../types/miniApp";
import { parseOptionalSafeInt, readJsonObjectBody } from "../libs/request";
import { jsonResponse } from "../libs/response";
import { getManagedChatDetail, listManagedChats } from "../view/chats/query";
import { setManagedChatFeature } from "../view/chats/toggle";
import { readManagedChatMessages } from "../view/messages";

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
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const detail: Readonly<MiniAppChatDetail> | null = getManagedChatDetail(chatId);
  if (detail === null) {
    return jsonResponse({ error: "CHAT_NOT_FOUND" }, 404);
  }
  return jsonResponse({ detail });
}

/**
 * 处理 `GET /api/chats/:chatId/messages`：读取指定已 `/init` 群的热 256 条发言记录。
 * @param rawChatId 路径中的群聊 ID 字符串。
 * @param url 已解析的请求 URL（读取 `page`、`pageSize` 查询参数）。
 * @returns JSON 响应。
 */
export function handleGetChatMessagesById(
  rawChatId: string,
  url: URL
): Response {
  const chatId: number | null = parseGroupChatIdParam(rawChatId);
  if (chatId === null) {
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const page: number | undefined = parseOptionalSafeInt(url.searchParams.get("page"));
  const pageSize: number | undefined = parseOptionalSafeInt(url.searchParams.get("pageSize"));
  const messagesPage: Readonly<MiniAppMessagePage> | null = readManagedChatMessages({
    chatId,
    page,
    pageSize,
  });
  if (messagesPage === null) {
    return jsonResponse({ error: "CHAT_NOT_FOUND" }, 404);
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
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.feature !== "string" ||
    !MINI_APP_FEATURE_KEYS.includes(body.feature as MiniAppFeatureKey) ||
    typeof body.enabled !== "boolean"
  ) {
    return jsonResponse(
      { error: "INVALID_CHAT_FEATURE_PARAMS" },
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
