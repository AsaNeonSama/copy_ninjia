import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  blockUser,
  confirmBlocklistPersisted,
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
  collectIdentityPageIds,
  formatIdentityDisplayName,
  resolveIdentityMetadataForMiniApp,
} from "./metadata";
import type {
  CollectedIdentityPageSlice,
  ListIdentityPageParams,
  SetIdentityMembershipParams,
} from "./metadata";

/**
 * 分页列出持久化的黑名单成员。
 * @param params 页码 `page`、每页条数 `pageSize`（或游标 `afterId` 与 `limit`）。
 * @returns 黑名单分页视图（含当前页、总页数、黑名单总数、白名单总数）。
 */
export async function listBlocklistEntries(
  params: ListIdentityPageParams = {}
): Promise<Readonly<MiniAppBlocklistPage>> {
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
      message: "无效的身份 ID（必须为非零安全整数）。",
    };
  }
  if (id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      message: "不能将超级管理员加入黑名单。",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      message: "身份策略存储暂不可用，请稍后重试。",
    };
  }

  const isChannel: boolean = id < 0;
  const targetChatIds: number[] = managedAdminChatIds(0, false);

  if (enabled) {
    const resolvedMeta: Readonly<TelegramIdentityMetadata> =
      await resolveIdentityMetadataForMiniApp(id, meta);
    const newlyBlocked: boolean | undefined = await runProtectedIdentityMutation(
      (): boolean | undefined =>
        isWhitelisted(id) ? undefined : blockUser(id, resolvedMeta)
    );
    if (newlyBlocked === undefined) {
      return {
        ok: false,
        changed: false,
        message: `ID ${id} 处于白名单保护范围内，拒绝加入黑名单。`,
      };
    }
    const persisted: boolean = await confirmBlocklistPersisted(id, !newlyBlocked);
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
      changed: newlyBlocked,
      message: `${newlyBlocked ? `已将 ID ${id} 加入黑名单` : `ID ${id} 已在黑名单中`}${fanOutNote}${persistNote}。`,
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
    message: `${removedFromList ? `已将 ID ${id} 移出黑名单` : `ID ${id} 原本不在黑名单中`}${fanOutNote}${persistNote}。`,
  };
}
