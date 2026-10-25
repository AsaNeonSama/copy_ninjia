import { requestAiMood } from "../../aiChat";
import { aiChatWorkerState } from "../../cache/main/aiChat";
import { defaultMoodConfigCache } from "../../cache/perThread/config";
import { aiChatConfigReadiness } from "../../config/readiness";
import { chatAtmosphere } from "../../infra/atmosphere";
import type {
  MiniAppMoodMutationResult,
  MiniAppMoodView,
} from "../../types/miniApp";
import { buildMiniAppStatusView } from "../statusView";
import { jsonResponse } from "./common";

/**
 * 处理 `GET /api/status`：返回实时运行状态快照。
 * @returns JSON 响应。
 */
export function handleGetStatusRoute(): Response {
  return jsonResponse(buildMiniAppStatusView());
}

/**
 * 处理 `GET /api/mood`：向 AI Worker 查询当前全局生效心情（不触发重抽）。
 * @returns JSON 响应。
 */
export async function handleGetMoodRoute(): Promise<Response> {
  if (
    !aiChatWorkerState.available ||
    !aiChatConfigReadiness().ok ||
    defaultMoodConfigCache.current === null
  ) {
    const unavailableBody: Readonly<MiniAppMoodView> = {
      ok: true,
      available: false,
      currentMood: null,
    };
    return jsonResponse(unavailableBody);
  }
  try {
    const moodName: string = await requestAiMood("queryMood");
    const body: Readonly<MiniAppMoodView> = {
      ok: true,
      available: true,
      currentMood: moodName,
    };
    return jsonResponse(body);
  } catch (_error: unknown) {
    const failedBody: Readonly<MiniAppMoodView> = {
      ok: false,
      available: false,
      currentMood: null,
    };
    return jsonResponse(failedBody);
  }
}

/**
 * 处理 `POST /api/mood/switch`：向 AI Worker 发起全局心情重抽并返回新心情名称。
 * @returns JSON 响应。
 */
export async function handlePostMoodSwitchRoute(): Promise<Response> {
  if (
    !aiChatConfigReadiness().ok ||
    defaultMoodConfigCache.current === null
  ) {
    const brokenBody: Readonly<MiniAppMoodMutationResult> = {
      ok: false,
      available: false,
      currentMood: null,
      message: chatAtmosphere().NOTICE_TEXTS.moodSwitchFailed,
    };
    return jsonResponse(brokenBody, 400);
  }
  try {
    const moodName: string = await requestAiMood("switchMood");
    const okBody: Readonly<MiniAppMoodMutationResult> = {
      ok: true,
      available: true,
      currentMood: moodName,
      message: chatAtmosphere().NOTICE_TEXTS.moodSwitched(moodName),
    };
    return jsonResponse(okBody);
  } catch (_error: unknown) {
    const failBody: Readonly<MiniAppMoodMutationResult> = {
      ok: false,
      available: false,
      currentMood: null,
      message: chatAtmosphere().NOTICE_TEXTS.moodSwitchFailed,
    };
    return jsonResponse(failBody, 503);
  }
}

/**
 * 兜底匹配并处理 `/api/status` 与 `/api/mood` 相关路由。
 * @param method 大写 HTTP 方法。
 * @param routePath 归一化后的内部路由路径。
 * @returns 命中时返回 `Response`，未命中时返回 `null`。
 */
export async function handleStatusAndMoodApiRoute(
  method: string,
  routePath: string
): Promise<Response | null> {
  if (method === "GET" && routePath === "/api/status") {
    return handleGetStatusRoute();
  }
  if (method === "GET" && routePath === "/api/mood") {
    return handleGetMoodRoute();
  }
  if (method === "POST" && routePath === "/api/mood/switch") {
    return handlePostMoodSwitchRoute();
  }
  return null;
}
