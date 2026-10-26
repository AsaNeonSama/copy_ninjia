import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_MAX_PAGE_SIZE,
} from "../../consts/miniApp";
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
  SetMiniAppWhitelistPermissionParams,
} from "./metadata";

/** 白名单成员变更临界区返回结果。 */
type WhitelistMembershipOutcome =
  | { readonly kind: "blocked" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "updated"; readonly result: SetWhitelistMembershipResult };

/**
 * 分页列出持久化的白名单成员及其十八项细粒度权限（支持按名称、用户名或 ID 模糊搜索）。
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
    const allIds: readonly number[] = await collectAllIdentityIds(readWhitelistSweepPage);
    const whitelistTotal: number = Math.max(
      getIdentityEntryCount("whitelist"),
      allIds.length
    );
    const blocklistTotal: number = getIdentityEntryCount("blocklist");
    if (allIds.length > 0) {
      await prefetchIdentityPolicies(allIds);
    }
    const matchedItems: Readonly<MiniAppWhitelistEntryView>[] = [];
    for (const id of allIds) {
      const entry: Readonly<WhitelistEntryData> | undefined = cachedWhitelistEntry(id);
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
      message: "笨蛋杂鱼♡，连身份 ID 都填错啦（必须是非零安全整数）！",
    };
  }
  if (enabled && id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      message: "杂鱼♡，超级管理员天生就拥有全部最高权限，才不需要塞进白名单表呢！",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      message: "啧，身份策略存储暂时没空理你，杂鱼稍后再试♡",
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
    if (outcome.kind === "blocked") {
      return {
        ok: false,
        changed: false,
        message: `笨蛋杂鱼♡，ID ${id} 现在正关在黑名单里呢，想放进白名单就先去解封！`,
      };
    }
    if (outcome.kind === "duplicate") {
      return {
        ok: true,
        changed: false,
        duplicate: true,
        message: `笨蛋杂鱼♡，ID ${id} 早就已经在白名单里啦，不许重复添加！`,
      };
    }
    await confirmIdentityPolicyPersisted("whitelist", id, !outcome.result.changed);
    const changed: boolean = outcome.result.changed;
    return {
      ok: true,
      changed,
      duplicate: enabled ? !changed : false,
      message: enabled
        ? changed
          ? `哼，已帮杂鱼把 ID ${id} 放进白名单并授予默认权限啦♡`
          : `笨蛋杂鱼♡，ID ${id} 早就已经在白名单里啦！`
        : changed
          ? `哼，已经把 ID ${id} 从白名单里踢出去啦♡`
          : `杂鱼♡，ID ${id} 原本就不在白名单里哦。`,
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to persist the whitelist membership change for identity ${id}:`,
      error
    );
    return {
      ok: false,
      changed: false,
      message: "啧，白名单变更落盘失败了，杂鱼快去检查数据库写入状态♡",
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
