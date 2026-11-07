/**
 * Mini App 群目标管理 `mutateManagedChatTargets` 的拒绝与边界分支：未 `/init`、问答空字段/替换/上限/缺失、
 * 目标解析（空、非法、用户名未知、机器人自身、本群自身）、在群核验、追着删与追着翻的权限、上限、重复与
 * 等待期间状态变化。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type {
  MiniAppChatTargetsMutationRequest,
  MiniAppChatTargetsMutationResult,
} from "../../packages/types/miniApp";
import type { InstalledTelegramApi } from "../../packages/types/telegramWorker";
import { botPermissions } from "../helpers/botPermissions";
import {
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { aiChatBotInfo } = await import("../../packages/cache/main/aiChat");
const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { translateConfigReadinessCache } = await import("../../packages/cache/main/configReadiness");
const { chatQaEntries } = await import("../../packages/cache/main/qa");
const {
  identityById,
  senderUsernameCache,
  userCache,
} = await import("../../packages/cache/main/senderIdentity");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { DELETE_MESSAGE_CHAT_TARGET_MAX } = await import("../../packages/consts/deleteMessage");
const { CHAT_QA_MAX_PER_CHAT } = await import("../../packages/consts/qa");
const { TRANSLATE_CHAT_USER_LIMIT } = await import("../../packages/consts/translate");
const { getChatState, getOrCreateChatState } = await import(
  "../../packages/infra/storage/stateStore"
);
const { updateCachedIdentity } = await import("../../packages/users/senderIdentity");
const { mutateManagedChatTargets } = await import(
  "../../packages/mini-app-api-server/view/chats/targets"
);

/** 夹具群 ID。 */
const CHAT_ID: number = -1_009_400_001;
/** 夹具里机器人自身的用户 ID。 */
const BOT_USER_ID: number = 4_242_002;

/** 登记一个已 `/init`、开着翻译且机器人可删消息的夹具群。 */
function seedChat(): void {
  const state = getOrCreateChatState(CHAT_ID);
  state.isInitEnabled = true;
  state.isTranslationEnabled = true;
  state.botPermissions = botPermissions({ canDeleteMessages: true });
}

/**
 * 执行一次目标变更。
 * @param request 变更请求。
 * @returns 变更结果。
 */
function mutate(
  request: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
  return mutateManagedChatTargets(CHAT_ID, request);
}

/**
 * 断言变更回执码与成败。
 * @param result 变更结果。
 * @param ok 期望的成败。
 * @param message 期望的回执码。
 */
function expectOutcome(
  result: Readonly<MiniAppChatTargetsMutationResult>,
  ok: boolean,
  message: string
): void {
  expect(result.ok).toBe(ok);
  expect(result.message).toBe(message);
}

afterEach((): void => {
  resetMiniAppTestDiskIOState();
  resetChatStateCache();
  chatQaEntries.clear();
  userCache.clear();
  senderUsernameCache.clear();
  identityById.clear();
  aiChatBotInfo.current = null;
  telegramApiState.current = null;
  translateConfigReadinessCache.current = { ok: true };
});

describe("Mini App 群目标管理", () => {
  test("未 /init 的群对任一动作都回 CHAT_NOT_FOUND 且不附视图", async () => {
    for (const request of [
      { action: "setQa", q: "q", a: "a" },
      { action: "removeQa", q: "q" },
      { action: "addDeleteTarget", target: "77001" },
      { action: "removeDeleteTarget", id: 77001 },
      { action: "addTranslateTarget", target: "77001", language: "ja" },
      { action: "removeTranslateTarget", id: 77001 },
    ] as const satisfies readonly MiniAppChatTargetsMutationRequest[]) {
      expect(await mutate(request)).toEqual({
        ok: false,
        message: "CHAT_NOT_FOUND",
        targets: null,
        detail: null,
      });
    }
  });

  test("问答：空字段拒绝，同问题替换答案，达到上限拒绝新增，删除不存在的问题回 QA_NOT_FOUND", async () => {
    seedChat();
    expectOutcome(await mutate({ action: "setQa", q: " ", a: "a" }), false, "QA_EMPTY_FIELDS");
    expectOutcome(await mutate({ action: "removeQa", q: "" }), false, "QA_EMPTY_FIELDS");
    expectOutcome(await mutate({ action: "setQa", q: "问题0", a: "答案" }), true, "QA_ADDED");
    const replaced: Readonly<MiniAppChatTargetsMutationResult> =
      await mutate({ action: "setQa", q: "问题0", a: "新答案" });
    expectOutcome(replaced, true, "QA_UPDATED");
    expect(replaced.targets?.qaItems).toEqual([{ q: "问题0", a: "新答案" }]);
    for (let index: number = 1; index < CHAT_QA_MAX_PER_CHAT; index++) {
      expectOutcome(await mutate({ action: "setQa", q: `问题${index}`, a: "答案" }), true, "QA_ADDED");
    }
    expectOutcome(await mutate({ action: "setQa", q: "多出的问题", a: "答案" }), false, "QA_LIMIT_REACHED");
    expectOutcome(await mutate({ action: "removeQa", q: "不存在" }), true, "QA_NOT_FOUND");
  });

  test("目标解析：空、非法用户名、未知用户名、机器人自身与本群自身均被拒绝；已知用户名解析为缓存身份", async () => {
    seedChat();
    aiChatBotInfo.current = { id: BOT_USER_ID, username: "fixture_bot", first_name: "Bot" };
    expectOutcome(await mutate({ action: "addDeleteTarget", target: "  " }), false, "TARGET_REQUIRED");
    expectOutcome(await mutate({ action: "addDeleteTarget" }), false, "TARGET_REQUIRED");
    expectOutcome(await mutate({ action: "addDeleteTarget", target: "@a b" }), false, "TARGET_INVALID");
    expectOutcome(
      await mutate({ action: "addDeleteTarget", target: "@nobody_known" }),
      false,
      "TARGET_USERNAME_NOT_FOUND"
    );
    expectOutcome(
      await mutate({ action: "addDeleteTarget", target: String(BOT_USER_ID) }),
      false,
      "TARGET_SELF_FORBIDDEN"
    );
    expectOutcome(
      await mutate({ action: "addDeleteTarget", target: String(CHAT_ID) }),
      false,
      "TARGET_CURRENT_CHAT_FORBIDDEN"
    );

    updateCachedIdentity({ id: 77_101, username: "known_member", first_name: "Known" });
    const added: Readonly<MiniAppChatTargetsMutationResult> =
      await mutate({ action: "addDeleteTarget", target: "known_member" });
    expectOutcome(added, true, "DELETE_TARGET_ADDED");
    expect(added.targets?.deleteMessageTargets.map((item) => item.id)).toEqual([77_101]);
  });

  test("追着删：拒绝超级管理员与缺删消息权限；重复回 ALREADY_EXISTS，达到上限拒绝；删除校验 ID", async () => {
    seedChat();
    expectOutcome(
      await mutate({ action: "addDeleteTarget", target: String(SUPER_ADMIN_USER_ID) }),
      false,
      "DELETE_TARGET_SUPER_ADMIN_FORBIDDEN"
    );
    getOrCreateChatState(CHAT_ID).botPermissions = botPermissions({ canDeleteMessages: false });
    expectOutcome(
      await mutate({ action: "addDeleteTarget", target: "77201" }),
      false,
      "DELETE_TARGET_MISSING_BOT_PERMISSION"
    );
    getOrCreateChatState(CHAT_ID).botPermissions = botPermissions({ canDeleteMessages: true });

    expectOutcome(await mutate({ action: "addDeleteTarget", target: "77201" }), true, "DELETE_TARGET_ADDED");
    expectOutcome(await mutate({ action: "addDeleteTarget", target: "77201" }), true, "DELETE_TARGET_ALREADY_EXISTS");
    for (let index: number = 1; index < DELETE_MESSAGE_CHAT_TARGET_MAX; index++) {
      expectOutcome(
        await mutate({ action: "addDeleteTarget", target: String(77_201 + index) }),
        true,
        "DELETE_TARGET_ADDED"
      );
    }
    expectOutcome(await mutate({ action: "addDeleteTarget", target: "78000" }), false, "DELETE_TARGET_LIMIT_REACHED");

    for (const id of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      expectOutcome(await mutate({ action: "removeDeleteTarget", id }), false, "TARGET_INVALID");
    }
    expectOutcome(await mutate({ action: "removeDeleteTarget", id: 78_000 }), true, "DELETE_TARGET_NOT_FOUND");
    expect(getChatState(CHAT_ID).deleteMessageTargets).toHaveLength(DELETE_MESSAGE_CHAT_TARGET_MAX);
  });

  test("在群核验：用户已离群回 TARGET_NOT_IN_CHAT；在群用户与频道按现查资料登记", async () => {
    seedChat();
    telegramApiState.current = {
      getChatMember: async (_chatId: number, userId: number): Promise<unknown> => ({
        status: userId === 77_301 ? "left" : "member",
        user: { id: userId, is_bot: false, first_name: "Live", username: "live_member" },
      }),
      getChat: async (chatId: number): Promise<unknown> => ({
        id: chatId,
        type: "channel",
        title: "Live Channel",
        username: "live_channel",
      }),
    } as unknown as InstalledTelegramApi;

    expectOutcome(await mutate({ action: "addDeleteTarget", target: "77301" }), false, "TARGET_NOT_IN_CHAT");
    const member: Readonly<MiniAppChatTargetsMutationResult> =
      await mutate({ action: "addDeleteTarget", target: "77302" });
    expectOutcome(member, true, "DELETE_TARGET_ADDED");
    expect(member.targets?.deleteMessageTargets[0]).toMatchObject({ id: 77_302, username: "live_member" });

    const channel: Readonly<MiniAppChatTargetsMutationResult> =
      await mutate({ action: "addTranslateTarget", target: "-1009400099", language: "ja" });
    expectOutcome(channel, true, "TRANSLATE_TARGET_ADDED");
    expect(channel.targets?.translateTargets[0]).toMatchObject({
      id: -1_009_400_099,
      isChannel: true,
      username: "live_channel",
    });
  });

  test("等待在群核验期间 /init 被关闭时回 CHAT_NOT_FOUND，不写目标", async () => {
    seedChat();
    const pending: Promise<Readonly<MiniAppChatTargetsMutationResult>> =
      mutate({ action: "addDeleteTarget", target: "77401" });
    getOrCreateChatState(CHAT_ID).isInitEnabled = false;
    expect(await pending).toEqual({ ok: false, message: "CHAT_NOT_FOUND", targets: null, detail: null });
    expect(getChatState(CHAT_ID).deleteMessageTargets).toBeUndefined();
  });

  test("追着翻：能力不可用、功能关闭与语言非法被拒绝；等待期间功能被关闭时不写目标", async () => {
    seedChat();
    translateConfigReadinessCache.current = {
      ok: false,
      failure: { file: "g-auth.json", reason: "fixture" },
    };
    expectOutcome(
      await mutate({ action: "addTranslateTarget", target: "77501", language: "ja" }),
      false,
      "TRANSLATE_CAPABILITY_UNAVAILABLE"
    );
    translateConfigReadinessCache.current = { ok: true };
    expectOutcome(
      await mutate({ action: "addTranslateTarget", target: "77501" }),
      false,
      "TRANSLATE_LANGUAGE_INVALID"
    );

    const pending: Promise<Readonly<MiniAppChatTargetsMutationResult>> =
      mutate({ action: "addTranslateTarget", target: "77501", language: "ja" });
    getOrCreateChatState(CHAT_ID).isTranslationEnabled = false;
    expectOutcome(await pending, false, "TRANSLATE_FEATURE_DISABLED");
    expect(getChatState(CHAT_ID).translate).toBeUndefined();
    expectOutcome(
      await mutate({ action: "addTranslateTarget", target: "77501", language: "ja" }),
      false,
      "TRANSLATE_FEATURE_DISABLED"
    );
  });

  test("追着翻：同语言回 ALREADY_EXISTS，换语言回 UPDATED，达到上限拒绝新目标但仍可改已有目标；删除校验 ID", async () => {
    seedChat();
    expectOutcome(
      await mutate({ action: "addTranslateTarget", target: "77601", language: "ja" }),
      true,
      "TRANSLATE_TARGET_ADDED"
    );
    expectOutcome(
      await mutate({ action: "addTranslateTarget", target: "77601", language: "ja" }),
      true,
      "TRANSLATE_TARGET_ALREADY_EXISTS"
    );
    const updated: Readonly<MiniAppChatTargetsMutationResult> =
      await mutate({ action: "addTranslateTarget", target: "77601", language: "en" });
    expectOutcome(updated, true, "TRANSLATE_TARGET_UPDATED");
    expect(updated.targets?.translateTargets[0]?.language).toBe("en");
    for (let index: number = 1; index < TRANSLATE_CHAT_USER_LIMIT; index++) {
      expectOutcome(
        await mutate({ action: "addTranslateTarget", target: String(77_601 + index), language: "ja" }),
        true,
        "TRANSLATE_TARGET_ADDED"
      );
    }
    expectOutcome(
      await mutate({ action: "addTranslateTarget", target: "77700", language: "ja" }),
      false,
      "TRANSLATE_TARGET_LIMIT_REACHED"
    );
    expectOutcome(
      await mutate({ action: "addTranslateTarget", target: "77601", language: "ja" }),
      true,
      "TRANSLATE_TARGET_UPDATED"
    );

    for (const id of [0, -0.5, undefined]) {
      expectOutcome(await mutate({ action: "removeTranslateTarget", id }), false, "TARGET_INVALID");
    }
    expectOutcome(
      await mutate({ action: "removeTranslateTarget", id: 77_700 }),
      true,
      "TRANSLATE_TARGET_NOT_FOUND"
    );
    expect(getChatState(CHAT_ID).translate).toHaveLength(TRANSLATE_CHAT_USER_LIMIT);
  });
});
