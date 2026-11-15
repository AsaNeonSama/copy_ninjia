/**
 * Mini App 黑白名单成员变更的前置护栏与跨群处置：非法 ID、超级管理员、机器人自身、受管群自身、
 * 身份存储不可读与互斥名单拒绝；拉黑逐群封禁并为失败群登记补扫，解除逐群解封。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import type { MiniAppIdentityMutationResult } from "../../packages/types/miniApp/identities";
import type { InstalledTelegramApi } from "../../packages/types/telegramWorker";
import { botPermissions } from "../helpers/botPermissions";
import {
  installMiniAppTestDiskIOMock,
  miniAppTestBlocklistRows as blocklistRows,
  miniAppTestWhitelistRows as whitelistRows,
  readIdentityPoliciesMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { aiChatBotInfo } = await import("../../packages/cache/main/aiChat");
const { blocklistSweepState } = await import("../../packages/cache/main/blocklist");
const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { resetIdentityStorageCache } = await import("../../packages/cache/main/identityStorage");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { logger } = await import("../../packages/infra/logger");
const { getOrCreateChatState } = await import("../../packages/infra/chatStateStorage");
const {
  setWhitelistEntryMembership,
  setWhitelistEntryPermission,
} = await import("../../packages/mini-app-api-server/view/identities/whitelist");
const { setBlocklistEntryMembership } = await import(
  "../../packages/mini-app-api-server/view/identities/blocklist"
);

/** 夹具里机器人自身的用户 ID。 */
const BOT_USER_ID: number = 4_242_001;
/** 夹具里已 `/init` 的受管群 ID。 */
const MANAGED_CHAT_ID: number = -1_009_100_001;

/**
 * 登记一个已 `/init` 且机器人为管理员的受管群。
 * @param chatId 群 ID。
 * @param canRestrictMembers 机器人在该群是否有封禁权限。
 */
function seedManagedAdminChat(chatId: number, canRestrictMembers: boolean): void {
  const state = getOrCreateChatState(chatId);
  state.isInitEnabled = true;
  state.botPermissions = botPermissions({ canRestrictMembers });
}

/** 让下一次身份策略冷读失败，使预取返回不可用。 */
function failNextIdentityRead(): void {
  readIdentityPoliciesMock.mockImplementationOnce(async (): Promise<never> => {
    throw new Error("identity storage read failed");
  });
}

/**
 * 断言一次变更被前置护栏拒绝且未改名单。
 * @param result 变更结果。
 * @param message 期望的回执码。
 */
function expectRejected(result: Readonly<MiniAppIdentityMutationResult>, message: string): void {
  expect(result.ok).toBeFalse();
  expect(result.changed).toBeFalse();
  expect(result.message).toBe(message);
}

let loggerError: ReturnType<typeof spyOn<typeof logger, "error">>;

beforeEach((): void => {
  loggerError = spyOn(logger, "error").mockImplementation((): void => {});
  aiChatBotInfo.current = { id: BOT_USER_ID, username: "fixture_bot", first_name: "Bot" };
});

afterEach((): void => {
  loggerError.mockRestore();
  resetMiniAppTestDiskIOState();
  resetIdentityStorageCache();
  resetChatStateCache();
  blocklistSweepState.clear();
  aiChatBotInfo.current = null;
  telegramApiState.current = null;
});

describe("Mini App 白名单成员变更护栏", () => {
  test("非法 ID、超级管理员、机器人自身与受管群自身在读名单前被拒绝", async () => {
    seedManagedAdminChat(MANAGED_CHAT_ID, true);
    for (const id of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectRejected(await setWhitelistEntryMembership({ id, enabled: true }), "INVALID_IDENTITY_ID");
    }
    expectRejected(
      await setWhitelistEntryMembership({ id: SUPER_ADMIN_USER_ID, enabled: true }),
      "SUPER_ADMIN_EXEMPT"
    );
    expectRejected(
      await setWhitelistEntryMembership({ id: BOT_USER_ID, enabled: true }),
      "TARGET_SELF_FORBIDDEN"
    );
    expectRejected(
      await setWhitelistEntryMembership({ id: MANAGED_CHAT_ID, enabled: true }),
      "TARGET_CURRENT_CHAT_FORBIDDEN"
    );
    expect(readIdentityPoliciesMock).not.toHaveBeenCalled();
  });

  test("关闭方向不拦超级管理员、机器人与受管群自身，按名单现状回执", async () => {
    seedManagedAdminChat(MANAGED_CHAT_ID, true);
    for (const id of [SUPER_ADMIN_USER_ID, BOT_USER_ID, MANAGED_CHAT_ID]) {
      const result: Readonly<MiniAppIdentityMutationResult> =
        await setWhitelistEntryMembership({ id, enabled: false });
      expect(result.ok).toBeTrue();
      expect(result.message).toBe("WHITELIST_NOT_FOUND");
    }
  });

  test("身份存储冷读失败回 IDENTITY_STORAGE_UNAVAILABLE，已在黑名单的身份回 IDENTITY_IN_BLOCKLIST", async () => {
    failNextIdentityRead();
    expectRejected(
      await setWhitelistEntryMembership({ id: 50_001, enabled: true }),
      "IDENTITY_STORAGE_UNAVAILABLE"
    );

    blocklistRows.set(50_002, JSON.stringify({
      blockedAt: "2026/11/06 00:00:00",
      meta: { firstName: "Blocked", lastName: "", username: "" },
    }));
    expectRejected(
      await setWhitelistEntryMembership({ id: 50_002, enabled: true }),
      "IDENTITY_IN_BLOCKLIST"
    );
    expect(whitelistRows.has(50_002)).toBeFalse();
  });

  test("权限修改拒绝超级管理员、存储不可读与不在白名单的身份", async () => {
    expectRejected(
      await setWhitelistEntryPermission({ id: SUPER_ADMIN_USER_ID, key: "isCanMute", value: true }),
      "SUPER_ADMIN_EXEMPT"
    );
    failNextIdentityRead();
    expectRejected(
      await setWhitelistEntryPermission({ id: 50_011, key: "isCanMute", value: true }),
      "IDENTITY_STORAGE_UNAVAILABLE"
    );
    expectRejected(
      await setWhitelistEntryPermission({ id: 50_012, key: "isCanMute", value: true }),
      "WHITELIST_NOT_FOUND"
    );
  });
});

describe("Mini App 黑名单成员变更护栏与跨群处置", () => {
  test("非法 ID、超级管理员（两个方向）、机器人自身与受管群自身在读名单前被拒绝", async () => {
    seedManagedAdminChat(MANAGED_CHAT_ID, true);
    expectRejected(await setBlocklistEntryMembership({ id: 0, enabled: true }), "INVALID_IDENTITY_ID");
    for (const enabled of [true, false]) {
      expectRejected(
        await setBlocklistEntryMembership({ id: SUPER_ADMIN_USER_ID, enabled }),
        "BLOCKLIST_SUPER_ADMIN_FORBIDDEN"
      );
    }
    expectRejected(
      await setBlocklistEntryMembership({ id: BOT_USER_ID, enabled: true }),
      "TARGET_SELF_FORBIDDEN"
    );
    expectRejected(
      await setBlocklistEntryMembership({ id: MANAGED_CHAT_ID, enabled: true }),
      "TARGET_CURRENT_CHAT_FORBIDDEN"
    );
    expect(readIdentityPoliciesMock).not.toHaveBeenCalled();
  });

  test("身份存储冷读失败回 IDENTITY_STORAGE_UNAVAILABLE，已在白名单的身份回 IDENTITY_IN_WHITELIST", async () => {
    failNextIdentityRead();
    expectRejected(
      await setBlocklistEntryMembership({ id: 60_001, enabled: true }),
      "IDENTITY_STORAGE_UNAVAILABLE"
    );

    whitelistRows.set(60_002, JSON.stringify({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Trusted", lastName: "", username: "" },
    }));
    expectRejected(
      await setBlocklistEntryMembership({ id: 60_002, enabled: true }),
      "IDENTITY_IN_WHITELIST"
    );
    expect(blocklistRows.has(60_002)).toBeFalse();
  });

  test("拉黑逐群封禁：缺封禁权限的群不发请求，失败群与缺权限群都登记补扫", async () => {
    const bannedChat: number = -1_009_100_011;
    const failingChat: number = -1_009_100_012;
    const forbiddenChat: number = -1_009_100_013;
    seedManagedAdminChat(bannedChat, true);
    seedManagedAdminChat(failingChat, true);
    seedManagedAdminChat(forbiddenChat, false);
    const banRequests: number[] = [];
    telegramApiState.current = {
      banChatMember: async (chatId: number): Promise<true> => {
        banRequests.push(chatId);
        if (chatId === failingChat) throw new Error("ban request failed");
        return true;
      },
    } as unknown as InstalledTelegramApi;

    const result: Readonly<MiniAppIdentityMutationResult> =
      await setBlocklistEntryMembership({ id: 60_011, enabled: true });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      duplicate: false,
      persisted: true,
      affectedChats: 1,
      totalChats: 3,
      message: "BLOCKLIST_ADDED",
    });
    expect(blocklistRows.has(60_011)).toBeTrue();
    expect(banRequests.toSorted()).toEqual([bannedChat, failingChat].toSorted());
    expect([...blocklistSweepState.keys()].toSorted()).toEqual([failingChat, forbiddenChat].toSorted());
    for (const chatId of [failingChat, forbiddenChat]) {
      expect(blocklistSweepState.get(chatId)?.sweptAt).toBeNull();
    }
  });

  test("频道身份拉黑走 banChatSenderChat，解除走 unbanChatSenderChat", async () => {
    const channelId: number = -1_009_200_001;
    seedManagedAdminChat(MANAGED_CHAT_ID, true);
    const calls: string[] = [];
    // unbanChatSenderChat 是主线程独占方法，接口须带 copyMessage 才被认作主线程完整实现。
    telegramApiState.current = {
      copyMessage: async (): Promise<never> => {
        throw new Error("copyMessage is not expected");
      },
      banChatSenderChat: async (chatId: number, senderChatId: number): Promise<true> => {
        calls.push(`ban:${chatId}:${senderChatId}`);
        return true;
      },
      unbanChatSenderChat: async (chatId: number, senderChatId: number): Promise<true> => {
        calls.push(`unban:${chatId}:${senderChatId}`);
        return true;
      },
    } as unknown as InstalledTelegramApi;

    const added: Readonly<MiniAppIdentityMutationResult> =
      await setBlocklistEntryMembership({ id: channelId, enabled: true });
    const removed: Readonly<MiniAppIdentityMutationResult> =
      await setBlocklistEntryMembership({ id: channelId, enabled: false });

    expect(added).toMatchObject({ ok: true, affectedChats: 1, totalChats: 1, message: "BLOCKLIST_ADDED" });
    expect(removed).toMatchObject({ ok: true, changed: true, affectedChats: 1, totalChats: 1, message: "BLOCKLIST_REMOVED" });
    expect(calls).toEqual([
      `ban:${MANAGED_CHAT_ID}:${channelId}`,
      `unban:${MANAGED_CHAT_ID}:${channelId}`,
    ]);
    expect(blocklistSweepState.size).toBe(0);
  });

  test("解除逐群解封只解已有封禁；缺权限群不发请求、不登记补扫；不在名单仍照常解封并回 BLOCKLIST_NOT_FOUND", async () => {
    const unbannedChat: number = -1_009_100_021;
    const forbiddenChat: number = -1_009_100_022;
    seedManagedAdminChat(unbannedChat, true);
    seedManagedAdminChat(forbiddenChat, false);
    const unbanRequests: { readonly chatId: number; readonly onlyIfBanned: unknown }[] = [];
    telegramApiState.current = {
      unbanChatMember: async (
        chatId: number,
        _userId: number,
        other: { readonly only_if_banned?: boolean }
      ): Promise<true> => {
        unbanRequests.push({ chatId, onlyIfBanned: other.only_if_banned });
        return true;
      },
    } as unknown as InstalledTelegramApi;
    blocklistRows.set(60_021, JSON.stringify({
      blockedAt: "2026/11/06 00:00:00",
      meta: { firstName: "Blocked", lastName: "", username: "" },
    }));

    const removed: Readonly<MiniAppIdentityMutationResult> =
      await setBlocklistEntryMembership({ id: 60_021, enabled: false });
    const absent: Readonly<MiniAppIdentityMutationResult> =
      await setBlocklistEntryMembership({ id: 60_022, enabled: false });

    expect(removed).toMatchObject({ ok: true, changed: true, affectedChats: 1, totalChats: 2, message: "BLOCKLIST_REMOVED" });
    expect(absent).toMatchObject({ ok: true, changed: false, affectedChats: 1, totalChats: 2, message: "BLOCKLIST_NOT_FOUND" });
    expect(blocklistRows.has(60_021)).toBeFalse();
    expect(unbanRequests).toEqual([
      { chatId: unbannedChat, onlyIfBanned: true },
      { chatId: unbannedChat, onlyIfBanned: true },
    ]);
    expect(blocklistSweepState.size).toBe(0);
  });
});
