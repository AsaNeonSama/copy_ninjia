import { blocklistIdentityMutationRunner } from "../../../cache/main/blocklist";
import { SUPER_ADMIN_USER_ID } from "../../../config/bot";
import {
  blockUser,
  confirmBlocklistPersisted,
  isUserBlocked,
  managedAdminChatIds,
  unblockUser,
} from "../../../infra/blocklist/membership";
import {
  banBlockedIdentityInManagedChats,
  liftBlockedIdentityBanInManagedChats,
} from "../../../infra/blocklist/crossChatBan";
import { runProtectedIdentityMutation } from "../../../infra/identityPolicy/coordination";
import { isWhitelisted } from "../../../infra/identityPolicy/whitelist";
import {
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
} from "../../../infra/identityStorage";
import type {
  BlocklistEntryData,
  TelegramIdentityMetadata,
} from "../../../types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppBlocklistPage,
  MiniAppIdentityMutationResult,
} from "../../../types/miniApp/identities";
import {
  currentBotUserId,
  isInitializedManagedChatTarget,
  resolveIdentityMetadataForMiniApp,
} from "./metadata";
import type { SetIdentityMembershipParams } from "./metadata";
import { listIdentityPolicyPage } from "./page";
import type {
  IdentityPolicyEntryBaseView,
  ListIdentityPageParams,
} from "./page";

/**
 * 分页列出持久化的黑名单成员（支持按名称、用户名或 ID 模糊搜索）。
 * 条目经 `readIdentityPolicyEntries` 直接冷读并在本次请求内局部持有，不读写 Bot 的合并身份缓存。
 * @param params 页码 `page`、每页条数 `pageSize`、游标 `afterId` 或搜索关键字 `query`。
 * @returns 黑名单分页视图（含当前页、总页数、黑名单总数、白名单总数）。
 */
export function listBlocklistEntries(
  params: ListIdentityPageParams = {}
): Promise<Readonly<MiniAppBlocklistPage>> {
  return listIdentityPolicyPage({
    table: "blocklist",
    params,
    toView: (
      base: Readonly<IdentityPolicyEntryBaseView>,
      entry: Readonly<BlocklistEntryData>
    ): Readonly<MiniAppBlocklistEntryView> => ({
      ...base,
      blockedAt: entry.blockedAt,
    }),
  });
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
        // 没有受管群时不进入扇出，也就不做扇出后的停机撤销检查。
        const bannedCount: number = targetChatIds.length === 0
          ? 0
          : await banBlockedIdentityInManagedChats({ chatIds: targetChatIds, identityId: id, isChannel });
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
      const unbannedCount: number = targetChatIds.length === 0
        ? 0
        : await liftBlockedIdentityBanInManagedChats({ chatIds: targetChatIds, identityId: id, isChannel });
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
