/**
 * Mini App 心情路由 `GET /api/mood` 与 `POST /api/mood/switch`：AI Worker、AI 闲聊配置或心情配置
 * 任一不可用时不发请求；查询失败回 `ok: false`，重抽失败回 503 `MOOD_SWITCH_FAILED`。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MiniAppMoodMutationResult, MiniAppMoodView } from "../../packages/types/miniApp";

/**
 * AI Worker 心情请求的默认替身：查询回「平静」，重抽回「开心」。
 * @param requestType 请求种类。
 * @returns 心情名。
 */
async function answerMood(requestType: "queryMood" | "switchMood"): Promise<string> {
  return requestType === "queryMood" ? "平静" : "开心";
}

const requestAiMood = mock(answerMood);

mock.module("../../packages/aiChat", () => ({ requestAiMood }));

const { aiChatWorkerState } = await import("../../packages/cache/main/aiChat");
const { aiChatConfigReadinessCache } = await import("../../packages/cache/main/configReadiness");
const { defaultMoodConfigCache } = await import("../../packages/cache/perThread/config");
const { handleGetMoodRoute, handlePostMoodSwitchRoute } = await import(
  "../../packages/mini-app-api-server/handlers/status"
);

/** 让 AI Worker、AI 闲聊配置与心情表都可用。 */
function restorePreconditions(): void {
  aiChatWorkerState.available = true;
  aiChatConfigReadinessCache.current = { ok: true };
  defaultMoodConfigCache.current = { moods: [{ name: "平静", weight: 1, instruction: "" }] };
}

beforeEach(restorePreconditions);

afterEach((): void => {
  aiChatWorkerState.available = false;
  aiChatConfigReadinessCache.current = { ok: true };
  defaultMoodConfigCache.current = null;
  requestAiMood.mockReset();
  requestAiMood.mockImplementation(answerMood);
});

/** 让 AI 闲聊配置或心情表不可用的两种做法；Worker 不可用只影响查询路由。 */
const BREAK_PRECONDITION: readonly (() => void)[] = [
  (): void => {
    aiChatConfigReadinessCache.current = {
      ok: false,
      failure: { file: "config/dynamic/agent.json", reason: "fixture" },
    };
  },
  (): void => {
    defaultMoodConfigCache.current = null;
  },
];

describe("Mini App 心情路由", () => {
  test("GET /api/mood 查询当前心情；Worker、配置或心情表不可用时回 available: false 且不发请求", async () => {
    const ok: MiniAppMoodView = (await (await handleGetMoodRoute()).json()) as MiniAppMoodView;
    expect(ok).toEqual({ ok: true, available: true, currentMood: "平静" });
    expect(requestAiMood).toHaveBeenCalledWith("queryMood");

    for (const breakPrecondition of [
      (): void => {
        aiChatWorkerState.available = false;
      },
      ...BREAK_PRECONDITION,
    ]) {
      requestAiMood.mockClear();
      breakPrecondition();
      const unavailable: MiniAppMoodView =
        (await (await handleGetMoodRoute()).json()) as MiniAppMoodView;
      expect(unavailable).toEqual({ ok: true, available: false, currentMood: null });
      expect(requestAiMood).not.toHaveBeenCalled();
      restorePreconditions();
    }
  });

  test("GET /api/mood 查询失败回 ok: false", async () => {
    requestAiMood.mockImplementationOnce(async (): Promise<never> => {
      throw new Error("AI Worker is unavailable.");
    });
    const response: Response = await handleGetMoodRoute();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, available: false, currentMood: null });
  });

  test("POST /api/mood/switch 重抽成功回 MOOD_SWITCHED；配置或心情表不可用回 400，重抽失败回 503", async () => {
    const switched: Response = await handlePostMoodSwitchRoute();
    expect(switched.status).toBe(200);
    expect((await switched.json()) as MiniAppMoodMutationResult).toEqual({
      ok: true,
      available: true,
      currentMood: "开心",
      message: "MOOD_SWITCHED",
    });
    expect(requestAiMood).toHaveBeenCalledWith("switchMood");

    for (const breakPrecondition of BREAK_PRECONDITION) {
      requestAiMood.mockClear();
      breakPrecondition();
      const broken: Response = await handlePostMoodSwitchRoute();
      expect(broken.status).toBe(400);
      expect(((await broken.json()) as MiniAppMoodMutationResult).message).toBe("MOOD_SWITCH_FAILED");
      expect(requestAiMood).not.toHaveBeenCalled();
      restorePreconditions();
    }

    requestAiMood.mockImplementationOnce(async (): Promise<never> => {
      throw new Error("AI switchMood request timed out.");
    });
    const failed: Response = await handlePostMoodSwitchRoute();
    expect(failed.status).toBe(503);
    expect((await failed.json()) as MiniAppMoodMutationResult).toEqual({
      ok: false,
      available: false,
      currentMood: null,
      message: "MOOD_SWITCH_FAILED",
    });
  });
});
