/**
 * Mini App 群管理 GET/POST 路由 `chatId`（查询参数与 JSON 请求体）及非对象请求体校验测试。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildSuperAdminHeaders,
  ensureReusableTestSession,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { resetIdentityStorageCache } = await import(
  "../../packages/cache/main/identityStorage"
);
const { miniAppAuthSessions } = await import("../../packages/cache/main/miniApp");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { dispatchMiniAppTestRequest: handleMiniAppHttpRequest } = await import(
  "../helpers/miniAppRequest"
);

/**
 * 构造携带当前 `BOT_TOKEN`、`SUPER_ADMIN_USER_ID` 签名与有效密码会话令牌的测试请求头。
 * @returns 包含 `X-Telegram-Init-Data` 与 `X-Mini-App-Session` 的请求头。
 */
function superAdminHeaders(): Record<string, string> {
  return buildSuperAdminHeaders({
    botToken: BOT_TOKEN,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    sessionToken: ensureReusableTestSession(issueMiniAppAuthSession).token,
    username: "super_admin",
  });
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  resetMiniAppTestDiskIOState();
  resetIdentityStorageCache();
  resetChatStateCache();
  miniAppAuthSessions.clear();
});

describe("Mini App 群管理路由参数校验", () => {
  test("群管理 GET/POST 路由校验 chatId（查询参数与 JSON 请求体）及非对象请求体", async () => {
    for (const getPath of [
      "/api/chats/detail",
      "/api/chats/detail?chatId=0",
      "/api/chats/detail?chatId=12345",
      "/api/chats/detail?chatId=abc",
      "/api/chats/messages?chatId=12345",
      "/api/chats/targets",
      "/api/chats/targets?chatId=1.5",
    ]) {
      const badGetRes: Response = await handleMiniAppHttpRequest(
        new Request(`http://127.0.0.1:3000${getPath}`, {
          headers: superAdminHeaders(),
        })
      );
      expect(badGetRes.status).toBe(400);
      expect(((await badGetRes.json()) as { readonly error: string }).error).toBe(
        "INVALID_CHAT_ID"
      );
    }

    for (const [postPath, expectedParamError] of [
      ["/api/chats/feature", "INVALID_CHAT_FEATURE_PARAMS"],
      ["/api/chats/batch-kick", "INVALID_BATCH_KICK_PARAMS"],
      ["/api/chats/targets", "INVALID_CHAT_TARGETS_PARAMS"],
    ] as const) {
      for (const nonObjectBody of ["not-json", "[]", "123"]) {
        const nonObjRes: Response = await handleMiniAppHttpRequest(
          new Request(`http://127.0.0.1:3000${postPath}`, {
            method: "POST",
            headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
            body: nonObjectBody,
          })
        );
        expect(nonObjRes.status).toBe(400);
        expect(((await nonObjRes.json()) as { readonly error: string }).error).toBe(
          expectedParamError
        );
      }

      for (const badChatIdBody of [
        {},
        { chatId: 12345, feature: "aiChat", enabled: true, hours: 3, action: "setQa" },
        { chatId: 0, feature: "aiChat", enabled: true, hours: 3, action: "setQa" },
        { chatId: "-1002001", feature: "aiChat", enabled: true, hours: 3, action: "setQa" },
        { chatId: -100.5, feature: "aiChat", enabled: true, hours: 3, action: "setQa" },
      ]) {
        const badChatIdRes: Response = await handleMiniAppHttpRequest(
          new Request(`http://127.0.0.1:3000${postPath}`, {
            method: "POST",
            headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(badChatIdBody),
          })
        );
        expect(badChatIdRes.status).toBe(400);
        expect(((await badChatIdRes.json()) as { readonly error: string }).error).toBe(
          "INVALID_CHAT_ID"
        );
      }
    }

    const badFeatureParamRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/chats/feature", {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: -1002001, feature: "unknown", enabled: true }),
      })
    );
    expect(badFeatureParamRes.status).toBe(400);
    expect(((await badFeatureParamRes.json()) as { readonly error: string }).error).toBe(
      "INVALID_CHAT_FEATURE_PARAMS"
    );

    const badTargetsParamRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/chats/targets", {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: -1002001, action: "unknown" }),
      })
    );
    expect(badTargetsParamRes.status).toBe(400);
    expect(((await badTargetsParamRes.json()) as { readonly error: string }).error).toBe(
      "INVALID_CHAT_TARGETS_PARAMS"
    );
  });
});
