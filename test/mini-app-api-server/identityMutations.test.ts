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
const {
  identityPolicyCache,
  resetIdentityStorageCache,
  unacknowledgedBlocklistWrites,
  unacknowledgedWhitelistWrites,
} = await import("../../packages/cache/main/identityStorage");
const {
  identityById,
  senderUsernameCache,
  userCache,
} = await import("../../packages/cache/main/senderIdentity");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { blockUser } = await import("../../packages/infra/blocklist/membership");
const diskIO = await import("../../packages/infra/diskIO");
const { prefetchIdentityPolicies } = await import("../../packages/infra/identityStorage");
const { setWhitelistMembership } = await import("../../packages/infra/identityPolicy/whitelist");
const { logger } = await import("../../packages/infra/logger");
const { getOrCreateChatState } = await import("../../packages/infra/chatStateStorage");
const {
  resolveUsernameTarget,
  updateCachedIdentity,
} = await import("../../packages/users/senderIdentity");
const { resolveIdentityMetadataForMiniApp } = await import(
  "../../packages/mini-app-api-server/view/identities/metadata"
);
const {
  enableAllWhitelistEntryPermissions,
  setWhitelistEntryMembership,
  setWhitelistEntryPermission,
} = await import("../../packages/mini-app-api-server/view/identities/whitelist");
const { setBlocklistEntryMembership } = await import(
  "../../packages/mini-app-api-server/view/identities/blocklist"
);
const antiRaid = await import("../../packages/antiRaid");

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
  userCache.clear();
  senderUsernameCache.clear();
  identityById.clear();
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
  test("新增永久白名单通知 Worker 清理残留广告检测状态，移除或失败时不通知", async () => {
    const clearSpy = spyOn(antiRaid, "clearIdentityAdDetection").mockReturnValue(true);
    try {
      const added: Readonly<MiniAppIdentityMutationResult> = await setWhitelistEntryMembership({
        id: 50_099,
        enabled: true,
        meta: { firstName: "Trusted", lastName: "", username: "" },
      });
      expect(added.ok).toBeTrue();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenLastCalledWith(50_099);

      const removed: Readonly<MiniAppIdentityMutationResult> = await setWhitelistEntryMembership({
        id: 50_099,
        enabled: false,
      });
      expect(removed.ok).toBeTrue();
      expect(clearSpy).toHaveBeenCalledTimes(1);

      expectRejected(
        await setWhitelistEntryMembership({ id: SUPER_ADMIN_USER_ID, enabled: true }),
        "SUPER_ADMIN_EXEMPT"
      );
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearSpy.mockRestore();
    }
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

  test("黑白名单重复添加（D2）：前一次写入未落盘确认时补投确认，黑名单并重新派发跨群封禁", async () => {
    const postSpy = spyOn(diskIO, "postDiskIO");
    try {
      // 1. 白名单已在内存缓存但上次落盘未 ACK：重复添加须补投（retryUnacknowledged=true）并等待确认落盘。
      const dupWhitelistId: number = 50_031;
      await prefetchIdentityPolicies([dupWhitelistId]);
      setWhitelistMembership({ id: dupWhitelistId, enabled: true, meta: { firstName: "Pending", lastName: "", username: "" } });
      postSpy.mockClear();
      expect(whitelistRows.has(dupWhitelistId)).toBeFalse();
      expect(unacknowledgedWhitelistWrites.has(dupWhitelistId)).toBeTrue();

      const whitelistDup: Readonly<MiniAppIdentityMutationResult> =
        await setWhitelistEntryMembership({ id: dupWhitelistId, enabled: true });
      expect(whitelistDup).toMatchObject({
        ok: true,
        changed: false,
        duplicate: true,
        id: dupWhitelistId,
        message: "WHITELIST_DUPLICATE",
      });
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "identityPolicyWrite", table: "whitelist", id: dupWhitelistId })
      );
      expect(whitelistRows.has(dupWhitelistId)).toBeTrue();
      expect(unacknowledgedWhitelistWrites.has(dupWhitelistId)).toBeFalse();

      // 2. 黑名单已在内存缓存但上次落盘未 ACK：重复添加须补投确认并重新对受管群派发封禁。
      const dupBlocklistId: number = 60_031;
      seedManagedAdminChat(MANAGED_CHAT_ID, true);
      const rebanCalls: number[] = [];
      telegramApiState.current = {
        banChatMember: async (chatId: number): Promise<true> => {
          rebanCalls.push(chatId);
          return true;
        },
      } as unknown as InstalledTelegramApi;
      await prefetchIdentityPolicies([dupBlocklistId]);
      blockUser(dupBlocklistId, { firstName: "PendingBlock", lastName: "", username: "" });
      postSpy.mockClear();
      expect(blocklistRows.has(dupBlocklistId)).toBeFalse();
      expect(unacknowledgedBlocklistWrites.has(dupBlocklistId)).toBeTrue();

      const blocklistDup: Readonly<MiniAppIdentityMutationResult> =
        await setBlocklistEntryMembership({ id: dupBlocklistId, enabled: true });
      expect(blocklistDup).toMatchObject({
        ok: true,
        changed: false,
        duplicate: true,
        id: dupBlocklistId,
        persisted: true,
        affectedChats: 1,
        totalChats: 1,
        message: "BLOCKLIST_DUPLICATE",
      });
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "identityPolicyWrite", table: "blocklist", id: dupBlocklistId })
      );
      expect(blocklistRows.has(dupBlocklistId)).toBeTrue();
      expect(unacknowledgedBlocklistWrites.has(dupBlocklistId)).toBeFalse();
      expect(rebanCalls).toEqual([MANAGED_CHAT_ID]);
    } finally {
      postSpy.mockRestore();
    }
  });

  test("身份元数据补齐依次命中主线程发送者缓存、静默 getChat 探测（用户与频道）及空探测兜底", async () => {
    // 1. 命中主线程发送者缓存时直接返回缓存资料，不调用 getChat。
    let getChatCalls: number = 0;
    telegramApiState.current = {
      getChat: async (): Promise<unknown> => {
        getChatCalls += 1;
        return undefined;
      },
    } as unknown as InstalledTelegramApi;
    updateCachedIdentity({
      id: 70_001,
      username: "cached_user",
      first_name: "Cached",
      last_name: "Name",
    });
    const cachedMeta = await resolveIdentityMetadataForMiniApp(70_001);
    expect(cachedMeta).toEqual({
      firstName: "Cached",
      lastName: "Name",
      username: "cached_user",
    });
    expect(getChatCalls).toBe(0);

    // 2. 缓存未命中时经 getChat 探测私聊用户（first_name/last_name/username）并回填发送者缓存。
    telegramApiState.current = {
      getChat: async (targetId: number): Promise<unknown> => {
        getChatCalls += 1;
        if (targetId === 70_002) {
          return {
            id: targetId,
            type: "private",
            first_name: "  ProbeFirst ",
            last_name: " ProbeLast ",
            username: " probed_user ",
          };
        }
        if (targetId === -10070003) {
          return {
            id: targetId,
            type: "channel",
            title: " ProbeChannel ",
            username: "probed_chan",
          };
        }
        return { id: targetId, type: "private", first_name: "   ", username: "  " };
      },
    } as unknown as InstalledTelegramApi;

    const probedUser = await resolveIdentityMetadataForMiniApp(70_002);
    expect(probedUser).toEqual({
      firstName: "ProbeFirst",
      lastName: "ProbeLast",
      username: "probed_user",
    });
    expect(resolveUsernameTarget("probed_user")?.id).toBe(70_002);

    // 3. 缓存未命中时经 getChat 探测频道（title/username）并回填频道缓存。
    const probedChannel = await resolveIdentityMetadataForMiniApp(-10070003);
    expect(probedChannel).toEqual({
      firstName: "ProbeChannel",
      lastName: "",
      username: "probed_chan",
    });
    expect(resolveUsernameTarget("probed_chan")?.id).toBe(-10070003);

    // 4. getChat 返回空白字段时回退为空元数据。
    const emptyProbe = await resolveIdentityMetadataForMiniApp(70_004);
    expect(emptyProbe).toEqual({
      firstName: "",
      lastName: "",
      username: "",
    });
    expect(getChatCalls).toBe(3);
  });

  test("临界区内缓存被挤出且重新预取失败返回 IDENTITY_STORAGE_UNAVAILABLE，持久化异常返回对应失败码", async () => {
    const flushSpy = spyOn(diskIO, "flushDiskIODomain");
    try {
      // 1. 白名单成员变更：外层预取成功后，元数据探测窗口内缓存被清空且临界区内补预取失败。
      telegramApiState.current = {
        getChat: async (): Promise<unknown> => {
          identityPolicyCache.clear();
          failNextIdentityRead();
          return undefined;
        },
      } as unknown as InstalledTelegramApi;
      expectRejected(
        await setWhitelistEntryMembership({ id: 71_001, enabled: true }),
        "IDENTITY_STORAGE_UNAVAILABLE"
      );

      // 2. 白名单成员变更落盘确认抛错 -> WHITELIST_PERSIST_FAILED。
      telegramApiState.current = null;
      flushSpy.mockImplementationOnce(async (): Promise<never> => {
        throw new Error("whitelist flush failed");
      });
      expectRejected(
        await setWhitelistEntryMembership({
          id: 71_002,
          enabled: true,
          meta: { firstName: "PersistFail", lastName: "", username: "" },
        }),
        "WHITELIST_PERSIST_FAILED"
      );

      // 3. 白名单权限修改（单项与一键全开）：临界区内缓存缺失且补预取失败 -> IDENTITY_STORAGE_UNAVAILABLE；落盘失败 -> PERMISSION_PERSIST_FAILED。
      const permId: number = 71_003;
      whitelistRows.set(permId, JSON.stringify({
        permissions: DEFAULT_WHITELIST_PERMISSIONS,
        meta: { firstName: "PermTarget", lastName: "", username: "" },
      }));
      const coordination = await import("../../packages/infra/identityPolicy/coordination");
      const gate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      const blocker: Promise<void> = coordination.runProtectedIdentityMutation(
        async (): Promise<void> => {
          await gate.promise;
        }
      );
      const pendingPerm = setWhitelistEntryPermission({
        id: permId,
        key: "isCanMute",
        value: true,
      });
      await Bun.sleep(0);
      identityPolicyCache.clear();
      failNextIdentityRead();
      gate.resolve();
      await blocker;
      expectRejected(await pendingPerm, "IDENTITY_STORAGE_UNAVAILABLE");

      flushSpy.mockImplementationOnce(async (): Promise<never> => {
        throw new Error("permission flush failed");
      });
      expectRejected(
        await enableAllWhitelistEntryPermissions(permId),
        "PERMISSION_PERSIST_FAILED"
      );

      // 4. 黑名单加入与解除：临界区内缓存被清空且补预取失败 -> IDENTITY_STORAGE_UNAVAILABLE。
      telegramApiState.current = {
        getChat: async (): Promise<unknown> => {
          identityPolicyCache.clear();
          failNextIdentityRead();
          return undefined;
        },
      } as unknown as InstalledTelegramApi;
      expectRejected(
        await setBlocklistEntryMembership({ id: 71_004, enabled: true }),
        "IDENTITY_STORAGE_UNAVAILABLE"
      );

      telegramApiState.current = null;
      const unblockGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      const unblockBlocker: Promise<void> = coordination.runProtectedIdentityMutation(
        async (): Promise<void> => {
          await unblockGate.promise;
        }
      );
      const pendingUnblock = setBlocklistEntryMembership({
        id: 71_005,
        enabled: false,
      });
      await Bun.sleep(0);
      identityPolicyCache.clear();
      failNextIdentityRead();
      unblockGate.resolve();
      await unblockBlocker;
      expectRejected(await pendingUnblock, "IDENTITY_STORAGE_UNAVAILABLE");
    } finally {
      flushSpy.mockRestore();
    }
  });
});
