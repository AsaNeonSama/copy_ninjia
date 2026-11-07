import { SUPER_ADMIN_USER_ID } from "../../../config/bot";
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
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
} from "../../../infra/identityStorage";
import { logger } from "../../../infra/logger";
import type {
  TelegramIdentityMetadata,
  WhitelistEntryData,
  WhitelistPermissionKey,
} from "../../../types/identityPolicy";
import type {
  MiniAppIdentityMutationResult,
  MiniAppPermissionDescriptor,
  MiniAppWhitelistEntryView,
  MiniAppWhitelistPage,
} from "../../../types/miniApp";
import {
  buildPermissionDescriptors,
  currentBotUserId,
  isInitializedManagedChatTarget,
  resolveIdentityMetadataForMiniApp,
} from "./metadata";
import type {
  SetIdentityMembershipParams,
  SetMiniAppWhitelistPermissionParams,
} from "./metadata";
import { listIdentityPolicyPage } from "./page";
import type {
  IdentityPolicyEntryBaseView,
  IdentityPolicyPageResult,
  ListIdentityPageParams,
} from "./page";

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

/** 白名单权限修改事务的附加回显字段（单项修改携带 `key` 与 `value`，全开为空对象）。 */
interface WhitelistPermissionMutationEcho {
  /** 变更的权限键名。 */
  readonly key?: WhitelistPermissionKey;
  /** 变更的目标布尔值。 */
  readonly value?: boolean;
}

/** `mutateWhitelistEntryPermissions` 的入参。 */
interface MutateWhitelistEntryPermissionsParams {
  /** 目标白名单身份 ID。 */
  readonly id: number;
  /** 在互斥临界区内执行内存权限修改的回调。 */
  readonly apply: () => SetWhitelistPermissionResult;
  /** 拼入返回结果的附加回显字段。 */
  readonly echo: Readonly<WhitelistPermissionMutationEcho>;
  /** 发生实际变更时的回执编码。 */
  readonly changedMessage: string;
  /** 权限值未变化时的回执编码。 */
  readonly unchangedMessage: string;
  /** 持久化失败时的英文错误日志前缀。 */
  readonly failureLog: string;
}

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
  const page: Readonly<IdentityPolicyPageResult<MiniAppWhitelistEntryView>> =
    await listIdentityPolicyPage({
      table: "whitelist",
      params,
      toView: (
        base: Readonly<IdentityPolicyEntryBaseView>,
        entry: Readonly<WhitelistEntryData>
      ): Readonly<MiniAppWhitelistEntryView> => ({
        ...base,
        permissions: { ...entry.permissions },
      }),
    });
  return { ...page, permissionDescriptors };
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
 * 执行白名单成员权限修改的共享事务骨架：超级管理员豁免拦截、冷读预取、互斥临界区执行与落盘确认。
 * @param params 权限修改事务参数。
 * @returns 权限变更结果。
 */
async function mutateWhitelistEntryPermissions({
  id,
  apply,
  echo,
  changedMessage,
  unchangedMessage,
  failureLog,
}: MutateWhitelistEntryPermissionsParams): Promise<Readonly<MiniAppIdentityMutationResult>> {
  if (id === SUPER_ADMIN_USER_ID) {
    return {
      ok: false,
      changed: false,
      id,
      ...echo,
      message: "SUPER_ADMIN_EXEMPT",
    };
  }
  if (!await prefetchIdentityPolicies([id])) {
    return {
      ok: false,
      changed: false,
      id,
      ...echo,
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
          result: apply(),
        };
      }
    );
    if (outcome.kind === "unavailable") {
      return {
        ok: false,
        changed: false,
        id,
        ...echo,
        message: "IDENTITY_STORAGE_UNAVAILABLE",
      };
    }
    if (outcome.kind === "notFound") {
      return {
        ok: false,
        changed: false,
        id,
        ...echo,
        message: "WHITELIST_NOT_FOUND",
      };
    }
    await confirmIdentityPolicyPersisted("whitelist", id, !outcome.result.changed);
    return {
      ok: true,
      changed: outcome.result.changed,
      id,
      ...echo,
      message: outcome.result.changed ? changedMessage : unchangedMessage,
    };
  } catch (error: unknown) {
    logger.error(`${failureLog} for identity ${id}:`, error);
    return {
      ok: false,
      changed: false,
      id,
      ...echo,
      message: "PERMISSION_PERSIST_FAILED",
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
  return mutateWhitelistEntryPermissions({
    id,
    apply: (): SetWhitelistPermissionResult =>
      setWhitelistPermission({ id, key, value }),
    echo: { key, value },
    changedMessage: "PERMISSION_UPDATED",
    unchangedMessage: "PERMISSION_UNCHANGED",
    failureLog: "Failed to persist the whitelist permission change",
  });
}

/**
 * 一键开启指定白名单成员的全部十八项权限（与 `/permission <target> all` 同源）。
 * @param id 目标白名单身份 ID。
 * @returns 权限变更结果。
 */
export async function enableAllWhitelistEntryPermissions(
  id: number
): Promise<Readonly<MiniAppIdentityMutationResult>> {
  return mutateWhitelistEntryPermissions({
    id,
    apply: (): SetWhitelistPermissionResult => enableAllWhitelistPermissions(id),
    echo: {},
    changedMessage: "ALL_PERMISSIONS_ENABLED",
    unchangedMessage: "ALL_PERMISSIONS_UNCHANGED",
    failureLog: "Failed to persist enable-all permissions",
  });
}
