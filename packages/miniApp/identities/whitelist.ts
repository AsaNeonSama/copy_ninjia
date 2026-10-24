import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import { isUserBlocked } from "../../infra/blocklist/membership";
import { runProtectedIdentityMutation } from "../../infra/identityPolicy/coordination";
import {
  enableAllWhitelistPermissions,
  isWhitelisted,
  setWhitelistMembership,
  setWhitelistPermission,
} from "../../infra/identityPolicy/whitelist";
import type {
  SetWhitelistMembershipResult,
  SetWhitelistPermissionResult,
} from "../../infra/identityPolicy/whitelist";
import {
  cachedWhitelistEntry,
  confirmIdentityPolicyPersisted,
  getIdentityEntryCount,
  prefetchIdentityPolicies,
  readWhitelistSweepPage,
} from "../../infra/identityStorage";
import { logger } from "../../infra/logger";
import type {
  TelegramIdentityMetadata,
  WhitelistEntryData,
} from "../../types/identityPolicy";
import type {
  MiniAppIdentityMutationResult,
  MiniAppPermissionDescriptor,
  MiniAppWhitelistEntryView,
  MiniAppWhitelistPage,
} from "../../types/miniApp";
import {
  buildPermissionDescriptors,
  collectIdentityPageIds,
  formatIdentityDisplayName,
  resolveIdentityMetadataForMiniApp,
} from "./metadata";
import type {
  CollectedIdentityPageSlice,
  ListIdentityPageParams,
  SetIdentityMembershipParams,
  SetMiniAppWhitelistPermissionParams,
} from "./metadata";

/** 白名单成员变更临界区返回结果。 */
type WhitelistMembershipOutcome =
  | { readonly kind: "blocked" }
  | { readonly kind: "updated"; readonly result: SetWhitelistMembershipResult };

/**
 * 分页列出持久化的白名单成员及其十八项细粒度权限。
 * @param params 页码 `page`、每页条数 `pageSize`（或游标 `afterId` 与 `limit`）。
 * @returns 白名单分页视图（含当前页、总页数、白名单总数、黑名单总数）及权限说明列表。
 */
export async function listWhitelistEntries(
  params: ListIdentityPageParams = {}
): Promise<Readonly<MiniAppWhitelistPage>> {
  const permissionDescriptors: readonly Readonly<MiniAppPermissionDescriptor>[] =
    buildPermissionDescriptors();
  const slice: Readonly<CollectedIdentityPageSlice> = await collectIdentityPageIds(
    "whitelist",
    params,
    readWhitelistSweepPage
  );
  const blocklistTotal: number = getIdentityEntryCount("blocklist");
  if (slice.sliceIds.length === 0) {
    return {
      items: [],
      page: slice.page,
      pageSize: slice.pageSize,
      total: slice.total,
      totalPages: slice.totalPages,
      whitelistTotal: slice.total,
      blocklistTotal,
      nextAfterId: null,
      permissionDescriptors,
    };
  }

  await prefetchIdentityPolicies(slice.sliceIds);
  const items: Readonly<MiniAppWhitelistEntryView>[] = [];
  for (const id of slice.sliceIds) {
    const entry: Readonly<WhitelistEntryData> | undefined = cachedWhitelistEntry(id);
    if (entry === undefined) continue;
    items.push({
      id,
      isChannel: id < 0,
      displayName: formatIdentityDisplayName(id, entry.meta),
      username: entry.meta.username.length > 0 ? entry.meta.username : undefined,
      permissions: { ...entry.permissions },
    });
  }

  return {
    items,
    page: slice.page,
    pageSize: slice.pageSize,
    total: slice.total,
    totalPages: slice.totalPages,
    whitelistTotal: slice.total,
    blocklistTotal,
    nextAfterId: slice.nextAfterId,
    permissionDescriptors,
  };
}

/**
 * 新增或移除白名单成员（与 `/white` 共享同一互斥临界区与 Disk I/O 落盘确认）。
 * @param params 目标身份 ID、启用开关与可选展示资料。
 * @returns 操作结果与回执文案。
 */
export async function setWhitelistEntryMembership({
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
  if (enabled && id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      message: "超级管理员由身份直接授予全部权限，无需加入白名单表。",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      message: "身份策略存储暂不可用，请稍后重试。",
    };
  }

  const resolvedMeta: Readonly<TelegramIdentityMetadata> | undefined = enabled
    ? await resolveIdentityMetadataForMiniApp(id, meta)
    : undefined;

  try {
    const outcome: WhitelistMembershipOutcome = await runProtectedIdentityMutation(
      (): WhitelistMembershipOutcome => {
        if (enabled && isUserBlocked(id)) {
          return { kind: "blocked" };
        }
        return {
          kind: "updated",
          result: setWhitelistMembership({
            id,
            enabled,
            meta: resolvedMeta,
          }),
        };
      }
    );
    if (outcome.kind === "blocked") {
      return {
        ok: false,
        changed: false,
        message: `ID ${id} 当前在黑名单中，请先解除黑名单后再加入白名单。`,
      };
    }
    await confirmIdentityPolicyPersisted("whitelist", id, !outcome.result.changed);
    const changed: boolean = outcome.result.changed;
    return {
      ok: true,
      changed,
      message: enabled
        ? changed
          ? `已将 ID ${id} 加入白名单并授予默认权限。`
          : `ID ${id} 原本已在白名单中。`
        : changed
          ? `已将 ID ${id} 移出白名单。`
          : `ID ${id} 原本不在白名单中。`,
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to persist the whitelist membership change for identity ${id}:`,
      error
    );
    return {
      ok: false,
      changed: false,
      message: "白名单变更落盘失败，请检查数据库写入状态。",
    };
  }
}

/**
 * 修改白名单成员的单项细粒度权限（与 `/permission <target> <key> <value>` 同源）。
 * @param params 目标白名单身份 ID、权限键与目标布尔值。
 * @returns 权限变更结果。
 */
export async function setWhitelistEntryPermission({
  id,
  key,
  value,
}: SetMiniAppWhitelistPermissionParams): Promise<Readonly<MiniAppIdentityMutationResult>> {
  if (id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      message: "超级管理员恒拥有全部权限，不受白名单表单项开关控制。",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      message: "身份策略存储暂不可用，请稍后重试。",
    };
  }
  if (!isWhitelisted(id)) {
    return {
      ok: false,
      changed: false,
      message: `ID ${id} 尚未加入白名单，请先添加至白名单。`,
    };
  }

  try {
    const result: SetWhitelistPermissionResult = setWhitelistPermission({
      id,
      key,
      value,
    });
    await confirmIdentityPolicyPersisted("whitelist", id, !result.changed);
    return {
      ok: true,
      changed: result.changed,
      message: result.changed
        ? `已将 ID ${id} 的 ${key} 设为 ${String(value)}。`
        : `ID ${id} 的 ${key} 原本就是 ${String(value)}。`,
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to persist the whitelist permission change for identity ${id}:`,
      error
    );
    return {
      ok: false,
      changed: false,
      message: "权限变更落盘失败，请检查数据库写入状态。",
    };
  }
}

/**
 * 一键开启指定白名单成员的全部十八项权限（与 `/permission <target> all` 同源）。
 * @param id 目标白名单身份 ID。
 * @returns 权限变更结果。
 */
export async function enableAllWhitelistEntryPermissions(
  id: number
): Promise<Readonly<MiniAppIdentityMutationResult>> {
  if (id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      message: "超级管理员恒拥有全部权限。",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      message: "身份策略存储暂不可用，请稍后重试。",
    };
  }
  if (!isWhitelisted(id)) {
    return {
      ok: false,
      changed: false,
      message: `ID ${id} 尚未加入白名单，请先添加至白名单。`,
    };
  }

  try {
    const result: SetWhitelistPermissionResult = enableAllWhitelistPermissions(id);
    await confirmIdentityPolicyPersisted("whitelist", id, !result.changed);
    return {
      ok: true,
      changed: result.changed,
      message: result.changed
        ? `已开启 ID ${id} 的全部白名单权限。`
        : `ID ${id} 的全部权限原本已开启。`,
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to persist enable-all permissions for identity ${id}:`,
      error
    );
    return {
      ok: false,
      changed: false,
      message: "权限变更落盘失败，请检查数据库写入状态。",
    };
  }
}
