import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import type {
  AiMemoryDeletedPersistedReply, DiskBusinessMessage, DomainFlushOutcome,
  IdentityPolicyPersistedRevision, IdentityStoragePersistedReply,
} from "../../packages/types/diskIO";
import type {
  BlocklistIdPage, IdentityPolicyRawReadResult, WhitelistIdPage,
} from "../../packages/types/identityStorage";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import { buildSignedTestInitData } from "../helpers/miniAppInitData";

const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
const aiMemoryDeletedListeners: ((reply: AiMemoryDeletedPersistedReply) => void)[] = [];
const whitelistDbRows: Map<number, string> = new Map<number, string>();
const blocklistDbRows: Map<number, string> = new Map<number, string>();

mock.module("../../packages/infra/diskIO", () =>
  diskIOStub({
    isDiskIOInitialized: (): boolean => true,
    flushDiskIODomain: async (): Promise<DomainFlushOutcome> => {
      const latestChatRevisions: Map<number, number> = new Map<number, number>();
      const identityWrites: IdentityPolicyPersistedRevision[] = [];
      for (const msg of diskMessages) {
        if (msg.type === "chatStateWrite") {
          latestChatRevisions.set(msg.chatId, msg.revision);
        } else if (msg.type === "identityPolicyWrite") {
          identityWrites.push({ table: msg.table, id: msg.id, revision: msg.revision });
          const targetMap: Map<number, string> =
            msg.table === "whitelist" ? whitelistDbRows : blocklistDbRows;
          if (msg.data === null) targetMap.delete(msg.id);
          else targetMap.set(msg.id, msg.data);
        }
      }
      const chatStateWrites: { chatId: number; revision: number }[] = [];
      for (const [chatId, revision] of latestChatRevisions) {
        chatStateWrites.push({ chatId, revision });
      }
      for (const listener of persistedListeners) {
        listener({
          type: "identityStoragePersisted",
          writes: identityWrites,
          temporaryAdBypassWrites: [],
          chatStateWrites,
          chatQaWrites: [],
          removalWrites: [],
        });
      }
      return { result: "flushed" };
    },
    onDiskIOReply: diskIOReplyStub({
      identityStoragePersisted: (
        listener: (reply: IdentityStoragePersistedReply) => void
      ): void => {
        persistedListeners.push(listener);
      },
      aiMemoryDeletedPersisted: (
        listener: (reply: AiMemoryDeletedPersistedReply) => void
      ): void => {
        aiMemoryDeletedListeners.push(listener);
      },
    }),
    postDiskIO: (message: DiskBusinessMessage): boolean => {
      diskMessages.push(message);
      if (message.type === "deleteAiMemory") {
        for (const listener of aiMemoryDeletedListeners) {
          listener({
            type: "aiMemoryDeletedPersisted",
            chatId: message.chatId,
            revision: message.revision,
          });
        }
      }
      return true;
    },
    readIdentityPolicies: async (
      ids: readonly number[]
    ): Promise<IdentityPolicyRawReadResult> => {
      const whitelist: [number, string][] = [];
      const blocklist: [number, string][] = [];
      for (const id of ids) {
        const wRow: string | undefined = whitelistDbRows.get(id);
        if (wRow !== undefined) whitelist.push([id, wRow]);
        const bRow: string | undefined = blocklistDbRows.get(id);
        if (bRow !== undefined) blocklist.push([id, bRow]);
      }
      return {
        whitelist,
        blocklist,
        temporaryAdBypass: [],
      };
    },
    readWhitelistIdPage: async (afterId: number | null): Promise<WhitelistIdPage> => {
      const sortedIds: number[] = [...whitelistDbRows.keys()]
        .filter((id) => afterId === null || id > afterId)
        .sort((a, b) => a - b);
      return {
        ids: sortedIds,
        nextCursor:
          sortedIds.length === 0 ? afterId : sortedIds[sortedIds.length - 1]!,
        done: true,
      };
    },
    readBlocklistIdPage: async (afterId: number | null): Promise<BlocklistIdPage> => {
      const sortedIds: number[] = [...blocklistDbRows.keys()]
        .filter((id) => afterId === null || id > afterId)
        .sort((a, b) => a - b);
      return {
        ids: sortedIds,
        nextCursor:
          sortedIds.length === 0 ? afterId : sortedIds[sortedIds.length - 1]!,
        done: true,
      };
    },
    relayLogMessage: (): boolean => true,
  })
);

const { latestAiMemories } = await import("../../packages/cache/main/aiChat");
const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { resetIdentityStorageCache } = await import(
  "../../packages/cache/main/identityStorage"
);
const {
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
} = await import("../../packages/cache/main/miniApp");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const { AI_MEMORY_HYDRATE_BUFFER_MAX, VERBATIM_CONTEXT_MAX } = await import(
  "../../packages/consts/aiChat/memory"
);
const {
  MINI_APP_CSP_HEADER_VALUE,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
  MINI_APP_PASSWORD_LOCKOUT_MS,
  MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_X_FRAME_OPTIONS_VALUE,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_TOTP_FILE_PATH,
  MINI_APP_TOTP_MEMORY_DIR,
} = await import("../../packages/consts/paths");
const { deriveMiniAppAssetToken } = await import("../../packages/libs/miniAppAuth");
const { generateMiniAppTotpCodeAt } = await import("../../packages/libs/miniAppTotp");
const { formatLocalTime } = await import("../../packages/libs/time");
const { MINI_APP_TOTP_STEP_SECONDS } = await import("../../packages/consts/miniAppTotp");
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const { getOrCreateChatState } = await import("../../packages/infra/storage/stateStore");
const {
  handleMiniAppHttpRequest,
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-server");
import type {
  MiniAppAccessDiagnostics,
  MiniAppBlocklistPage,
  MiniAppChatDetail,
  MiniAppChatSummary,
  MiniAppFeatureToggleResult,
  MiniAppIdentityMutationResult,
  MiniAppLoginSuccessResponse,
  MiniAppMessagePage,
  MiniAppStatusView,
  MiniAppWhitelistPage,
} from "../../packages/types/miniApp";
import type {
  MiniAppTotpMutationResponse,
  MiniAppTotpSetupResponse,
  MiniAppTotpStatusView,
} from "../../packages/types/miniAppTotp";
import type { InstalledTelegramApi, TelegramSentMessage } from "../../packages/types/telegramWorker";

/** 锁定告警私聊的 Telegram `sendMessage` 替身；由 `installTelegramSendMessageStub` 装入当前线程。 */
const sendMessageStub = mock(
  async (..._args: unknown[]): Promise<TelegramSentMessage> => ({ message_id: 1 })
);

/** 把只含 `sendMessage` 的 Telegram 能力装入当前线程，供锁定告警断言调用次数与正文。 */
function installTelegramSendMessageStub(): void {
  telegramApiState.current = { sendMessage: sendMessageStub } as unknown as InstalledTelegramApi;
}

/**
 * 构造携带当前 `BOT_TOKEN`、`SUPER_ADMIN_USER_ID` 签名与 45 分钟有效密码会话的测试请求头。
 * @returns 包含 `X-Telegram-Init-Data` 与 `X-Mini-App-Session` 的请求头。
 */
function superAdminHeaders(): Record<string, string> {
  const initData: string = buildSignedTestInitData({
    botToken: BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1000),
    user: {
      id: SUPER_ADMIN_USER_ID,
      first_name: "SuperAdmin",
      username: "super_admin",
    },
  });
  const session = issueMiniAppAuthSession();
  return {
    [MINI_APP_INIT_DATA_HEADER]: initData,
    [MINI_APP_SESSION_HEADER]: session.token,
  };
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  diskMessages.length = 0;
  whitelistDbRows.clear();
  blocklistDbRows.clear();
  resetIdentityStorageCache();
  resetChatStateCache();
  latestAiMemories.clear();
  miniAppAuthSessions.clear();
  telegramApiState.current = null;
  sendMessageStub.mockClear();
  setSystemTime();
});

describe("Mini App HTTP routes & Bun.serve integration", () => {
  test("未鉴权或非 SuperAdmin 访问 API 一律返回 401/403 真实诊断，且强制执行密码登录与 45 分钟会话过期", async () => {
    const unauthPrecheckRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/precheck", {
        headers: {
          "cf-connecting-ip": "203.0.113.42",
          "x-forwarded-host": "bot.asashishi.com",
        },
      })
    );
    expect(unauthPrecheckRes.status).toBe(401);
    const diagBody: MiniAppAccessDiagnostics =
      (await unauthPrecheckRes.json()) as MiniAppAccessDiagnostics;
    expect(diagBody.requestId).toMatch(/^[0-9a-f]{16}$/);
    expect(unauthPrecheckRes.headers.get("x-request-id")).toBe(diagBody.requestId);
    expect(diagBody.clientIp).toBe("203.0.113.42");
    expect(diagBody.host).toBe("bot.asashishi.com");
    expect(diagBody.path).toBe("/api/auth/precheck");
    expect(diagBody.timestamp.endsWith(" UTC")).toBeTrue();

    const multiHopRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/precheck", {
        headers: {
          "x-forwarded-for": "127.0.0.1, 198.51.100.88",
          "x-real-ip": "127.0.0.1",
          host: "127.0.0.1:3000",
        },
      })
    );
    expect(multiHopRes.status).toBe(401);
    const multiHopDiag: MiniAppAccessDiagnostics =
      (await multiHopRes.json()) as MiniAppAccessDiagnostics;
    expect(multiHopDiag.clientIp).toBe("198.51.100.88");
    expect(multiHopDiag.host).toBe("localhost");

    const nonAdminInitData: string = buildSignedTestInitData({
      botToken: BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000),
      user: {
        id: SUPER_ADMIN_USER_ID + 999,
        first_name: "OtherUser",
      },
    });
    const forbiddenRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          Authorization: `tma ${nonAdminInitData}`,
        },
      })
    );
    expect(forbiddenRes.status).toBe(403);

    const adminInitData: string = buildSignedTestInitData({
      botToken: BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000),
      user: {
        id: SUPER_ADMIN_USER_ID,
        first_name: "SuperAdmin",
      },
    });
    const precheckOkRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/precheck", {
        headers: { [MINI_APP_INIT_DATA_HEADER]: adminInitData },
      })
    );
    expect(precheckOkRes.status).toBe(200);
    expect(await precheckOkRes.json()).toEqual({
      ok: true,
      ttlMs: MINI_APP_SESSION_TTL_MS,
      totpEnabled: false,
      authMode: "password",
    });

    const missingPasswordSessionRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: { [MINI_APP_INIT_DATA_HEADER]: adminInitData },
      })
    );
    expect(missingPasswordSessionRes.status).toBe(401);
    expect(
      ((await missingPasswordSessionRes.json()) as MiniAppAccessDiagnostics).code
    ).toBe("PASSWORD_REQUIRED");

    const wrongLoginRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: "wrong-password" }),
      })
    );
    expect(wrongLoginRes.status).toBe(403);
    expect(((await wrongLoginRes.json()) as MiniAppAccessDiagnostics).code).toBe(
      "INVALID_PASSWORD"
    );

    const configuredPassword: string = getBotMiniAppConfig()!.password;
    const okLoginRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: configuredPassword }),
      })
    );
    expect(okLoginRes.status).toBe(200);
    const loginBody: MiniAppLoginSuccessResponse =
      (await okLoginRes.json()) as MiniAppLoginSuccessResponse;
    expect(loginBody.ok).toBeTrue();
    expect(loginBody.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(loginBody.ttlMs).toBe(MINI_APP_SESSION_TTL_MS);
    expect(loginBody.assetToken).toBe(
      deriveMiniAppAssetToken(BOT_TOKEN, SUPER_ADMIN_USER_ID)
    );

    const resumedPrecheckRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/precheck", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData,
          [MINI_APP_SESSION_HEADER]: loginBody.sessionToken,
        },
      })
    );
    expect(resumedPrecheckRes.status).toBe(200);
    expect(await resumedPrecheckRes.json()).toEqual({
      ok: true,
      ttlMs: MINI_APP_SESSION_TTL_MS,
      totpEnabled: false,
      authMode: "password",
      assetToken: deriveMiniAppAssetToken(BOT_TOKEN, SUPER_ADMIN_USER_ID),
      sessionValid: true,
      sessionExpiresAt: loginBody.expiresAt,
    });

    const expiredSession = issueMiniAppAuthSession(
      Date.now() - MINI_APP_SESSION_TTL_MS - 1_000
    );
    const expiredRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData,
          [MINI_APP_SESSION_HEADER]: expiredSession.token,
        },
      })
    );
    expect(expiredRes.status).toBe(401);
    expect(((await expiredRes.json()) as MiniAppAccessDiagnostics).code).toBe(
      "PASSWORD_REQUIRED"
    );

    installTelegramSendMessageStub();
    for (let attempt: number = 1; attempt <= MINI_APP_PASSWORD_MAX_ATTEMPTS; attempt++) {
      const failRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/auth/login", {
          method: "POST",
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData,
            "Content-Type": "application/json",
            "cf-connecting-ip": "203.0.113.42",
          },
          body: JSON.stringify({ password: `bad-password-${attempt}` }),
        })
      );
      expect(failRes.status).toBe(403);
      const failDiag: MiniAppAccessDiagnostics =
        (await failRes.json()) as MiniAppAccessDiagnostics;
      if (attempt < MINI_APP_PASSWORD_MAX_ATTEMPTS) {
        expect(failDiag.code).toBe("INVALID_PASSWORD");
      } else {
        expect(failDiag.code).toBe("PASSWORD_LOCKED");
      }
    }
    expect(sendMessageStub).toHaveBeenCalledTimes(1);
    expect(sendMessageStub.mock.calls[0]?.slice(0, 2)).toEqual([
      SUPER_ADMIN_USER_ID,
      chatAtmosphere().NOTICE_TEXTS.miniAppLoginLocked(
        MINI_APP_PASSWORD_MAX_ATTEMPTS,
        formatLocalTime(miniAppPasswordGuardHolder.current?.lockedUntil ?? 0),
        "203.0.113.42"
      ),
    ]);

    const lockedPrecheckRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/precheck", {
        headers: { [MINI_APP_INIT_DATA_HEADER]: adminInitData },
      })
    );
    expect(lockedPrecheckRes.status).toBe(403);
    expect(
      ((await lockedPrecheckRes.json()) as MiniAppAccessDiagnostics).code
    ).toBe("PASSWORD_LOCKED");

    const lockedCorrectLoginRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: configuredPassword }),
      })
    );
    expect(lockedCorrectLoginRes.status).toBe(403);
    expect(
      ((await lockedCorrectLoginRes.json()) as MiniAppAccessDiagnostics).code
    ).toBe("PASSWORD_LOCKED");
    expect(sendMessageStub).toHaveBeenCalledTimes(1);

    miniAppPasswordGuardHolder.current = {
      userId: SUPER_ADMIN_USER_ID,
      failedAttempts: MINI_APP_PASSWORD_MAX_ATTEMPTS,
      lockedUntil: Date.now() - MINI_APP_PASSWORD_LOCKOUT_MS,
    };
    const unlockedPrecheckRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/precheck", {
        headers: { [MINI_APP_INIT_DATA_HEADER]: adminInitData },
      })
    );
    expect(unlockedPrecheckRes.status).toBe(200);
    expect(miniAppPasswordGuardHolder.current).toBeNull();
  });

  test("同一 initData 并发登录在锁定后不再比对凭据，正确密码同样按失败计数并顺延锁定，锁定告警只发一次", async () => {
    const adminInitData: string = buildSignedTestInitData({
      botToken: BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000),
      user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin" },
    });
    const burstSize: number = MINI_APP_PASSWORD_MAX_ATTEMPTS * 8;
    const burstStartMs: number = Date.now();
    const bodyEncoder: TextEncoder = new TextEncoder();
    const bodyControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    installTelegramSendMessageStub();
    // 全部请求在调用时同步越过中间件锁定闸门、停在读取请求体处；请求体由测试按序放行。
    const pending: Promise<Response>[] = [];
    for (let index: number = 0; index < burstSize; index++) {
      pending.push(
        handleMiniAppHttpRequest(
          new Request("http://127.0.0.1:3000/api/auth/login", {
            method: "POST",
            headers: {
              [MINI_APP_INIT_DATA_HEADER]: adminInitData,
              "Content-Type": "application/json",
            },
            body: new ReadableStream<Uint8Array>({
              start(controller: ReadableStreamDefaultController<Uint8Array>): void {
                bodyControllers.push(controller);
              },
            }),
          })
        )
      );
    }
    for (let index: number = 0; index < burstSize - 1; index++) {
      bodyControllers[index]?.enqueue(
        bodyEncoder.encode(JSON.stringify({ password: `bad-password-${index}` }))
      );
      bodyControllers[index]?.close();
    }
    await Promise.allSettled(pending.slice(0, burstSize - 1));
    // 错误密码全部结算、锁定已生效后才放行最后一个请求的正确密码。
    bodyControllers[burstSize - 1]?.enqueue(
      bodyEncoder.encode(JSON.stringify({ password: getBotMiniAppConfig()!.password }))
    );
    bodyControllers[burstSize - 1]?.close();
    const settled: PromiseSettledResult<Response>[] = await Promise.allSettled(pending);
    const codes: string[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value.status).toBe(403);
      codes.push(((await result.value.json()) as MiniAppAccessDiagnostics).code);
    }

    expect(codes.filter((code: string): boolean => code === "INVALID_PASSWORD").length).toBe(
      MINI_APP_PASSWORD_MAX_ATTEMPTS - 1
    );
    expect(codes.filter((code: string): boolean => code === "PASSWORD_LOCKED").length).toBe(
      burstSize - (MINI_APP_PASSWORD_MAX_ATTEMPTS - 1)
    );
    expect(codes[burstSize - 1]).toBe("PASSWORD_LOCKED");
    expect(miniAppAuthSessions.size).toBe(0);
    expect(miniAppPasswordGuardHolder.current?.failedAttempts).toBe(burstSize);
    expect(miniAppPasswordGuardHolder.current?.lockedUntil ?? 0).toBeGreaterThanOrEqual(
      burstStartMs + MINI_APP_PASSWORD_LOCKOUT_MS
    );
    expect(sendMessageStub).toHaveBeenCalledTimes(1);
  });

  test("GET /api/status 返回实时状态快照", async () => {
    const state = getOrCreateChatState(-1001001);
    state.isInitEnabled = true;
    state.title = "测试受管群";

    const res: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: superAdminHeaders(),
      })
    );
    expect(res.status).toBe(200);
    const body: MiniAppStatusView = (await res.json()) as MiniAppStatusView;
    expect(body.managedChatCount).toBe(1);
    expect(body.whitelistCount).toBe(0);
    expect(body.blocklistCount).toBe(0);
    expect(body.memoryTotalBytes).toBeGreaterThan(0);
    expect(body.memoryOtherBytes).toBeGreaterThanOrEqual(0);
    expect(body.memoryCurrentRssBytes + body.memoryOtherBytes).toBeLessThanOrEqual(
      body.memoryTotalBytes
    );
    expect(Array.isArray(body.capabilities)).toBeTrue();
    expect(body.capabilities.length).toBe(6);
    expect(body.capabilities[0]?.key).toBe("agent");
    expect(body.capabilities[0]?.label).toBe("Agent 能力");
    expect(Array.isArray(body.capabilities[0]?.items)).toBeTrue();

    const moodRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/mood", {
        headers: superAdminHeaders(),
      })
    );
    expect(moodRes.status).toBe(200);
    const moodBody = (await moodRes.json()) as {
      readonly ok: boolean;
      readonly available: boolean;
      readonly currentMood: string | null;
    };
    expect(moodBody.ok).toBeTrue();

    const switchRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/mood/switch", {
        method: "POST",
        headers: superAdminHeaders(),
      })
    );
    expect([200, 400, 503]).toContain(switchRes.status);
  });

  test("GET /api/chats 仅列出已执行 /init 的群，支持详细状态查看与各项功能开关切换（含关闭 /init）", async () => {
    const stateA = getOrCreateChatState(-1002001);
    stateA.isInitEnabled = true;
    stateA.title = "已初始化群 A";
    stateA.isFloodControlEnabled = true;

    const stateB = getOrCreateChatState(-1002002);
    stateB.isInitEnabled = false;
    stateB.title = "未初始化群 B";

    const listRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/chats", {
        headers: superAdminHeaders(),
      })
    );
    expect(listRes.status).toBe(200);
    const listBody: { readonly items: readonly MiniAppChatSummary[] } =
      (await listRes.json()) as { readonly items: readonly MiniAppChatSummary[] };
    expect(listBody.items.map((item) => item.chatId)).toEqual([-1002001]);
    expect(listBody.items[0]?.title).toBe("已初始化群 A");

    const detailRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/chats/-1002001", {
        headers: superAdminHeaders(),
      })
    );
    expect(detailRes.status).toBe(200);
    const detailBody: { readonly detail: MiniAppChatDetail } =
      (await detailRes.json()) as { readonly detail: MiniAppChatDetail };
    expect(detailBody.detail.features.init).toBeTrue();
    expect(detailBody.detail.features.floodControl).toBeTrue();
    expect(detailBody.detail.features.proxySend).toBeFalse();

    for (const [feature, enabled] of [
      ["proxySend", true],
      ["proxySend", false],
      ["floodControl", false],
      ["antiRaid", true],
      ["antiRaid", false],
      ["aiChat", false],
      ["translation", false],
      ["adDetect", false],
      ["init", true],
    ] as const) {
      const toggleRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/chats/-1002001/feature", {
          method: "POST",
          headers: {
            ...superAdminHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ feature, enabled }),
        })
      );
      expect(toggleRes.status).toBe(200);
      const toggleBody: MiniAppFeatureToggleResult =
        (await toggleRes.json()) as MiniAppFeatureToggleResult;
      expect(toggleBody.ok).toBeTrue();
    }

    const disableInitRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/chats/-1002001/feature", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ feature: "init", enabled: false }),
      })
    );
    expect(disableInitRes.status).toBe(200);
    const disableInitBody: MiniAppFeatureToggleResult =
      (await disableInitRes.json()) as MiniAppFeatureToggleResult;
    expect(disableInitBody.removedFromList).toBeTrue();
    expect(disableInitBody.detail).toBeNull();
  });

  test("GET /api/chats/:chatId/messages 仅返回热 256 条发言记录并支持分页，不暴露压缩记忆", async () => {
    const chatId: number = -1003001;
    const state = getOrCreateChatState(chatId);
    state.isInitEnabled = true;
    state.title = "发言记录测试群";

    const messages = Array.from({ length: AI_MEMORY_HYDRATE_BUFFER_MAX }, (_, idx) => ({
      id: 1000 + idx,
      firstName: `User${idx}`,
      lastName: "",
      username: `u_${idx}`,
      text: `hot message #${idx}`,
      at: "2026/10/25 00:00:00",
      messageId: 5000 + idx,
    }));
    latestAiMemories.set(
      chatId,
      JSON.stringify({
        version: 1,
        summaries: ["SECRET_COMPRESSED_SUMMARY_ROUND_1"],
        pendingSummary: "SECRET_PENDING_SUMMARY_MESSAGE",
        buffer: messages,
        savedAt: 1_700_000_000_000,
      })
    );

    const resPage1: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/chats/${chatId}/messages?page=1&pageSize=${MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE}`,
        { headers: superAdminHeaders() }
      )
    );
    expect(resPage1.status).toBe(200);
    const rawJson: string = await resPage1.text();
    expect(rawJson).not.toContain("SECRET_COMPRESSED_SUMMARY_ROUND_1");
    expect(rawJson).not.toContain("SECRET_PENDING_SUMMARY_MESSAGE");

    const page1: MiniAppMessagePage = JSON.parse(rawJson) as MiniAppMessagePage;
    expect(page1.total).toBe(AI_MEMORY_HYDRATE_BUFFER_MAX);
    expect(page1.maxCapacity).toBe(VERBATIM_CONTEXT_MAX);
    expect(page1.items.length).toBe(MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE);
    expect(page1.totalPages).toBe(
      Math.ceil(AI_MEMORY_HYDRATE_BUFFER_MAX / MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE)
    );
    expect(page1.items[0]?.text).toBe(`hot message #${AI_MEMORY_HYDRATE_BUFFER_MAX - 1}`);
  });

  test("白名单、权限列表与黑名单 API 支持增删、重复添加拦截、按名称/ID 搜索与开关控制", async () => {
    const addWhiteRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 88001, enabled: true }),
      })
    );
    expect(addWhiteRes.status).toBe(200);
    expect(addWhiteRes.headers.get("Content-Security-Policy")).toBe(
      MINI_APP_CSP_HEADER_VALUE
    );
    expect(addWhiteRes.headers.get("X-Frame-Options")).toBe(
      MINI_APP_X_FRAME_OPTIONS_VALUE
    );
    const addWhiteBody: MiniAppIdentityMutationResult =
      (await addWhiteRes.json()) as MiniAppIdentityMutationResult;
    expect(addWhiteBody.ok).toBeTrue();
    expect(addWhiteBody.changed).toBeTrue();
    expect(addWhiteBody.duplicate).toBeFalse();

    const dupWhiteRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 88001, enabled: true }),
      })
    );
    expect(dupWhiteRes.status).toBe(200);
    const dupWhiteBody: MiniAppIdentityMutationResult =
      (await dupWhiteRes.json()) as MiniAppIdentityMutationResult;
    expect(dupWhiteBody.ok).toBeTrue();
    expect(dupWhiteBody.changed).toBeFalse();
    expect(dupWhiteBody.duplicate).toBeTrue();

    const listWhiteRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist?page=1&pageSize=20", {
        headers: superAdminHeaders(),
      })
    );
    expect(listWhiteRes.status).toBe(200);
    const listWhiteBody: MiniAppWhitelistPage =
      (await listWhiteRes.json()) as MiniAppWhitelistPage;
    expect(listWhiteBody.items.map((item) => item.id)).toEqual([88001]);
    expect(listWhiteBody.total).toBe(1);
    expect(listWhiteBody.page).toBe(1);
    expect(listWhiteBody.totalPages).toBe(1);
    expect(listWhiteBody.whitelistTotal).toBe(1);
    expect(listWhiteBody.blocklistTotal).toBe(0);

    const searchWhiteHitRes: Response = await handleMiniAppHttpRequest(
      new Request(
        "http://127.0.0.1:3000/api/identities/whitelist?page=1&pageSize=20&query=88001",
        { headers: superAdminHeaders() }
      )
    );
    expect(searchWhiteHitRes.status).toBe(200);
    const searchWhiteHitBody: MiniAppWhitelistPage =
      (await searchWhiteHitRes.json()) as MiniAppWhitelistPage;
    expect(searchWhiteHitBody.items.map((item) => item.id)).toEqual([88001]);

    const searchWhiteMissRes: Response = await handleMiniAppHttpRequest(
      new Request(
        "http://127.0.0.1:3000/api/identities/whitelist?page=1&pageSize=20&query=nonexistent_zako",
        { headers: superAdminHeaders() }
      )
    );
    expect(searchWhiteMissRes.status).toBe(200);
    const searchWhiteMissBody: MiniAppWhitelistPage =
      (await searchWhiteMissRes.json()) as MiniAppWhitelistPage;
    expect(searchWhiteMissBody.items).toEqual([]);
    expect(searchWhiteMissBody.total).toBe(0);

    const permRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/permission", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 88001, key: "isCanMute", value: true }),
      })
    );
    expect(permRes.status).toBe(200);
    expect(((await permRes.json()) as MiniAppIdentityMutationResult).ok).toBeTrue();

    const permAllRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/permission", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 88001, enableAll: true }),
      })
    );
    expect(permAllRes.status).toBe(200);
    expect(((await permAllRes.json()) as MiniAppIdentityMutationResult).ok).toBeTrue();

    const removeWhiteRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 88001, enabled: false }),
      })
    );
    expect(removeWhiteRes.status).toBe(200);

    const addBlockRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/blocklist", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 99002, enabled: true }),
      })
    );
    expect(addBlockRes.status).toBe(200);
    const addBlockBody: MiniAppIdentityMutationResult =
      (await addBlockRes.json()) as MiniAppIdentityMutationResult;
    expect(addBlockBody.ok).toBeTrue();
    expect(addBlockBody.changed).toBeTrue();
    expect(addBlockBody.duplicate).toBeFalse();

    const dupBlockRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/blocklist", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 99002, enabled: true }),
      })
    );
    expect(dupBlockRes.status).toBe(200);
    const dupBlockBody: MiniAppIdentityMutationResult =
      (await dupBlockRes.json()) as MiniAppIdentityMutationResult;
    expect(dupBlockBody.ok).toBeTrue();
    expect(dupBlockBody.changed).toBeFalse();
    expect(dupBlockBody.duplicate).toBeTrue();

    const listBlockRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/blocklist?page=1&pageSize=20", {
        headers: superAdminHeaders(),
      })
    );
    expect(listBlockRes.status).toBe(200);
    const listBlockBody: MiniAppBlocklistPage =
      (await listBlockRes.json()) as MiniAppBlocklistPage;
    expect(listBlockBody.items.map((item) => item.id)).toEqual([99002]);
    expect(listBlockBody.total).toBe(1);
    expect(listBlockBody.page).toBe(1);
    expect(listBlockBody.totalPages).toBe(1);
    expect(listBlockBody.whitelistTotal).toBe(0);
    expect(listBlockBody.blocklistTotal).toBe(1);

    const searchBlockHitRes: Response = await handleMiniAppHttpRequest(
      new Request(
        "http://127.0.0.1:3000/api/identities/blocklist?page=1&pageSize=20&query=99002",
        { headers: superAdminHeaders() }
      )
    );
    expect(searchBlockHitRes.status).toBe(200);
    const searchBlockHitBody: MiniAppBlocklistPage =
      (await searchBlockHitRes.json()) as MiniAppBlocklistPage;
    expect(searchBlockHitBody.items.map((item) => item.id)).toEqual([99002]);

    const removeBlockRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/identities/blocklist", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 99002, enabled: false }),
      })
    );
    expect(removeBlockRes.status).toBe(200);
  });

  test("TOTP 验证器支持在控制台生成二维码添加、修改、删除，并在启用时优先于密码登录", async () => {
    // 冻结时钟，生成与校验动态码不会跨越时间步边界。
    const stepMs: number = MINI_APP_TOTP_STEP_SECONDS * 1000;
    setSystemTime(new Date(Math.floor(Date.now() / stepMs) * stepMs + 1000));
    rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
    const headers: Record<string, string> = superAdminHeaders();
    const adminInitData: string = headers[MINI_APP_INIT_DATA_HEADER]!;

    const initialStatusRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/totp", { headers })
    );
    expect(initialStatusRes.status).toBe(200);
    const initialStatus: MiniAppTotpStatusView = (await initialStatusRes.json()) as MiniAppTotpStatusView;
    expect(initialStatus.enabled).toBeFalse();

    const setup1Res: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", { method: "POST", headers })
    );
    expect(setup1Res.status).toBe(200);
    const setup1: MiniAppTotpSetupResponse = (await setup1Res.json()) as MiniAppTotpSetupResponse;
    expect(setup1.ok).toBeTrue();
    expect(setup1.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup1.otpauthUri).toContain("otpauth://totp/");
    expect(setup1.qrSvg).toContain("<svg");

    const badEnableRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/totp/enable", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ code: "000000" }),
      })
    );
    if (generateMiniAppTotpCodeAt(setup1.secret) !== "000000") {
      expect(badEnableRes.status).toBe(400);
      expect(await Bun.file(MINI_APP_TOTP_FILE_PATH).exists()).toBeFalse();
    }

    const validCode1: string = generateMiniAppTotpCodeAt(setup1.secret);
    const enable1Res: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/totp/enable", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ code: validCode1 }),
      })
    );
    expect(enable1Res.status).toBe(200);
    const enable1Body: MiniAppTotpMutationResponse = (await enable1Res.json()) as MiniAppTotpMutationResponse;
    expect(enable1Body.ok).toBeTrue();
    expect(enable1Body.status.enabled).toBeTrue();
    expect(await Bun.file(MINI_APP_TOTP_FILE_PATH).exists()).toBeTrue();

    const precheckTotpRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/precheck", {
        headers: { [MINI_APP_INIT_DATA_HEADER]: adminInitData },
      })
    );
    expect(await precheckTotpRes.json()).toEqual({
      ok: true,
      ttlMs: MINI_APP_SESSION_TTL_MS,
      totpEnabled: true,
      authMode: "totp",
    });

    const passwordRejectedWhenTotpEnabled: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { [MINI_APP_INIT_DATA_HEADER]: adminInitData, "Content-Type": "application/json" },
        body: JSON.stringify({ password: getBotMiniAppConfig()!.password }),
      })
    );
    expect(passwordRejectedWhenTotpEnabled.status).toBe(403);
    expect(((await passwordRejectedWhenTotpEnabled.json()) as MiniAppAccessDiagnostics).code).toBe("INVALID_TOTP_CODE");

    const totpLoginRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { [MINI_APP_INIT_DATA_HEADER]: adminInitData, "Content-Type": "application/json" },
        body: JSON.stringify({ totpCode: generateMiniAppTotpCodeAt(setup1.secret) }),
      })
    );
    expect(totpLoginRes.status).toBe(200);
    const totpLoginBody: MiniAppLoginSuccessResponse = (await totpLoginRes.json()) as MiniAppLoginSuccessResponse;
    expect(totpLoginBody.ok).toBeTrue();

    const setup2Res: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", { method: "POST", headers })
    );
    const setup2: MiniAppTotpSetupResponse = (await setup2Res.json()) as MiniAppTotpSetupResponse;
    expect(setup2.secret).not.toBe(setup1.secret);

    const enable2Res: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/totp/enable", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ code: generateMiniAppTotpCodeAt(setup2.secret) }),
      })
    );
    expect(enable2Res.status).toBe(200);
    const enable2Body: MiniAppTotpMutationResponse = (await enable2Res.json()) as MiniAppTotpMutationResponse;
    expect(enable2Body.status.enabled).toBeTrue();
    expect(enable2Body.status.createdAt).toBeGreaterThanOrEqual(enable1Body.status.createdAt ?? 0);

    const deleteRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/totp", { method: "DELETE", headers })
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody: MiniAppTotpMutationResponse = (await deleteRes.json()) as MiniAppTotpMutationResponse;
    expect(deleteBody.ok).toBeTrue();
    expect(deleteBody.status.enabled).toBeFalse();
    expect(await Bun.file(MINI_APP_TOTP_FILE_PATH).exists()).toBeFalse();

    const passwordRestoredLoginRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { [MINI_APP_INIT_DATA_HEADER]: adminInitData, "Content-Type": "application/json" },
        body: JSON.stringify({ password: getBotMiniAppConfig()!.password }),
      })
    );
    expect(passwordRestoredLoginRes.status).toBe(200);

    const setup3Res: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", { method: "POST", headers })
    );
    const setup3: MiniAppTotpSetupResponse = (await setup3Res.json()) as MiniAppTotpSetupResponse;
    const wrongCode: string =
      generateMiniAppTotpCodeAt(setup3.secret) === "000000" ? "111111" : "000000";
    for (let attempt: number = 1; attempt <= MINI_APP_PASSWORD_MAX_ATTEMPTS; attempt++) {
      const failEnableRes: Response = await handleMiniAppHttpRequest(
        new Request("http://127.0.0.1:3000/api/totp/enable", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ code: wrongCode }),
        })
      );
      expect(failEnableRes.status).toBe(400);
      expect(((await failEnableRes.json()) as MiniAppTotpMutationResponse).message).toBe(
        attempt < MINI_APP_PASSWORD_MAX_ATTEMPTS ? "INVALID_TOTP_CODE" : "TOTP_SETUP_EXPIRED"
      );
    }
  });
});
