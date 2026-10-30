import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  AiMemoryDeletedPersistedReply,
  DiskBusinessMessage,
  DomainFlushOutcome,
  IdentityPolicyPersistedRevision,
  IdentityStoragePersistedReply,
  JoinLogRecord,
} from "../../packages/types/diskIO";
import type {
  BlocklistIdPage,
  IdentityPolicyRawReadResult,
  WhitelistIdPage,
} from "../../packages/types/identityStorage";
import type {
  MiniAppBatchKickResult,
  MiniAppBlocklistPage,
  MiniAppChatDetail,
  MiniAppChatSummary,
  MiniAppChatTargetsMutationResult,
  MiniAppChatTargetsView,
  MiniAppFeatureToggleResult,
  MiniAppIdentityMutationResult,
  MiniAppMessagePage,
  MiniAppWhitelistPage,
} from "../../packages/types/miniApp";
import type { QaFieldRejection } from "../../packages/types/qa";
import type { InstalledTelegramApi, TelegramSentMessage } from "../../packages/types/telegramWorker";
import { botPermissions } from "../helpers/botPermissions";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import { buildSignedTestInitData } from "../helpers/miniAppInitData";

const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
const aiMemoryDeletedListeners: ((reply: AiMemoryDeletedPersistedReply) => void)[] = [];
const whitelistDbRows: Map<number, string> = new Map<number, string>();
const blocklistDbRows: Map<number, string> = new Map<number, string>();
let joinLogRecordsHolder: readonly JoinLogRecord[] = [];
let joinLogShouldThrow: boolean = false;

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
    readJoinLog: async (params: {
      readonly chatId: number;
      readonly since: number;
      readonly now: number;
    }): Promise<readonly JoinLogRecord[]> => {
      if (joinLogShouldThrow) {
        throw new Error("join log unavailable");
      }
      return joinLogRecordsHolder.filter(
        (record: JoinLogRecord): boolean =>
          record.joinedAt >= params.since && record.joinedAt <= params.now
      );
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
        .filter((id: number): boolean => afterId === null || id > afterId)
        .sort((a: number, b: number): number => a - b);
      return {
        ids: sortedIds,
        nextCursor:
          sortedIds.length === 0 ? afterId : sortedIds[sortedIds.length - 1]!,
        done: true,
      };
    },
    readBlocklistIdPage: async (afterId: number | null): Promise<BlocklistIdPage> => {
      const sortedIds: number[] = [...blocklistDbRows.keys()]
        .filter((id: number): boolean => afterId === null || id > afterId)
        .sort((a: number, b: number): number => a - b);
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
const { chatIsSupergroupById } = await import("../../packages/cache/main/antiRaid/chatKind");
const {
  batchKickChats,
  miniAppBatchKickCompletedByChat,
} = await import("../../packages/cache/main/batchKick");
const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { resetIdentityStorageCache } = await import(
  "../../packages/cache/main/identityStorage"
);
const { miniAppAuthSessions } = await import("../../packages/cache/main/miniApp");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const { startBatchKickTask } = await import("../../packages/commands/batchKick");
const {
  drainDeferredCommandRuntime,
  initDeferredCommandRuntime,
} = await import("../../packages/commands/deferredCommands");
const {
  answerRejectionOf,
  questionRejectionOf,
} = await import("../../packages/commands/qa/fieldRules");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { AI_MEMORY_HYDRATE_BUFFER_MAX, VERBATIM_CONTEXT_MAX } = await import(
  "../../packages/consts/aiChat/memory"
);
const { BOT_CHAT_PERMISSION_LABELS } = await import("../../packages/consts/botAdmin");
const {
  MINI_APP_CSP_HEADER_VALUE,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
  MINI_APP_SESSION_HEADER,
  MINI_APP_X_FRAME_OPTIONS_VALUE,
} = await import("../../packages/consts/miniApp");
const {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_QUESTION_MAX_CHARS,
} = await import("../../packages/consts/qa");
const { getOrCreateChatState } = await import("../../packages/infra/storage/stateStore");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { dispatchMiniAppTestRequest: handleMiniAppHttpRequest } = await import(
  "../helpers/miniAppRequest"
);

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
  await drainDeferredCommandRuntime(1_000);
  await stopMiniAppServer();
  diskMessages.length = 0;
  whitelistDbRows.clear();
  blocklistDbRows.clear();
  batchKickChats.clear();
  chatIsSupergroupById.clear();
  miniAppBatchKickCompletedByChat.clear();
  joinLogRecordsHolder = [];
  joinLogShouldThrow = false;
  resetIdentityStorageCache();
  resetChatStateCache();
  latestAiMemories.clear();
  miniAppAuthSessions.clear();
  telegramApiState.current = null;
});

describe("Mini App 受管群与黑白名单路由", () => {
  test("GET /api/chats 仅列出已执行 /init 的群，支持详细状态查看（含拥有权限与 1..24 小时各时间窗口进群人数）与各项功能开关切换", async () => {
    const nowMs: number = Date.now();
    joinLogRecordsHolder = [
      { userId: 5001, joinedAt: nowMs - 2 * 3_600_000 - 1_000 },
      { userId: 5002, joinedAt: nowMs - 500 },
    ];

    const stateA = getOrCreateChatState(-1002001);
    stateA.isInitEnabled = true;
    stateA.title = "已初始化群 A";
    stateA.isFloodControlEnabled = true;
    stateA.botPermissions = botPermissions({ canDeleteMessages: true });

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
    expect(listBody.items.map((item: MiniAppChatSummary): number => item.chatId)).toEqual([-1002001]);
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
    expect(detailBody.detail.joinedCountsByHour[0]).toBe(1);
    expect(detailBody.detail.joinedCountsByHour[1]).toBe(1);
    expect(detailBody.detail.joinedCountsByHour[2]).toBe(2);
    expect(detailBody.detail.joinedCountsByHour[23]).toBe(2);
    expect(detailBody.detail.batchKickRunning).toBeFalse();
    expect(detailBody.detail.botPermissions?.grantedLabels).toEqual([
      BOT_CHAT_PERMISSION_LABELS.isAdministrator,
      BOT_CHAT_PERMISSION_LABELS.canManageChat,
      BOT_CHAT_PERMISSION_LABELS.canDeleteMessages,
    ]);

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

  test("POST /api/chats/:chatId/batch-kick 校验超级群身份、1–24 小时参数、并发锁、空记录与入群日志读取，接纳后复用 /batch_kick 后台清理", async () => {
    const chatId: number = -1002099;
    const uninitRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 6 }),
      })
    );
    expect(uninitRes.status).toBe(404);
    expect(((await uninitRes.json()) as MiniAppBatchKickResult).message).toBe(
      "CHAT_NOT_INITIALIZED"
    );

    const state = getOrCreateChatState(chatId);
    state.isInitEnabled = true;
    state.title = "清理测试群";

    for (const invalidBody of [
      "{}",
      JSON.stringify({ hours: 0 }),
      JSON.stringify({ hours: 25 }),
      JSON.stringify({ hours: 1.5 }),
      "not-json",
    ]) {
      const badRes: Response = await handleMiniAppHttpRequest(
        new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: invalidBody,
        })
      );
      expect(badRes.status).toBe(400);
      expect(((await badRes.json()) as { readonly error: string }).error).toBe(
        "INVALID_BATCH_KICK_PARAMS"
      );
    }

    // 1. chatIsSupergroupById 为 false（普通群）时直接拒绝，不读入群日志（joinLogShouldThrow = true 仅由 getManagedChatDetail 吞掉）。
    chatIsSupergroupById.set(chatId, false);
    joinLogRecordsHolder = [{ userId: 7999, joinedAt: Date.now() - 10_000 }];
    const cachedBasicRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 3 }),
      })
    );
    expect(cachedBasicRes.status).toBe(200);
    const cachedBasicBody: MiniAppBatchKickResult =
      (await cachedBasicRes.json()) as MiniAppBatchKickResult;
    expect(cachedBasicBody.ok).toBeFalse();
    expect(cachedBasicBody.outcome).toBe("notSupergroup");
    expect(cachedBasicBody.message).toBe("CHAT_NOT_SUPERGROUP");
    expect(cachedBasicBody.recordCount).toBe(0);

    // 2. 缓存缺失且 getChat 抛错时返回 unavailable（HTTP 503）。
    chatIsSupergroupById.delete(chatId);
    telegramApiState.current = {
      getChat: async (): Promise<unknown> => {
        throw new Error("Telegram getChat network failure");
      },
    } as unknown as InstalledTelegramApi;
    const chatKindUnavailableRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 3 }),
      })
    );
    expect(chatKindUnavailableRes.status).toBe(503);
    const chatKindUnavailableBody: MiniAppBatchKickResult =
      (await chatKindUnavailableRes.json()) as MiniAppBatchKickResult;
    expect(chatKindUnavailableBody.ok).toBeFalse();
    expect(chatKindUnavailableBody.outcome).toBe("unavailable");
    expect(chatKindUnavailableBody.message).toBe("CHAT_KIND_UNAVAILABLE");
    expect(chatIsSupergroupById.has(chatId)).toBeFalse();

    // 3. 缓存缺失且 getChat 返回 group 时拒绝并写入缓存 false。
    telegramApiState.current = {
      getChat: async (cId: number): Promise<unknown> => ({
        id: cId,
        type: "group",
        title: "普通群",
      }),
    } as unknown as InstalledTelegramApi;
    const probedBasicRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 3 }),
      })
    );
    expect(probedBasicRes.status).toBe(200);
    const probedBasicBody: MiniAppBatchKickResult =
      (await probedBasicRes.json()) as MiniAppBatchKickResult;
    expect(probedBasicBody.ok).toBeFalse();
    expect(probedBasicBody.outcome).toBe("notSupergroup");
    expect(probedBasicBody.message).toBe("CHAT_NOT_SUPERGROUP");
    expect(chatIsSupergroupById.get(chatId)).toBeFalse();

    // 4. 确认为 supergroup 时正常读取入群日志并受理。
    chatIsSupergroupById.delete(chatId);
    telegramApiState.current = {
      getChat: async (cId: number): Promise<unknown> => ({
        id: cId,
        type: "supergroup",
        title: "超级群",
      }),
    } as unknown as InstalledTelegramApi;

    joinLogShouldThrow = true;
    const unavailableRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 3 }),
      })
    );
    expect(unavailableRes.status).toBe(503);
    expect(((await unavailableRes.json()) as MiniAppBatchKickResult).message).toBe(
      "JOIN_LOG_UNAVAILABLE"
    );
    expect(chatIsSupergroupById.get(chatId)).toBeTrue();
    joinLogShouldThrow = false;

    joinLogRecordsHolder = [];
    const emptyRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 3 }),
      })
    );
    expect(emptyRes.status).toBe(200);
    const emptyBody: MiniAppBatchKickResult = (await emptyRes.json()) as MiniAppBatchKickResult;
    expect(emptyBody.outcome).toBe("empty");
    expect(emptyBody.message).toBe("BATCH_KICK_EMPTY");
    expect(emptyBody.recordCount).toBe(0);

    batchKickChats.add(chatId);
    const runningRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 3 }),
      })
    );
    expect(runningRes.status).toBe(200);
    const runningBody: MiniAppBatchKickResult = (await runningRes.json()) as MiniAppBatchKickResult;
    expect(runningBody.outcome).toBe("running");
    expect(runningBody.message).toBe("BATCH_KICK_RUNNING");
    expect(runningBody.detail?.batchKickRunning).toBeTrue();
    batchKickChats.delete(chatId);

    const bannedUsers: number[] = [];
    const unbannedUsers: number[] = [];
    telegramApiState.current = {
      getChatMember: async (_cId: number, userId: number): Promise<unknown> => ({
        status: "member",
        user: { id: userId, is_bot: false, first_name: "U" },
      }),
      banChatMember: async (_cId: number, userId: number): Promise<boolean> => {
        bannedUsers.push(userId);
        return true;
      },
      unbanChatMember: async (_cId: number, userId: number): Promise<boolean> => {
        unbannedUsers.push(userId);
        return true;
      },
      sendMessage: async (): Promise<TelegramSentMessage> => ({ message_id: 1 }),
      deleteMessage: async (): Promise<boolean> => true,
    } as unknown as InstalledTelegramApi;

    const nowMs: number = Date.now();
    joinLogRecordsHolder = [
      { userId: 7001, joinedAt: nowMs - 60_000 },
      { userId: 7002, joinedAt: nowMs - 30_000 },
    ];

    const busyRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 2 }),
      })
    );
    expect(busyRes.status).toBe(200);
    const busyBody: MiniAppBatchKickResult = (await busyRes.json()) as MiniAppBatchKickResult;
    expect(busyBody.outcome).toBe("busy");
    expect(busyBody.message).toBe("BATCH_KICK_BUSY");

    initDeferredCommandRuntime();
    const acceptedRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/batch-kick`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 2 }),
      })
    );
    expect(acceptedRes.status).toBe(200);
    const acceptedBody: MiniAppBatchKickResult =
      (await acceptedRes.json()) as MiniAppBatchKickResult;
    expect(acceptedBody.outcome).toBe("accepted");
    expect(acceptedBody.message).toBe("BATCH_KICK_ACCEPTED");
    expect(acceptedBody.hours).toBe(2);
    expect(acceptedBody.recordCount).toBe(2);

    for (let turn: number = 0; turn < 20 && batchKickChats.has(chatId); turn += 1) {
      await Bun.sleep(10);
    }
    expect(bannedUsers).toEqual([]);
    expect(unbannedUsers).toEqual([7001, 7002]);
    expect(miniAppBatchKickCompletedByChat.get(chatId)?.kicked).toBe(2);

    const afterApiDetailRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}`, {
        headers: superAdminHeaders(),
      })
    );
    const afterApiDetail: { readonly detail: MiniAppChatDetail } =
      (await afterApiDetailRes.json()) as { readonly detail: MiniAppChatDetail };
    expect(afterApiDetail.detail.batchKickRunning).toBeFalse();
    expect(afterApiDetail.detail.lastBatchKickCompletion?.kicked).toBe(2);
    expect(afterApiDetail.detail.lastBatchKickCompletion?.hours).toBe(2);
    expect(afterApiDetail.detail.lastBatchKickCompletion?.recordCount).toBe(2);

    // 群内 `/batch_kick` 命令触发（source: "command"）共享每群单飞锁，但完成后不触发 API 完成回调。
    miniAppBatchKickCompletedByChat.delete(chatId);
    expect(
      startBatchKickTask({
        chatId,
        source: "command",
        durationMs: 3_600_000,
        records: [{ userId: 7003, joinedAt: nowMs - 10_000 }],
      })
    ).toBeTrue();
    for (let turn: number = 0; turn < 20 && batchKickChats.has(chatId); turn += 1) {
      await Bun.sleep(10);
    }
    expect(miniAppBatchKickCompletedByChat.has(chatId)).toBeFalse();
  });

  test("GET /api/chats/:chatId/messages 仅返回热 256 条发言记录并支持分页，不暴露压缩记忆", async () => {
    const chatId: number = -1003001;
    const state = getOrCreateChatState(chatId);
    state.isInitEnabled = true;
    state.title = "发言记录测试群";

    const messages = Array.from({ length: AI_MEMORY_HYDRATE_BUFFER_MAX }, (_, idx: number) => ({
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

  test("GET|POST /api/chats/:chatId/targets 支持问答对、追着删目标与追着翻目标的查询、新增、修改与删除", async () => {
    const chatId: number = -1004001;
    const uninitRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        headers: superAdminHeaders(),
      })
    );
    expect(uninitRes.status).toBe(404);

    const state = getOrCreateChatState(chatId);
    state.isInitEnabled = true;
    state.isTranslationEnabled = true;
    state.title = "目标管理测试群";
    state.botPermissions = botPermissions({ canDeleteMessages: true });

    const getEmptyRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        headers: superAdminHeaders(),
      })
    );
    expect(getEmptyRes.status).toBe(200);
    const emptyBody: { readonly targets: MiniAppChatTargetsView } =
      (await getEmptyRes.json()) as { readonly targets: MiniAppChatTargetsView };
    expect(emptyBody.targets.qaItems).toEqual([]);
    expect(emptyBody.targets.deleteMessageTargets).toEqual([]);
    expect(emptyBody.targets.translateTargets).toEqual([]);

    const setQaRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setQa", q: "早安", a: "早安杂鱼♡" }),
      })
    );
    expect(setQaRes.status).toBe(200);
    const setQaBody: MiniAppChatTargetsMutationResult =
      (await setQaRes.json()) as MiniAppChatTargetsMutationResult;
    expect(setQaBody.ok).toBeTrue();
    expect(setQaBody.message).toBe("QA_ADDED");
    expect(setQaBody.targets?.qaItems).toEqual([{ q: "早安", a: "早安杂鱼♡" }]);
    expect(setQaBody.detail?.qaPairCount).toBe(1);

    const removeQaRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "removeQa", q: "早安" }),
      })
    );
    expect(removeQaRes.status).toBe(200);
    const removeQaBody: MiniAppChatTargetsMutationResult =
      (await removeQaRes.json()) as MiniAppChatTargetsMutationResult;
    expect(removeQaBody.ok).toBeTrue();
    expect(removeQaBody.message).toBe("QA_REMOVED");
    expect(removeQaBody.targets?.qaItems).toEqual([]);

    // Mini App setQa 与群内表单共用 questionRejectionOf / answerRejectionOf：
    // 对超长、问题含命令、答案围栏外含命令、两项同时非法及答案围栏内含命令给出对应结论。
    const qaRejectionCases: readonly (readonly [string, string, QaFieldRejection, string])[] = [
      ["q".repeat(CHAT_QA_QUESTION_MAX_CHARS + 1), "正常答案", "questionTooLong", "QA_QUESTION_TOO_LONG"],
      ["请执行 /ban 命令", "正常答案", "questionHasCommand", "QA_COMMAND_IN_QUESTION"],
      ["正常问题", "a".repeat(CHAT_QA_ANSWER_MAX_CHARS + 1), "answerTooLong", "QA_ANSWER_TOO_LONG"],
      ["正常问题", "先试试 /kick 别人", "answerHasCommand", "QA_COMMAND_IN_ANSWER"],
      ["问题含 /ban 命令", "a".repeat(CHAT_QA_ANSWER_MAX_CHARS + 1), "questionHasCommand", "QA_COMMAND_IN_QUESTION"],
    ];
    for (const [qText, aText, expectedRuleRejection, expectedApiMessage] of qaRejectionCases) {
      expect(questionRejectionOf(qText) ?? answerRejectionOf(aText)).toBe(expectedRuleRejection);
      const rejectRes: Response = await handleMiniAppHttpRequest(
        new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
          method: "POST",
          headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ action: "setQa", q: qText, a: aText }),
        })
      );
      expect(rejectRes.status).toBe(200);
      const rejectBody: MiniAppChatTargetsMutationResult =
        (await rejectRes.json()) as MiniAppChatTargetsMutationResult;
      expect(rejectBody.ok).toBeFalse();
      expect(rejectBody.message).toBe(expectedApiMessage);
    }

    const fencedAnswer: string = "示例用法：\n```\n/kick @user\n```\n说明完毕";
    expect(questionRejectionOf("围栏示例") ?? answerRejectionOf(fencedAnswer)).toBeNull();
    const fencedQaRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setQa", q: "围栏示例", a: fencedAnswer }),
      })
    );
    expect(fencedQaRes.status).toBe(200);
    const fencedQaBody: MiniAppChatTargetsMutationResult =
      (await fencedQaRes.json()) as MiniAppChatTargetsMutationResult;
    expect(fencedQaBody.ok).toBeTrue();
    expect(fencedQaBody.message).toBe("QA_ADDED");
    await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "removeQa", q: "围栏示例" }),
      })
    );

    const addDelRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "addDeleteTarget", target: "77001" }),
      })
    );
    expect(addDelRes.status).toBe(200);
    const addDelBody: MiniAppChatTargetsMutationResult =
      (await addDelRes.json()) as MiniAppChatTargetsMutationResult;
    expect(addDelBody.ok).toBeTrue();
    expect(addDelBody.message).toBe("DELETE_TARGET_ADDED");
    expect(addDelBody.targets?.deleteMessageTargets.map((i) => i.id)).toEqual([77001]);
    expect(addDelBody.detail?.deleteMessageTargetCount).toBe(1);

    const remDelRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "removeDeleteTarget", id: 77001 }),
      })
    );
    expect(remDelRes.status).toBe(200);
    const remDelBody: MiniAppChatTargetsMutationResult =
      (await remDelRes.json()) as MiniAppChatTargetsMutationResult;
    expect(remDelBody.ok).toBeTrue();
    expect(remDelBody.message).toBe("DELETE_TARGET_REMOVED");
    expect(remDelBody.targets?.deleteMessageTargets).toEqual([]);

    const addTransRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "addTranslateTarget",
          target: "77002",
          language: "ja",
        }),
      })
    );
    expect(addTransRes.status).toBe(200);
    const addTransBody: MiniAppChatTargetsMutationResult =
      (await addTransRes.json()) as MiniAppChatTargetsMutationResult;
    expect(addTransBody.ok).toBeTrue();
    expect(addTransBody.message).toBe("TRANSLATE_TARGET_ADDED");
    expect(addTransBody.targets?.translateTargets[0]?.id).toBe(77002);
    expect(addTransBody.targets?.translateTargets[0]?.language).toBe("ja");
    expect(addTransBody.detail?.translateTargetCount).toBe(1);

    const remTransRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/chats/${chatId}/targets`, {
        method: "POST",
        headers: { ...superAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "removeTranslateTarget", id: 77002 }),
      })
    );
    expect(remTransRes.status).toBe(200);
    const remTransBody: MiniAppChatTargetsMutationResult =
      (await remTransRes.json()) as MiniAppChatTargetsMutationResult;
    expect(remTransBody.ok).toBeTrue();
    expect(remTransBody.message).toBe("TRANSLATE_TARGET_REMOVED");
    expect(remTransBody.targets?.translateTargets).toEqual([]);
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
});
