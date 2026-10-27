import {
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_CHAT_TARGETS_MUTATION_ACTIONS,
  MINI_APP_FEATURE_KEYS,
  MINI_APP_TRANSLATE_LANGUAGES,
} from "../../consts/miniApp";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type {
  MiniAppBatchKickResult,
  MiniAppChatDetail,
  MiniAppChatTargetsMutationAction,
  MiniAppChatTargetsMutationResult,
  MiniAppChatTargetsView,
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
  MiniAppMessagePage,
  MiniAppTranslateLanguage,
} from "../../types/miniApp";
import { parseOptionalSafeInt, readJsonObjectBody } from "../libs/request";
import { jsonResponse } from "../libs/response";
import { triggerManagedChatBatchKick } from "../view/chats/batchKick";
import { getManagedChatDetail, listManagedChats } from "../view/chats/query";
import { getManagedChatTargets, mutateManagedChatTargets } from "../view/chats/targets";
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
export async function handleGetChatDetailById(rawChatId: string): Promise<Response> {
  const chatId: number | null = parseGroupChatIdParam(rawChatId);
  if (chatId === null) {
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const detail: Readonly<MiniAppChatDetail> | null = await getManagedChatDetail(chatId);
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

/**
 * 处理 `POST /api/chats/:chatId/batch-kick`：按 1–24 小时回溯窗口触发指定群的 `/batch_kick` 批量清理新进群成员。
 * @param request HTTP 请求。
 * @param rawChatId 路径中的群聊 ID 字符串。
 * @returns JSON 响应。
 */
export async function handlePostChatBatchKickById(
  request: Request,
  rawChatId: string
): Promise<Response> {
  const chatId: number | null = parseGroupChatIdParam(rawChatId);
  if (chatId === null) {
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  const hours: unknown = body?.hours;
  if (
    typeof hours !== "number" ||
    !Number.isSafeInteger(hours) ||
    hours < MINI_APP_BATCH_KICK_MIN_HOURS ||
    hours > MINI_APP_BATCH_KICK_MAX_HOURS
  ) {
    return jsonResponse(
      { error: "INVALID_BATCH_KICK_PARAMS" },
      400
    );
  }
  const result: Readonly<MiniAppBatchKickResult> =
    await triggerManagedChatBatchKick(chatId, hours);
  const status: number =
    result.outcome === "notInitialized"
      ? 404
      : result.outcome === "unavailable"
        ? 503
        : 200;
  return jsonResponse(result, status);
}

/**
 * 处理 `GET /api/chats/:chatId/targets`：读取指定已 `/init` 群的问答对、追着删目标与追着翻目标清单。
 * @param rawChatId 路径中的群聊 ID 字符串。
 * @returns JSON 响应。
 */
export function handleGetChatTargetsById(rawChatId: string): Response {
  const chatId: number | null = parseGroupChatIdParam(rawChatId);
  if (chatId === null) {
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const targets: Readonly<MiniAppChatTargetsView> | null = getManagedChatTargets(chatId);
  if (targets === null) {
    return jsonResponse({ error: "CHAT_NOT_FOUND" }, 404);
  }
  return jsonResponse({ targets });
}

/**
 * 处理 `POST /api/chats/:chatId/targets`：在指定已 `/init` 群内新增、修改或移除问答对、追着删目标与追着翻目标。
 * @param request HTTP 请求。
 * @param rawChatId 路径中的群聊 ID 字符串。
 * @returns JSON 响应。
 */
export async function handlePostChatTargetsById(
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
    typeof body.action !== "string" ||
    !MINI_APP_CHAT_TARGETS_MUTATION_ACTIONS.includes(
      body.action as MiniAppChatTargetsMutationAction
    )
  ) {
    return jsonResponse({ error: "INVALID_CHAT_TARGETS_PARAMS" }, 400);
  }

  const q: string | undefined = typeof body.q === "string" ? body.q : undefined;
  const a: string | undefined = typeof body.a === "string" ? body.a : undefined;
  const target: string | undefined = typeof body.target === "string" ? body.target : undefined;
  const id: number | undefined = typeof body.id === "number" ? body.id : undefined;
  const language: MiniAppTranslateLanguage | undefined =
    typeof body.language === "string" &&
    MINI_APP_TRANSLATE_LANGUAGES.includes(body.language as MiniAppTranslateLanguage)
      ? (body.language as MiniAppTranslateLanguage)
      : undefined;

  const result: Readonly<MiniAppChatTargetsMutationResult> =
    await mutateManagedChatTargets(chatId, {
      action: body.action as MiniAppChatTargetsMutationAction,
      ...(q !== undefined ? { q } : {}),
      ...(a !== undefined ? { a } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(language !== undefined ? { language } : {}),
    });
  if (result.message === "CHAT_NOT_FOUND") {
    return jsonResponse({ error: "CHAT_NOT_FOUND" }, 404);
  }
  return jsonResponse(result, 200);
}
