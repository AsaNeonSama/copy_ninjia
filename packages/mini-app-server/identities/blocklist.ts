import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_MAX_PAGE_SIZE,
} from "../../consts/miniApp";
import {
  blockUser,
  confirmBlocklistPersisted,
  isUserBlocked,
  managedAdminChatIds,
  runManagedChatBatch,
  unblockUser,
} from "../../infra/blocklist/membership";
import type { ManagedChatOutcome } from "../../infra/blocklist/membership";
import { requestBlocklistResweep } from "../../infra/blocklist/sweep";
import { botCanRestrictMembersIn } from "../../infra/botAdmin";
import { runProtectedIdentityMutation } from "../../infra/identityPolicy/coordination";
import { isWhitelisted } from "../../infra/identityPolicy/whitelist";
import {
  cachedBlocklistEntry,
  getIdentityEntryCount,
  prefetchIdentityPolicies,
  readBlocklistSweepPage,
} from "../../infra/identityStorage";
import {
  banChatMember,
  banChatSenderChat,
  unbanChatMemberIfBanned,
  unbanChatSenderChat,
} from "../../infra/telegram/actions/moderation";
import type {
  BlocklistEntryData,
  TelegramIdentityMetadata,
} from "../../types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppBlocklistPage,
  MiniAppIdentityMutationResult,
} from "../../types/miniApp";
import {
  collectAllIdentityIds,
  collectIdentityPageIds,
  formatIdentityDisplayName,
  matchesIdentitySearchQuery,
  resolveIdentityMetadataForMiniApp,
} from "./metadata";
import type {
  CollectedIdentityPageSlice,
  ListIdentityPageParams,
  SetIdentityMembershipParams,
} from "./metadata";

/**
 * 分页列出持久化的黑名单成员（支持按名称、用户名或 ID 模糊搜索）。
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
    const allIds: readonly number[] = await collectAllIdentityIds(readBlocklistSweepPage);
    const blocklistTotal: number = Math.max(
      getIdentityEntryCount("blocklist"),
      allIds.length
    );
    const whitelistTotal: number = getIdentityEntryCount("whitelist");
    if (allIds.length > 0) {
      await prefetchIdentityPolicies(allIds);
    }
    const matchedItems: Readonly<MiniAppBlocklistEntryView>[] = [];
    for (const id of allIds) {
      const entry: Readonly<BlocklistEntryData> | undefined = cachedBlocklistEntry(id);
      if (entry === undefined) continue;
      const displayName: string = formatIdentityDisplayName(id, entry.meta);
      const username: string | undefined =
        entry.meta.username.length > 0 ? entry.meta.username : undefined;
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

  await prefetchIdentityPolicies(slice.sliceIds);
  const items: Readonly<MiniAppBlocklistEntryView>[] = [];
  for (const id of slice.sliceIds) {
    const entry: Readonly<BlocklistEntryData> | undefined = cachedBlocklistEntry(id);
    if (entry === undefined) continue;
    items.push({
      id,
      isChannel: id < 0,
      displayName: formatIdentityDisplayName(id, entry.meta),
      username: entry.meta.username.length > 0 ? entry.meta.username : undefined,
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
      message: "笨蛋杂鱼♡，连身份 ID 都填错啦（必须是非零安全整数）！",
    };
  }
  if (id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      message: "笨蛋杂鱼♡，居然想把超级管理员关进黑名单？做梦去吧！",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      message: "啧，身份策略存储暂时没空理你，杂鱼稍后再试♡",
    };
  }

  const isChannel: boolean = id < 0;
  const targetChatIds: number[] = managedAdminChatIds(0, false);

  if (enabled) {
    const resolvedMeta: Readonly<TelegramIdentityMetadata> =
      await resolveIdentityMetadataForMiniApp(id, meta);
    const mutationKind: "whitelisted" | "duplicate" | "blocked" =
      await runProtectedIdentityMutation(
        (): "whitelisted" | "duplicate" | "blocked" => {
          if (isWhitelisted(id)) return "whitelisted";
          if (isUserBlocked(id)) return "duplicate";
          blockUser(id, resolvedMeta);
          return "blocked";
        }
      );
    if (mutationKind === "whitelisted") {
      return {
        ok: false,
        changed: false,
        message: `笨蛋杂鱼♡，ID ${id} 受白名单保护呢，不许直接塞进黑名单！`,
      };
    }
    if (mutationKind === "duplicate") {
      return {
        ok: true,
        changed: false,
        duplicate: true,
        message: `笨蛋杂鱼♡，ID ${id} 早就已经在黑名单里啦，不许重复添加！`,
      };
    }
    const persisted: boolean = await confirmBlocklistPersisted(id, false);
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
    const persistNote: string = persisted ? "" : "（注意：磁盘持久化确认未完成）";
    const fanOutNote: string = targetChatIds.length > 0
      ? `，已在 ${bannedCount}/${targetChatIds.length} 个受管群执行封禁`
      : "";
    return {
      ok: true,
      changed: true,
      duplicate: false,
      message: `哼，已帮杂鱼把 ID ${id} 关进黑名单啦${fanOutNote}${persistNote}♡`,
    };
  }

  const removedFromList: boolean = unblockUser(id);
  const persisted: boolean = await confirmBlocklistPersisted(id, !removedFromList);
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
  const persistNote: string = persisted ? "" : "（注意：磁盘持久化确认未完成）";
  const fanOutNote: string = targetChatIds.length > 0
    ? `，已在 ${unbannedCount}/${targetChatIds.length} 个受管群解除封禁`
    : "";
  return {
    ok: true,
    changed: removedFromList,
    message: `${removedFromList ? `哼，已把 ID ${id} 从黑名单放出来啦` : `杂鱼，ID ${id} 原本就不在黑名单里`}${fanOutNote}${persistNote}♡`,
  };
}
