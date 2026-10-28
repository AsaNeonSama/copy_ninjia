import { blocklistIdentityMutationRunner } from "../../../cache/main/blocklist";
import { SUPER_ADMIN_USER_ID } from "../../../config/bot";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_MAX_PAGE_SIZE,
} from "../../../consts/miniApp";
import {
  blockUser,
  confirmBlocklistPersisted,
  isUserBlocked,
  managedAdminChatIds,
  runManagedChatBatch,
  unblockUser,
} from "../../../infra/blocklist/membership";
import type { ManagedChatOutcome } from "../../../infra/blocklist/membership";
import { requestBlocklistResweep } from "../../../infra/blocklist/sweep";
import { botCanRestrictMembersIn } from "../../../infra/botAdmin";
import { runProtectedIdentityMutation } from "../../../infra/identityPolicy/coordination";
import { isWhitelisted } from "../../../infra/identityPolicy/whitelist";
import {
  getIdentityEntryCount,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
  readBlocklistSweepPage,
  readIdentityPolicyEntries,
} from "../../../infra/identityStorage";
import {
  banChatMember,
  banChatSenderChat,
  unbanChatMemberIfBanned,
  unbanChatSenderChat,
} from "../../../infra/telegram/actions/moderation";
import type {
  BlocklistEntryData,
  TelegramIdentityMetadata,
} from "../../../types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppBlocklistPage,
  MiniAppIdentityMutationResult,
} from "../../../types/miniApp";
import {
  collectAllIdentityIds,
  collectIdentityPageIds,
  currentBotUserId,
  formatIdentityDisplayName,
  isInitializedManagedChatTarget,
  matchesIdentitySearchQuery,
  resolveIdentityMetadataForMiniApp,
  syncIdentityMetadataWithBotCache,
} from "./metadata";
import type {
  CollectedIdentityPageSlice,
  ListIdentityPageParams,
  SetIdentityMembershipParams,
} from "./metadata";

/**
 * 分页列出持久化的黑名单成员（支持按名称、用户名或 ID 模糊搜索）。
 * 条目经 `readIdentityPolicyEntries` 直接冷读并在本次请求内局部持有，不读写 Bot 的合并身份缓存。
 * @param params 页码 `page`、每页条数 `pageSize`、游标 `afterId` 或搜索关键字 `query`。
 * @returns 黑名单分页视图（含当前页、总页数、黑名单总数、白名单总数）。
 */
export async function listBlocklistEntries(
  params: ListIdentityPageParams = {}
): Promise<Readonly<MiniAppBlocklistPage>> {
  const normalizedQuery: string = params.query?.trim().toLowerCase() ?? "";
  if (normalizedQuery.length > 0) {
    const rawPageSize: number =
      params.pageSize ?? params.limit ?? MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE;
    const pageSize: number = Math.min(
      MINI_APP_IDENTITY_MAX_PAGE_SIZE,
      Math.max(1, Math.trunc(rawPageSize))
    );
    const requestedPage: number = Math.max(1, Math.trunc(params.page ?? 1));
    const allIds: readonly number[] = await collectAllIdentityIds(
      readBlocklistSweepPage,
      "blocklist"
    );
    const blocklistTotal: number = Math.max(
      getIdentityEntryCount("blocklist"),
      allIds.length
    );
    const whitelistTotal: number = getIdentityEntryCount("whitelist");
    const entries: ReadonlyMap<number, Readonly<BlocklistEntryData>> =
      (await readIdentityPolicyEntries(allIds)).blocklist;
    const matchedItems: Readonly<MiniAppBlocklistEntryView>[] = [];
    for (const id of allIds) {
      const entry: Readonly<BlocklistEntryData> | undefined = entries.get(id);
      if (entry === undefined) continue;
      const effectiveMeta: Readonly<TelegramIdentityMetadata> =
        syncIdentityMetadataWithBotCache(id, entry.meta);
      const displayName: string = formatIdentityDisplayName(id, effectiveMeta);
      const username: string | undefined =
        effectiveMeta.username.length > 0 ? effectiveMeta.username : undefined;
      if (!matchesIdentitySearchQuery(id, displayName, username)(normalizedQuery)) {
        continue;
      }
      matchedItems.push({
        id,
        isChannel: id < 0,
        displayName,
        username,
        blockedAt: entry.blockedAt,
      });
    }
    const total: number = matchedItems.length;
    const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
    const page: number = Math.min(requestedPage, totalPages);
    const offset: number = (page - 1) * pageSize;
    return {
      items: matchedItems.slice(offset, offset + pageSize),
      page,
      pageSize,
      total,
      totalPages,
      whitelistTotal,
      blocklistTotal,
      nextAfterId: null,
    };
  }

  const slice: Readonly<CollectedIdentityPageSlice> = await collectIdentityPageIds(
    "blocklist",
    params,
    readBlocklistSweepPage
  );
  const whitelistTotal: number = getIdentityEntryCount("whitelist");
  if (slice.sliceIds.length === 0) {
    return {
      items: [],
      page: slice.page,
      pageSize: slice.pageSize,
      total: slice.total,
      totalPages: slice.totalPages,
      whitelistTotal,
      blocklistTotal: slice.total,
      nextAfterId: null,
    };
  }

  const entries: ReadonlyMap<number, Readonly<BlocklistEntryData>> =
    (await readIdentityPolicyEntries(slice.sliceIds)).blocklist;
  const items: Readonly<MiniAppBlocklistEntryView>[] = [];
  for (const id of slice.sliceIds) {
    const entry: Readonly<BlocklistEntryData> | undefined = entries.get(id);
    if (entry === undefined) continue;
    const effectiveMeta: Readonly<TelegramIdentityMetadata> =
      syncIdentityMetadataWithBotCache(id, entry.meta);
    items.push({
      id,
      isChannel: id < 0,
      displayName: formatIdentityDisplayName(id, effectiveMeta),
      username:
        effectiveMeta.username.length > 0 ? effectiveMeta.username : undefined,
      blockedAt: entry.blockedAt,
    });
  }

  return {
    items,
    page: slice.page,
    pageSize: slice.pageSize,
    total: slice.total,
    totalPages: slice.totalPages,
    whitelistTotal,
    blocklistTotal: slice.total,
    nextAfterId: slice.nextAfterId,
  };
}

/**
 * 新增或移除黑名单成员，并在所有受管管理员群有界并发执行跨群封禁或解封（与 `/block enable|disable` 同源）。
 * @param params 目标身份 ID、启用开关与可选展示资料。
 * @returns 黑名单变更及跨群处置结果。
 */
export async function setBlocklistEntryMembership({
  id,
  enabled,
  meta,
}: SetIdentityMembershipParams): Promise<Readonly<MiniAppIdentityMutationResult>> {
  if (!Number.isSafeInteger(id) || id === 0) {
    return {
      ok: false,
      changed: false,
      id,
      message: "INVALID_IDENTITY_ID",
    };
  }
  if (id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      id,
      message: "BLOCKLIST_SUPER_ADMIN_FORBIDDEN",
    };
  }
  const botUserId: number | undefined = currentBotUserId();
  if (enabled && botUserId !== undefined && id === botUserId) {
    return {
      ok: false,
      changed: false,
      id,
      message: "TARGET_SELF_FORBIDDEN",
    };
  }
  if (enabled && isInitializedManagedChatTarget(id)) {
    return {
      ok: false,
      changed: false,
      id,
      message: "TARGET_CURRENT_CHAT_FORBIDDEN",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      id,
      message: "IDENTITY_STORAGE_UNAVAILABLE",
    };
  }

  const isChannel: boolean = id < 0;

  return blocklistIdentityMutationRunner.run(
    id,
    async (): Promise<Readonly<MiniAppIdentityMutationResult>> => {
      if (enabled) {
        const resolvedMeta: Readonly<TelegramIdentityMetadata> =
          await resolveIdentityMetadataForMiniApp(id, meta);
        const mutationKind: "unavailable" | "whitelisted" | "duplicate" | "blocked" =
          await runProtectedIdentityMutation(
            async (): Promise<"unavailable" | "whitelisted" | "duplicate" | "blocked"> => {
              if (!isIdentityPolicyCached(id) && !await prefetchIdentityPolicies([id])) {
                return "unavailable";
              }
              if (isWhitelisted(id)) return "whitelisted";
              if (isUserBlocked(id)) return "duplicate";
              blockUser(id, resolvedMeta);
              return "blocked";
            }
          );
        if (mutationKind === "unavailable") {
          return {
            ok: false,
            changed: false,
            id,
            message: "IDENTITY_STORAGE_UNAVAILABLE",
          };
        }
        if (mutationKind === "whitelisted") {
          return {
            ok: false,
            changed: false,
            id,
            message: "IDENTITY_IN_WHITELIST",
          };
        }
        if (mutationKind === "duplicate") {
          return {
            ok: true,
            changed: false,
            duplicate: true,
            id,
            message: "BLOCKLIST_DUPLICATE",
          };
        }
        const persisted: boolean = await confirmBlocklistPersisted(id, false);
        const targetChatIds: number[] = managedAdminChatIds(0, false);
        let bannedCount: number = 0;
        if (targetChatIds.length > 0) {
          const outcomes: readonly ManagedChatOutcome<boolean>[] =
            await runManagedChatBatch<boolean>({
              chatIds: targetChatIds,
              action: `ban blocked identity ${id}`,
              onUnexpectedFailure: false,
              execute: (targetChatId: number): Promise<boolean> => {
                if (botCanRestrictMembersIn(targetChatId) === false) {
                  return Promise.resolve(false);
                }
                return isChannel
                  ? banChatSenderChat(targetChatId, id)
                  : banChatMember(targetChatId, id);
              },
            });
          for (const outcome of outcomes) {
            if (outcome.value) bannedCount++;
            else requestBlocklistResweep(outcome.chatId);
          }
        }
        return {
          ok: true,
          changed: true,
          duplicate: false,
          id,
          persisted,
          affectedChats: bannedCount,
          totalChats: targetChatIds.length,
          message: "BLOCKLIST_ADDED",
        };
      }

      const unblockOutcome: "unavailable" | "removed" | "absent" =
        await runProtectedIdentityMutation(
          async (): Promise<"unavailable" | "removed" | "absent"> => {
            if (!isIdentityPolicyCached(id) && !await prefetchIdentityPolicies([id])) {
              return "unavailable";
            }
            return unblockUser(id) ? "removed" : "absent";
          }
        );
      if (unblockOutcome === "unavailable") {
        return {
          ok: false,
          changed: false,
          id,
          message: "IDENTITY_STORAGE_UNAVAILABLE",
        };
      }
      const removedFromList: boolean = unblockOutcome === "removed";
      const persisted: boolean = await confirmBlocklistPersisted(id, !removedFromList);
      const targetChatIds: number[] = managedAdminChatIds(0, false);
      let unbannedCount: number = 0;
      if (targetChatIds.length > 0) {
        const outcomes: readonly ManagedChatOutcome<boolean>[] =
          await runManagedChatBatch<boolean>({
            chatIds: targetChatIds,
            action: `lift the ban on identity ${id}`,
            onUnexpectedFailure: false,
            execute: (targetChatId: number): Promise<boolean> => {
              if (botCanRestrictMembersIn(targetChatId) === false) {
                return Promise.resolve(false);
              }
              return isChannel
                ? unbanChatSenderChat(targetChatId, id)
                : unbanChatMemberIfBanned(targetChatId, id);
            },
          });
        for (const outcome of outcomes) {
          if (outcome.value) unbannedCount++;
        }
      }
      return {
        ok: true,
        changed: removedFromList,
        id,
        persisted,
        affectedChats: unbannedCount,
        totalChats: targetChatIds.length,
        message: removedFromList ? "BLOCKLIST_REMOVED" : "BLOCKLIST_NOT_FOUND",
      };
    }
  );
}
