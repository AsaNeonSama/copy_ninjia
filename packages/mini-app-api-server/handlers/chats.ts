import {
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_CHAT_TARGETS_MUTATION_ACTIONS,
  MINI_APP_FEATURE_KEYS,
  MINI_APP_TRANSLATE_LANGUAGES,
} from "../../consts/miniApp/features";
import { logger } from "../../infra/logger";
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
} from "../../types/miniApp/chats";
import { parseOptionalSafeInt, readJsonObjectBody } from "../libs/request";
import { jsonResponse } from "../libs/response";
import { triggerManagedChatBatchKick } from "../view/chats/batchKick";
import { getManagedChatDetail, listManagedChats } from "../view/chats/query";
import { getManagedChatTargets, mutateManagedChatTargets } from "../view/chats/targets";
import { setManagedChatFeature } from "../view/chats/toggle";
import { readManagedChatMessages } from "../view/messages";

/**
 * 从请求 URL 的 `chatId` 查询参数解析并校验负数群聊 ID；缺失或非法时返回 `400 INVALID_CHAT_ID` 响应。
 * @param url 已解封加密查询串后的请求 URL。
 * @returns 合法的负数群聊 ID，或 `400` JSON 错误响应。
 */
function parseGroupChatIdQueryOrError(url: URL): number | Response {
  const parsed: number | undefined = parseOptionalSafeInt(
    url.searchParams.get("chatId")
  );
  if (parsed === undefined || !isTelegramGroupChatId(parsed)) {
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
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
 * 处理 `GET /api/chats/detail`：从已解密查询参数读取 `chatId`，返回指定已 `/init` 群的详细状态。
 * @param url 已解封加密查询串后的请求 URL（读取 `chatId` 查询参数）。
 * @returns JSON 响应。
 */
export async function handleGetChatDetailRoute(url: URL): Promise<Response> {
  const chatId: number | Response = parseGroupChatIdQueryOrError(url);
  if (chatId instanceof Response) {
    return chatId;
  }
  const detail: Readonly<MiniAppChatDetail> | null = await getManagedChatDetail(chatId);
  if (detail === null) {
    return jsonResponse({ error: "CHAT_NOT_FOUND" }, 404);
  }
  return jsonResponse({ detail });
}

/**
 * 处理 `GET /api/chats/messages`：从已解密查询参数读取 `chatId`、`page` 与 `pageSize`，返回指定已 `/init` 群的热 256 条发言记录。
 * @param url 已解封加密查询串后的请求 URL（读取 `chatId`、`page`、`pageSize` 查询参数）。
 * @returns JSON 响应。
 */
export function handleGetChatMessagesRoute(url: URL): Response {
  const chatId: number | Response = parseGroupChatIdQueryOrError(url);
  if (chatId instanceof Response) {
    return chatId;
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
 * 处理 `POST /api/chats/feature`：从已解密 JSON 请求体读取 `chatId`、`feature` 与 `enabled`，切换指定群的功能开关。
 * @param request HTTP 请求（请求体已由中间件解封外层加密）。
 * @returns JSON 响应。
 */
export async function handlePostChatFeatureRoute(
  request: Request
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (body === null) {
    return jsonResponse(
      { error: "INVALID_CHAT_FEATURE_PARAMS" },
      400
    );
  }
  if (!isTelegramGroupChatId(body.chatId)) {
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const chatId: number = body.chatId;
  if (
    typeof body.feature !== "string" ||
    !MINI_APP_FEATURE_KEYS.includes(body.feature as MiniAppFeatureKey) ||
    typeof body.enabled !== "boolean"
  ) {
    return jsonResponse(
      { error: "INVALID_CHAT_FEATURE_PARAMS" },
      400
    );
  }
  const feature: MiniAppFeatureKey = body.feature as MiniAppFeatureKey;
  const enabled: boolean = body.enabled;
  const toggleResult: Readonly<MiniAppFeatureToggleResult> =
    await setManagedChatFeature({
      chatId,
      feature,
      enabled,
    });
  logger.operation("[MiniApp] chats.feature", {
    chatId,
    feature,
    enabled,
    ok: toggleResult.ok,
    removedFromList: toggleResult.removedFromList,
  });
  return jsonResponse(
    toggleResult,
    toggleResult.ok || toggleResult.removedFromList ? 200 : 400
  );
}

/**
 * 处理 `POST /api/chats/batch-kick`：从已解密 JSON 请求体读取 `chatId` 与 `hours`，按 1–24 小时回溯窗口触发指定群的 `/batch_kick` 批量清理新进群成员。
 * @param request HTTP 请求（请求体已由中间件解封外层加密）。
 * @returns JSON 响应。
 */
export async function handlePostChatBatchKickRoute(
  request: Request
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (body === null) {
    return jsonResponse(
      { error: "INVALID_BATCH_KICK_PARAMS" },
      400
    );
  }
  if (!isTelegramGroupChatId(body.chatId)) {
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const chatId: number = body.chatId;
  const hours: unknown = body.hours;
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
  logger.operation("[MiniApp] chats.batchKick", {
    chatId,
    hours,
    outcome: result.outcome,
  });
  const status: number =
    result.outcome === "notInitialized"
      ? 404
      : result.outcome === "unavailable"
        ? 503
        : 200;
  return jsonResponse(result, status);
}

/**
 * 处理 `GET /api/chats/targets`：从已解密查询参数读取 `chatId`，返回指定已 `/init` 群的问答对、追着删目标与追着翻目标清单。
 * @param url 已解封加密查询串后的请求 URL（读取 `chatId` 查询参数）。
 * @returns JSON 响应。
 */
export function handleGetChatTargetsRoute(url: URL): Response {
  const chatId: number | Response = parseGroupChatIdQueryOrError(url);
  if (chatId instanceof Response) {
    return chatId;
  }
  const targets: Readonly<MiniAppChatTargetsView> | null = getManagedChatTargets(chatId);
  if (targets === null) {
    return jsonResponse({ error: "CHAT_NOT_FOUND" }, 404);
  }
  return jsonResponse({ targets });
}

/**
 * 处理 `POST /api/chats/targets`：从已解密 JSON 请求体读取 `chatId` 与变更动作，在指定已 `/init` 群内新增、修改或移除问答对、追着删目标与追着翻目标。
 * @param request HTTP 请求（请求体已由中间件解封外层加密）。
 * @returns JSON 响应。
 */
export async function handlePostChatTargetsRoute(
  request: Request
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (body === null) {
    return jsonResponse({ error: "INVALID_CHAT_TARGETS_PARAMS" }, 400);
  }
  if (!isTelegramGroupChatId(body.chatId)) {
    return jsonResponse({ error: "INVALID_CHAT_ID" }, 400);
  }
  const chatId: number = body.chatId;
  if (
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

  const action: MiniAppChatTargetsMutationAction =
    body.action as MiniAppChatTargetsMutationAction;
  const result: Readonly<MiniAppChatTargetsMutationResult> =
    await mutateManagedChatTargets(chatId, {
      action,
      ...(q !== undefined ? { q } : {}),
      ...(a !== undefined ? { a } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(language !== undefined ? { language } : {}),
    });
  logger.operation("[MiniApp] chats.targets", {
    chatId,
    action,
    ok: result.ok,
  });
  if (result.message === "CHAT_NOT_FOUND") {
    return jsonResponse({ error: "CHAT_NOT_FOUND" }, 404);
  }
  return jsonResponse(result, 200);
}
