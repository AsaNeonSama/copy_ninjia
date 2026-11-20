/**
 * Mini App API 操作审计与锁定告警日志测试。
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  buildSignedTestInitData,
  buildSuperAdminHeaders,
  ensureReusableTestSession,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";
import type { InstalledTelegramApi, TelegramSentMessage } from "../../packages/types/telegramWorker";

installMiniAppTestDiskIOMock();

const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { resetIdentityStorageCache } = await import("../../packages/cache/main/identityStorage");
const {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
  miniAppPendingPickers,
} = await import("../../packages/cache/main/miniApp");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_HEADER,
} = await import("../../packages/consts/miniApp");
const { getOrCreateChatState } = await import("../../packages/infra/chatStateStorage");
const { logger } = await import("../../packages/infra/logger");
const { bot } = await import("../../packages/infra/telegram/mainClient");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const {
  dispatchMiniAppTestRequest: handleMiniAppHttpRequest,
  performMiniAppTestEcdhLogin,
} = await import("../helpers/miniAppRequest");

const sendMessageStub = mock(
  async (..._args: unknown[]): Promise<TelegramSentMessage> => ({ message_id: 1 })
);

function adminHeaders(): Record<string, string> {
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
  miniAppAuthHandshakes.clear();
  miniAppPendingPickers.clear();
  miniAppPasswordGuardHolder.current = null;
  telegramApiState.current = null;
  sendMessageStub.mockClear();
});

describe("Mini App operation 与 warn 审计日志", () => {
  test("认证变更记录 operation、连续失败锁定记录 warn 且不泄露凭据，只读查询零 operation", async () => {
    const adminInitData: string = buildSignedTestInitData({
      botToken: BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000),
      user: {
        id: SUPER_ADMIN_USER_ID,
        first_name: "SuperAdmin",
        username: "super_admin",
      },
    });
    const configuredPassword: string = getBotMiniAppConfig()!.password;
    const wrongPassword: string = "wrong-secret-password-999";
    const opSpy = spyOn(logger, "operation");
    const warnSpy = spyOn(logger, "warn");
    const consoleInfoSpy = spyOn(console, "info").mockImplementation((): void => {});
    const consoleWarnSpy = spyOn(console, "warn").mockImplementation((): void => {});
    telegramApiState.current = { sendMessage: sendMessageStub } as unknown as InstalledTelegramApi;

    try {
      const { precheckResponse, handshake, loginResponse, payload } =
        await performMiniAppTestEcdhLogin({
          initData: adminInitData,
          credentialPayload: { password: configuredPassword },
        });
      expect(precheckResponse?.status).toBe(200);
      expect(loginResponse.status).toBe(200);
      expect(opSpy).toHaveBeenCalledTimes(1);
      expect(opSpy.mock.calls[0]).toEqual([
        "[MiniApp] auth.login",
        {
          outcome: "succeeded",
          mode: "password",
        },
      ]);
      expect(warnSpy).not.toHaveBeenCalled();

      const sessionToken: string = String(payload.sessionToken);
      const sessionKey: string = String(payload.sessionKey);
      const opAfterLogin: string = JSON.stringify(opSpy.mock.calls);
      expect(opAfterLogin).not.toContain(configuredPassword);
      expect(opAfterLogin).not.toContain(handshake.handshakeId);
      expect(opAfterLogin).not.toContain(handshake.serverPublicKey);
      expect(opAfterLogin).not.toContain(sessionToken);
      expect(opAfterLogin).not.toContain(sessionKey);
      expect(opAfterLogin).not.toContain(adminInitData);

      opSpy.mockClear();
      const authHeaders: Record<string, string> = {
        [MINI_APP_INIT_DATA_HEADER]: adminInitData,
        [MINI_APP_SESSION_HEADER]: sessionToken,
      };
      for (const path of ["/api/auth/precheck", "/api/status", "/api/mood", "/api/totp"]) {
        const readRes: Response = await handleMiniAppHttpRequest(
          new Request(`http://127.0.0.1:3000${path}`, { headers: authHeaders })
        );
        expect(readRes.status).toBe(200);
      }
      expect(opSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      const logoutRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/auth/logout", {
          method: "POST",
          headers: authHeaders,
        })
      );
      expect(logoutRes.status).toBe(200);
      expect(opSpy).toHaveBeenCalledTimes(1);
      expect(opSpy).toHaveBeenCalledWith("[MiniApp] auth.logout", { sessionRevoked: true });
      expect(JSON.stringify(opSpy.mock.calls)).not.toContain(sessionToken);

      opSpy.mockClear();
      warnSpy.mockClear();
      for (let attempt: number = 1; attempt <= MINI_APP_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
        const failResult = await performMiniAppTestEcdhLogin({
          initData: adminInitData,
          credentialPayload: { password: `${wrongPassword}-${attempt}` },
        });
        expect(failResult.status).toBe(403);
      }
      expect(opSpy).toHaveBeenCalledTimes(MINI_APP_PASSWORD_MAX_ATTEMPTS);
      expect(opSpy.mock.calls[0]).toEqual([
        "[MiniApp] auth.login",
        { outcome: "rejected", mode: "password", locked: false },
      ]);
      expect(opSpy.mock.calls[MINI_APP_PASSWORD_MAX_ATTEMPTS - 1]).toEqual([
        "[MiniApp] auth.login",
        { outcome: "rejected", mode: "password", locked: true },
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[MiniApp] Super-admin login locked out after consecutive failed attempts."
      );
      const allLogged: string = JSON.stringify([...opSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(allLogged).not.toContain(wrongPassword);
      expect(allLogged).not.toContain(adminInitData);
    } finally {
      opSpy.mockRestore();
      warnSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    }
  });

  test("群管理只读 GET 路由零 operation，变更 POST 路由记录 logger.operation", async () => {
    const state = getOrCreateChatState(-1002001);
    state.isInitEnabled = true;
    state.title = "审计测试群";
    state.isFloodControlEnabled = true;

    const opSpy = spyOn(logger, "operation");
    const consoleInfoSpy = spyOn(console, "info").mockImplementation((): void => {});
    try {
      const headers: Record<string, string> = adminHeaders();
      const listRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/chats", { headers })
      );
      expect(listRes.status).toBe(200);

      const detailRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/chats/detail?chatId=-1002001", { headers })
      );
      expect(detailRes.status).toBe(200);
      expect(opSpy).not.toHaveBeenCalled();

      const toggleRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/chats/feature", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: -1002001, feature: "floodControl", enabled: false }),
        })
      );
      expect(toggleRes.status).toBe(200);
      expect(opSpy).toHaveBeenCalledTimes(1);
      expect(opSpy).toHaveBeenCalledWith("[MiniApp] chats.feature", {
        chatId: -1002001,
        feature: "floodControl",
        enabled: false,
        ok: true,
        removedFromList: false,
      });
    } finally {
      opSpy.mockRestore();
      consoleInfoSpy.mockRestore();
    }
  });

  test("POST /api/picker/prepare 成功返回 200、失败返回 502，均记录 [MiniApp] picker.prepare 审计日志", async () => {
    const chatId: number = -1002099;
    const state = getOrCreateChatState(chatId);
    state.isInitEnabled = true;
    state.isTranslationEnabled = true;
    state.title = "选择器路由审计群";
    state.botPermissions = {
      isAdministrator: true,
      canManageChat: true,
      canDeleteMessages: true,
      canRestrictMembers: true,
      canInviteUsers: false,
      canPinMessages: false,
      canPromoteMembers: false,
      canChangeInfo: false,
      canManageTopics: false,
      canPostMessages: false,
      canEditMessages: false,
      canPostStories: false,
      canEditStories: false,
      canDeleteStories: false,
      canManageVideoChats: false,
      canManageTags: false,
      canManageDirectMessages: false,
      isAnonymous: false,
    };

    const opSpy = spyOn(logger, "operation");
    const consoleInfoSpy = spyOn(console, "info").mockImplementation((): void => {});
    const consoleErrorSpy = spyOn(console, "error").mockImplementation((): void => {});
    const saveBtnSpy = spyOn(bot.api, "savePreparedKeyboardButton").mockResolvedValue({
      id: "prepared-btn-whitelist-1",
    });
    try {
      const headers: Record<string, string> = {
        ...adminHeaders(),
        "Content-Type": "application/json",
      };

      // 1. 成功路径：savePreparedKeyboardButton 返回预存按钮 ID，HTTP 200 且记录 ok: true。
      const okRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/picker/prepare", {
          method: "POST",
          headers,
          body: JSON.stringify({ targetList: "whitelist", subjectKind: "users" }),
        })
      );
      expect(okRes.status).toBe(200);
      const okBody = (await okRes.json()) as {
        readonly ok: boolean;
        readonly requestId?: number;
        readonly preparedButtonId?: string;
      };
      expect(okBody.ok).toBeTrue();
      expect(okBody.preparedButtonId).toBe("prepared-btn-whitelist-1");
      expect(typeof okBody.requestId).toBe("number");
      expect(miniAppPendingPickers.has(okBody.requestId!)).toBeTrue();
      expect(opSpy).toHaveBeenCalledWith("[MiniApp] picker.prepare", {
        targetList: "whitelist",
        subjectKind: "users",
        chatId: null,
        ok: true,
      });

      // 2. 群删发言目标成功路径：携带 chatId，记录非空 chatId 审计字段。
      opSpy.mockClear();
      const chatOkRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/picker/prepare", {
          method: "POST",
          headers,
          body: JSON.stringify({
            targetList: "deleteMessage",
            subjectKind: "channel",
            chatId,
          }),
        })
      );
      expect(chatOkRes.status).toBe(200);
      expect(opSpy).toHaveBeenCalledWith("[MiniApp] picker.prepare", {
        targetList: "deleteMessage",
        subjectKind: "channel",
        chatId,
        ok: true,
      });

      // 3. 失败路径：Telegram API 抛错或返回空 ID 时返回 HTTP 502 并记录 ok: false。
      opSpy.mockClear();
      saveBtnSpy.mockRejectedValueOnce(new Error("Telegram savePreparedKeyboardButton failed"));

      const failRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/picker/prepare", {
          method: "POST",
          headers,
          body: JSON.stringify({
            targetList: "blocklist",
            subjectKind: "users",
          }),
        })
      );
      expect(failRes.status).toBe(502);
      const failBody = (await failRes.json()) as {
        readonly ok: boolean;
        readonly message?: string;
      };
      expect(failBody).toEqual({
        ok: false,
        message: "PICKER_PREPARE_FAILED",
      });
      expect(opSpy).toHaveBeenCalledWith("[MiniApp] picker.prepare", {
        targetList: "blocklist",
        subjectKind: "users",
        chatId: null,
        ok: false,
      });

      // 4. 目标群未初始化等业务前置失败同样走 HTTP 502 与 ok: false 审计日志。
      opSpy.mockClear();
      state.isInitEnabled = false;
      const uninitRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/picker/prepare", {
          method: "POST",
          headers,
          body: JSON.stringify({
            targetList: "translate",
            subjectKind: "users",
            chatId,
            language: "en",
          }),
        })
      );
      expect(uninitRes.status).toBe(502);
      expect(await uninitRes.json()).toEqual({
        ok: false,
        message: "CHAT_NOT_INITIALIZED",
      });
      expect(opSpy).toHaveBeenCalledWith("[MiniApp] picker.prepare", {
        targetList: "translate",
        subjectKind: "users",
        chatId,
        ok: false,
      });
    } finally {
      saveBtnSpy.mockRestore();
      opSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
