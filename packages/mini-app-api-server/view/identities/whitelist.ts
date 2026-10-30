import { SUPER_ADMIN_USER_ID } from "../../../config/bot";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_MAX_PAGE_SIZE,
} from "../../../consts/miniApp";
import { isUserBlocked } from "../../../infra/blocklist/membership";
import { runProtectedIdentityMutation } from "../../../infra/identityPolicy/coordination";
import {
  enableAllWhitelistPermissions,
  isWhitelisted,
  setWhitelistMembership,
  setWhitelistPermission,
} from "../../../infra/identityPolicy/whitelist";
import type {
  SetWhitelistMembershipResult,
  SetWhitelistPermissionResult,
} from "../../../infra/identityPolicy/whitelist";
import {
  confirmIdentityPolicyPersisted,
  getIdentityEntryCount,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
  readIdentityPolicyEntries,
  readWhitelistSweepPage,
} from "../../../infra/identityStorage";
import { logger } from "../../../infra/logger";
import type {
  TelegramIdentityMetadata,
  WhitelistEntryData,
} from "../../../types/identityPolicy";
import type {
  MiniAppIdentityMutationResult,
  MiniAppPermissionDescriptor,
  MiniAppWhitelistEntryView,
  MiniAppWhitelistPage,
} from "../../../types/miniApp";
import {
  buildPermissionDescriptors,
  collectAllIdentityIds,
  collectIdentityPageIds,
  currentBotUserId,
  formatIdentityDisplayName,
  isInitializedManagedChatTarget,
  matchesIdentitySearchQuery,
  resolveIdentityMetadataForMiniApp,
  syncIdentityMetadataWithBotCache,
  toIdentitySearchQuery,
} from "./metadata";
import type {
  CollectedIdentityPageSlice,
  IdentitySearchQuery,
  ListIdentityPageParams,
  SetIdentityMembershipParams,
  SetMiniAppWhitelistPermissionParams,
} from "./metadata";

/** 白名单成员变更临界区返回结果。 */
type WhitelistMembershipOutcome =
  | { readonly kind: "unavailable" }
  | { readonly kind: "blocked" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "updated"; readonly result: SetWhitelistMembershipResult };

/** 白名单权限修改临界区返回结果。 */
type WhitelistPermissionOutcome =
  | { readonly kind: "unavailable" }
  | { readonly kind: "notFound" }
  | { readonly kind: "updated"; readonly result: SetWhitelistPermissionResult };

/**
 * 分页列出持久化的白名单成员及其十八项细粒度权限（支持按名称、用户名或 ID 模糊搜索）。
 * 条目经 `readIdentityPolicyEntries` 直接冷读并在本次请求内局部持有，不读写 Bot 的合并身份缓存。
 * @param params 页码 `page`、每页条数 `pageSize`、游标 `afterId` 或搜索关键字 `query`。
 * @returns 白名单分页视图（含当前页、总页数、白名单总数、黑名单总数）及权限说明列表。
 */
export async function listWhitelistEntries(
  params: ListIdentityPageParams = {}
): Promise<Readonly<MiniAppWhitelistPage>> {
  const permissionDescriptors: readonly Readonly<MiniAppPermissionDescriptor>[] =
    buildPermissionDescriptors();
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
      readWhitelistSweepPage,
      "whitelist"
    );
    const whitelistTotal: number = Math.max(
      getIdentityEntryCount("whitelist"),
      allIds.length
    );
    const blocklistTotal: number = getIdentityEntryCount("blocklist");
    const entries: ReadonlyMap<number, Readonly<WhitelistEntryData>> =
      (await readIdentityPolicyEntries(allIds)).whitelist;
    const searchQuery: Readonly<IdentitySearchQuery> = toIdentitySearchQuery(normalizedQuery);
    const matchedItems: Readonly<MiniAppWhitelistEntryView>[] = [];
    for (const id of allIds) {
      const entry: Readonly<WhitelistEntryData> | undefined = entries.get(id);
      if (entry === undefined) continue;
      const effectiveMeta: Readonly<TelegramIdentityMetadata> =
        syncIdentityMetadataWithBotCache(id, entry.meta);
      const displayName: string = formatIdentityDisplayName(id, effectiveMeta);
      const username: string | undefined =
        effectiveMeta.username.length > 0 ? effectiveMeta.username : undefined;
      if (!matchesIdentitySearchQuery(searchQuery, { id, displayName, username })) {
        continue;
      }
      matchedItems.push({
        id,
        isChannel: id < 0,
        displayName,
        username,
        permissions: { ...entry.permissions },
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
      permissionDescriptors,
    };
  }

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

  const entries: ReadonlyMap<number, Readonly<WhitelistEntryData>> =
    (await readIdentityPolicyEntries(slice.sliceIds)).whitelist;
  const items: Readonly<MiniAppWhitelistEntryView>[] = [];
  for (const id of slice.sliceIds) {
    const entry: Readonly<WhitelistEntryData> | undefined = entries.get(id);
    if (entry === undefined) continue;
    const effectiveMeta: Readonly<TelegramIdentityMetadata> =
      syncIdentityMetadataWithBotCache(id, entry.meta);
    items.push({
      id,
      isChannel: id < 0,
      displayName: formatIdentityDisplayName(id, effectiveMeta),
      username:
        effectiveMeta.username.length > 0 ? effectiveMeta.username : undefined,
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
      id,
      message: "INVALID_IDENTITY_ID",
    };
  }
  if (enabled && id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      id,
      message: "SUPER_ADMIN_EXEMPT",
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

  const resolvedMeta: Readonly<TelegramIdentityMetadata> | undefined = enabled
    ? await resolveIdentityMetadataForMiniApp(id, meta)
    : undefined;

  try {
    const outcome: WhitelistMembershipOutcome = await runProtectedIdentityMutation(
      async (): Promise<WhitelistMembershipOutcome> => {
        if (!isIdentityPolicyCached(id) && !await prefetchIdentityPolicies([id])) {
          return { kind: "unavailable" };
        }
        if (enabled && isUserBlocked(id)) {
          return { kind: "blocked" };
        }
        if (enabled && isWhitelisted(id)) {
          return { kind: "duplicate" };
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
    if (outcome.kind === "unavailable") {
      return {
        ok: false,
        changed: false,
        id,
        message: "IDENTITY_STORAGE_UNAVAILABLE",
      };
    }
    if (outcome.kind === "blocked") {
      return {
        ok: false,
        changed: false,
        id,
        message: "IDENTITY_IN_BLOCKLIST",
      };
    }
    if (outcome.kind === "duplicate") {
      return {
        ok: true,
        changed: false,
        duplicate: true,
        id,
        message: "WHITELIST_DUPLICATE",
      };
    }
    await confirmIdentityPolicyPersisted("whitelist", id, !outcome.result.changed);
    const changed: boolean = outcome.result.changed;
    return {
      ok: true,
      changed,
      duplicate: enabled ? !changed : false,
      id,
      message: enabled
        ? changed
          ? "WHITELIST_ADDED"
          : "WHITELIST_DUPLICATE"
        : changed
          ? "WHITELIST_REMOVED"
          : "WHITELIST_NOT_FOUND",
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to persist the whitelist membership change for identity ${id}:`,
      error
    );
    return {
      ok: false,
      changed: false,
      id,
      message: "WHITELIST_PERSIST_FAILED",
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
      id,
      key,
      value,
      message: "SUPER_ADMIN_EXEMPT",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      id,
      key,
      value,
      message: "IDENTITY_STORAGE_UNAVAILABLE",
    };
  }
  try {
    const outcome: WhitelistPermissionOutcome = await runProtectedIdentityMutation(
      async (): Promise<WhitelistPermissionOutcome> => {
        if (!isIdentityPolicyCached(id) && !await prefetchIdentityPolicies([id])) {
          return { kind: "unavailable" };
        }
        if (!isWhitelisted(id)) {
          return { kind: "notFound" };
        }
        return {
          kind: "updated",
          result: setWhitelistPermission({
            id,
            key,
            value,
          }),
        };
      }
    );
    if (outcome.kind === "unavailable") {
      return {
        ok: false,
        changed: false,
        id,
        key,
        value,
        message: "IDENTITY_STORAGE_UNAVAILABLE",
      };
    }
    if (outcome.kind === "notFound") {
      return {
        ok: false,
        changed: false,
        id,
        key,
        value,
        message: "WHITELIST_NOT_FOUND",
      };
    }
    await confirmIdentityPolicyPersisted("whitelist", id, !outcome.result.changed);
    return {
      ok: true,
      changed: outcome.result.changed,
      id,
      key,
      value,
      message: outcome.result.changed ? "PERMISSION_UPDATED" : "PERMISSION_UNCHANGED",
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to persist the whitelist permission change for identity ${id}:`,
      error
    );
    return {
      ok: false,
      changed: false,
      id,
      key,
      value,
      message: "PERMISSION_PERSIST_FAILED",
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
      id,
      message: "SUPER_ADMIN_EXEMPT",
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

  try {
    const outcome: WhitelistPermissionOutcome = await runProtectedIdentityMutation(
      async (): Promise<WhitelistPermissionOutcome> => {
        if (!isIdentityPolicyCached(id) && !await prefetchIdentityPolicies([id])) {
          return { kind: "unavailable" };
        }
        if (!isWhitelisted(id)) {
          return { kind: "notFound" };
        }
        return {
          kind: "updated",
          result: enableAllWhitelistPermissions(id),
        };
      }
    );
    if (outcome.kind === "unavailable") {
      return {
        ok: false,
        changed: false,
        id,
        message: "IDENTITY_STORAGE_UNAVAILABLE",
      };
    }
    if (outcome.kind === "notFound") {
      return {
        ok: false,
        changed: false,
        id,
        message: "WHITELIST_NOT_FOUND",
      };
    }
    await confirmIdentityPolicyPersisted("whitelist", id, !outcome.result.changed);
    return {
      ok: true,
      changed: outcome.result.changed,
      id,
      message: outcome.result.changed ? "ALL_PERMISSIONS_ENABLED" : "ALL_PERMISSIONS_UNCHANGED",
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to persist enable-all permissions for identity ${id}:`,
      error
    );
    return {
      ok: false,
      changed: false,
      id,
      message: "PERMISSION_PERSIST_FAILED",
    };
  }
}
