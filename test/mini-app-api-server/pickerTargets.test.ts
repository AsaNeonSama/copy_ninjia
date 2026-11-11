/**
 * Mini App 原生选择器写入群目标（追着删、追着翻）的预备拒绝与导入归类，以及权限、选择器路由的参数校验。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import type { MiniAppTranslateLanguage } from "../../packages/types/miniApp/chats";
import type {
  MiniAppPickerResultEvent,
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
} from "../../packages/types/miniApp/identities";
import { botPermissions } from "../helpers/botPermissions";
import {
  buildSignedTestInitData,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { translateConfigReadinessCache } = await import("../../packages/cache/main/configReadiness");
const { miniAppAuthSessions } = await import("../../packages/cache/main/miniApp");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
} = await import("../../packages/consts/miniApp");
const { getChatState, getOrCreateChatState } = await import(
  "../../packages/infra/chatStateStorage"
);
const {
  handleMiniAppSharedMessage,
  issueMiniAppAuthSession,
  prepareMiniAppPicker,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { dispatchMiniAppTestRequest } = await import("../helpers/miniAppRequest");

/** 夹具群 ID。 */
const CHAT_ID: number = -1_009_500_001;

/**
 * 构造超级管理员的签名与密码会话请求头。
 * @returns 请求头。
 */
function superAdminHeaders(): Record<string, string> {
  const initData: string = buildSignedTestInitData({
    botToken: BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1000),
    user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin" },
  });
  return {
    [MINI_APP_INIT_DATA_HEADER]: initData,
    [MINI_APP_SESSION_HEADER]: issueMiniAppAuthSession().token,
    "Content-Type": "application/json",
  };
}

/**
 * 以超级管理员身份发一条 JSON 请求，返回状态码与错误码。
 * @param path 请求路径（含查询串）。
 * @param body 请求体；省略时发 GET。
 * @returns 状态码与响应体里的 `error` 字段。
 */
async function requestError(
  path: string,
  body?: unknown
): Promise<{ readonly status: number; readonly error: unknown }> {
  const response: Response = await dispatchMiniAppTestRequest(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: superAdminHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
  const parsed: { readonly error?: unknown } = (await response.json()) as { readonly error?: unknown };
  return { status: response.status, error: parsed.error };
}

/**
 * 为指定名单预备一个选择器会话。
 * @param targetList 目标名单。
 * @param subjectKind 选择器身份种类。
 * @param options 可选目标群与语言。
 * @returns 会话请求 ID。
 */
async function preparePicker(
  targetList: MiniAppPickerTargetList,
  subjectKind: MiniAppPickerSubjectKind,
  options: { readonly chatId?: number; readonly language?: MiniAppTranslateLanguage } = {}
): Promise<number> {
  const prepared = await prepareMiniAppPicker({
    targetList,
    subjectKind,
    ...options,
    api: { savePreparedKeyboardButton: async () => ({ id: `prep-${targetList}-${subjectKind}` }) },
  });
  if (!prepared.ok) throw new Error(`expected prepared picker, got ${prepared.message}`);
  return prepared.requestId;
}

/**
 * 构造超级管理员私聊里的 `users_shared` 服务消息。
 * @param requestId 选择器会话请求 ID。
 * @param userIds 共享的用户 ID。
 * @returns 服务消息。
 */
function usersShared(requestId: number, userIds: readonly number[]): Message {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: SUPER_ADMIN_USER_ID, type: "private", first_name: "Admin" },
    from: { id: SUPER_ADMIN_USER_ID, is_bot: false, first_name: "Admin" },
    users_shared: {
      request_id: requestId,
      users: userIds.map((userId: number) => ({ user_id: userId, first_name: "" })),
    },
  };
}

/**
 * 构造超级管理员私聊里的 `chat_shared` 服务消息。
 * @param requestId 选择器会话请求 ID。
 * @param chatId 共享的会话 ID。
 * @returns 服务消息。
 */
function chatShared(requestId: number, chatId: number): Message {
  return {
    message_id: 2,
    date: 1_700_000_000,
    chat: { id: SUPER_ADMIN_USER_ID, type: "private", first_name: "Admin" },
    from: { id: SUPER_ADMIN_USER_ID, is_bot: false, first_name: "Admin" },
    chat_shared: { request_id: requestId, chat_id: chatId },
  };
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  resetMiniAppTestDiskIOState();
  resetChatStateCache();
  miniAppAuthSessions.clear();
  translateConfigReadinessCache.current = { ok: true };
});

describe("Mini App 选择器写入群目标", () => {
  test("预备：追着删缺删消息权限、追着翻能力不可用或功能关闭时拒绝，按钮 ID 为空回 PICKER_PREPARE_FAILED", async () => {
    getOrCreateChatState(CHAT_ID).isInitEnabled = true;
    getOrCreateChatState(CHAT_ID).botPermissions = botPermissions({ canDeleteMessages: false });
    expect(await prepareMiniAppPicker({ targetList: "deleteMessage", subjectKind: "users", chatId: CHAT_ID }))
      .toEqual({ ok: false, message: "DELETE_TARGET_MISSING_BOT_PERMISSION" });

    translateConfigReadinessCache.current = { ok: false, failure: { file: "g-auth.json", reason: "fixture" } };
    expect(await prepareMiniAppPicker({ targetList: "translate", subjectKind: "users", chatId: CHAT_ID }))
      .toEqual({ ok: false, message: "TRANSLATE_CAPABILITY_UNAVAILABLE" });
    translateConfigReadinessCache.current = { ok: true };
    expect(await prepareMiniAppPicker({ targetList: "translate", subjectKind: "users", chatId: CHAT_ID }))
      .toEqual({ ok: false, message: "TRANSLATE_FEATURE_DISABLED" });

    expect(await prepareMiniAppPicker({
      targetList: "whitelist",
      subjectKind: "users",
      api: { savePreparedKeyboardButton: async () => ({ id: "  " }) },
    })).toEqual({ ok: false, message: "PICKER_PREPARE_FAILED" });
  });

  test("导入追着删：新加入、重复与失败分别归类，非法用户 ID 被丢弃，全部失败时透传首个失败码", async () => {
    const state = getOrCreateChatState(CHAT_ID);
    state.isInitEnabled = true;
    state.botPermissions = botPermissions({ canDeleteMessages: true });
    state.deleteMessageTargets = [88_002];

    const requestId: number = await preparePicker("deleteMessage", "users", { chatId: CHAT_ID });
    const event: Readonly<MiniAppPickerResultEvent> | null =
      await handleMiniAppSharedMessage(usersShared(requestId, [88_001, 88_002, SUPER_ADMIN_USER_ID, 0]));
    expect(event).toMatchObject({
      targetList: "deleteMessage",
      addedIds: [88_001],
      duplicateIds: [88_002],
      skippedIds: [88_002, SUPER_ADMIN_USER_ID],
      summary: "PICKER_IMPORT_ADDED",
    });
    expect(getChatState(CHAT_ID).deleteMessageTargets).toEqual([88_002, 88_001]);

    const failedId: number = await preparePicker("deleteMessage", "users", { chatId: CHAT_ID });
    expect((await handleMiniAppSharedMessage(usersShared(failedId, [SUPER_ADMIN_USER_ID])))?.summary)
      .toBe("DELETE_TARGET_SUPER_ADMIN_FORBIDDEN");
  });

  test("导入追着翻：未给语言时按 ja 写入，换语言计为新加入；会话缺目标群时全部跳过", async () => {
    const state = getOrCreateChatState(CHAT_ID);
    state.isInitEnabled = true;
    state.isTranslationEnabled = true;

    const defaultId: number = await preparePicker("translate", "users", { chatId: CHAT_ID });
    expect((await handleMiniAppSharedMessage(usersShared(defaultId, [88_101])))?.addedIds).toEqual([88_101]);
    expect(getChatState(CHAT_ID).translate?.[0]?.language).toBe("ja");

    const sameId: number = await preparePicker("translate", "users", { chatId: CHAT_ID, language: "ja" });
    expect(await handleMiniAppSharedMessage(usersShared(sameId, [88_101]))).toMatchObject({
      addedIds: [],
      duplicateIds: [88_101],
      summary: "PICKER_IMPORT_DUPLICATE",
    });

    const switchId: number = await preparePicker("translate", "users", { chatId: CHAT_ID, language: "en" });
    expect((await handleMiniAppSharedMessage(usersShared(switchId, [88_101])))?.addedIds).toEqual([88_101]);
    expect(getChatState(CHAT_ID).translate?.[0]?.language).toBe("en");

    const orphanId: number = await preparePicker("translate", "users");
    expect(await handleMiniAppSharedMessage(usersShared(orphanId, [88_102]))).toMatchObject({
      addedIds: [],
      skippedIds: [88_102],
      summary: "PICKER_IMPORT_EMPTY",
    });
  });

  test("频道会话收到非负会话 ID 时不导入，回 PICKER_IMPORT_EMPTY；无标题频道以占位名写入", async () => {
    const emptyId: number = await preparePicker("blocklist", "channel");
    expect(await handleMiniAppSharedMessage(chatShared(emptyId, 12_345))).toMatchObject({
      addedIds: [],
      skippedIds: [],
      summary: "PICKER_IMPORT_EMPTY",
    });

    const channelId: number = await preparePicker("blocklist", "channel");
    expect((await handleMiniAppSharedMessage(chatShared(channelId, -1_009_500_099)))?.addedIds)
      .toEqual([-1_009_500_099]);
  });
});

describe("Mini App 权限与选择器路由参数校验", () => {
  test("POST /api/identities/permission 拒绝非法 ID、未知权限键与非布尔值", async () => {
    for (const body of [{ id: 0, key: "isCanMute", value: true }, { key: "isCanMute", value: true }, { id: 1.5 }]) {
      expect(await requestError("/api/identities/permission", body))
        .toEqual({ status: 400, error: "INVALID_IDENTITY_ID" });
    }
    for (const body of [
      { id: 88_201, key: "notAPermission", value: true },
      { id: 88_201, key: 1, value: true },
      { id: 88_201, key: "isCanMute", value: "true" },
    ]) {
      expect(await requestError("/api/identities/permission", body))
        .toEqual({ status: 400, error: "INVALID_PERMISSION_PARAMS" });
    }
  });

  test("POST /api/picker/prepare 拒绝未知名单或身份种类、群目标缺合法群 ID 与非法翻译语言", async () => {
    for (const body of [
      { targetList: "unknown", subjectKind: "users" },
      { targetList: "whitelist", subjectKind: "bots" },
      { targetList: "deleteMessage", subjectKind: "users" },
      { targetList: "deleteMessage", subjectKind: "users", chatId: 12_345 },
      { targetList: "translate", subjectKind: "users", chatId: 1.5 },
      { targetList: "translate", subjectKind: "users", chatId: CHAT_ID, language: "xx" },
      { targetList: "translate", subjectKind: "users", chatId: CHAT_ID, language: 1 },
    ]) {
      expect(await requestError("/api/picker/prepare", body))
        .toEqual({ status: 400, error: "INVALID_PICKER_PARAMS" });
    }
  });

  test("GET /api/picker/result 拒绝缺失或非正的 requestId", async () => {
    for (const query of ["", "?requestId=0", "?requestId=-3", "?requestId=abc"]) {
      expect(await requestError(`/api/picker/result${query}`))
        .toEqual({ status: 400, error: "INVALID_PICKER_REQUEST_ID" });
    }
  });
});
