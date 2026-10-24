import type { ChatFullInfo } from "grammy/types";
import {
  MINI_APP_BIDI_CONTROL_CHARS_PATTERN,
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_MAX_PAGE_SIZE,
} from "../../consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../consts/whitelist";
import { chatAtmosphere } from "../../infra/atmosphere";
import {
  getIdentityEntryCount,
  identityMetadataFromCachedUser,
} from "../../infra/identityStorage";
import { probeTelegramChatInfoSilent } from "../../infra/telegram/actions/miniApp";
import { resolveIdTarget } from "../../users/senderIdentity";
import type { CachedUser } from "../../types/chatState";
import type {
  IdentityPolicyTable,
  TelegramIdentityMetadata,
  WhitelistPermissionKey,
} from "../../types/identityPolicy";
import type { BlocklistIdPage } from "../../types/identityStorage";
import type { MiniAppPermissionDescriptor } from "../../types/miniApp";

/** 分页查询白名单或黑名单的入参。 */
export interface ListIdentityPageParams {
  /** 页码（从 1 开始；未传 `afterId` 时按页码分页）。 */
  readonly page?: number;
  /** 每页条数（`1..MINI_APP_IDENTITY_MAX_PAGE_SIZE`，与 `limit` 同义）。 */
  readonly pageSize?: number;
  /** 游标起点 ID（返回严格大于 `afterId` 的记录；首页传 `null` 或省略）。 */
  readonly afterId?: number | null;
  /** 单页返回条数上限（`1..MINI_APP_IDENTITY_MAX_PAGE_SIZE`）。 */
  readonly limit?: number;
}

/** 身份名单分页切片与总量统计结果。 */
export interface CollectedIdentityPageSlice {
  /** 当前页目标身份 ID 列表。 */
  readonly sliceIds: readonly number[];
  /** 规范化后的当前页码（从 1 开始）。 */
  readonly page: number;
  /** 规范化后的每页条数。 */
  readonly pageSize: number;
  /** 当前名单总条数。 */
  readonly total: number;
  /** 当前名单总页数（至少为 1）。 */
  readonly totalPages: number;
  /** 下一页游标 ID；无下一页时为 `null`。 */
  readonly nextAfterId: number | null;
}

/**
 * 按页码（`page` + `pageSize`）或游标（`afterId` + `limit`）收集一页身份 ID 及总条数/总页数统计。
 *
 * @param table 目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。
 * @param params 分页查询参数。
 * @param readSweepPage 底层游标页读取函数。
 * @returns 当前页身份 ID 列表及分页统计元数据。
 */
export async function collectIdentityPageIds(
  table: IdentityPolicyTable,
  params: ListIdentityPageParams,
  readSweepPage: (afterId: number | null) => Promise<BlocklistIdPage>
): Promise<Readonly<CollectedIdentityPageSlice>> {
  const rawPageSize: number =
    params.pageSize ?? params.limit ?? MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE;
  const pageSize: number = Math.min(
    MINI_APP_IDENTITY_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(rawPageSize))
  );
  const requestedPage: number = Math.max(1, Math.trunc(params.page ?? 1));
  const knownTotal: number = getIdentityEntryCount(table);

  if (params.afterId !== undefined && params.afterId !== null) {
    const cursorSweep: BlocklistIdPage = await readSweepPage(params.afterId);
    const sliceIds: readonly number[] = cursorSweep.ids.slice(0, pageSize);
    const hasMore: boolean =
      cursorSweep.ids.length > sliceIds.length || !cursorSweep.done;
    const nextAfterId: number | null =
      hasMore && sliceIds.length > 0 ? sliceIds[sliceIds.length - 1]! : null;
    const total: number = Math.max(knownTotal, sliceIds.length);
    const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
    return {
      sliceIds,
      page: requestedPage,
      pageSize,
      total,
      totalPages,
      nextAfterId,
    };
  }

  const firstSweep: BlocklistIdPage = await readSweepPage(null);
  if (firstSweep.done) {
    const total: number = Math.max(knownTotal, firstSweep.ids.length);
    const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
    const page: number = Math.min(requestedPage, totalPages);
    const offset: number = (page - 1) * pageSize;
    const sliceIds: readonly number[] = firstSweep.ids.slice(
      offset,
      offset + pageSize
    );
    const hasMore: boolean = offset + sliceIds.length < firstSweep.ids.length;
    const nextAfterId: number | null =
      hasMore && sliceIds.length > 0 ? sliceIds[sliceIds.length - 1]! : null;
    return {
      sliceIds,
      page,
      pageSize,
      total,
      totalPages,
      nextAfterId,
    };
  }

  let total: number = Math.max(knownTotal, firstSweep.ids.length);
  let totalPages: number = Math.max(1, Math.ceil(total / pageSize));
  const page: number = Math.min(requestedPage, totalPages);
  const offset: number = (page - 1) * pageSize;
  const targetEnd: number = offset + pageSize;
  const sliceIds: number[] = [];
  let scanned: number = 0;
  let currentSweep: BlocklistIdPage = firstSweep;

  while (true) {
    for (const id of currentSweep.ids) {
      if (scanned >= offset && sliceIds.length < pageSize) {
        sliceIds.push(id);
      }
      scanned += 1;
    }
    if (
      scanned >= targetEnd ||
      currentSweep.done ||
      currentSweep.nextCursor === null
    ) {
      break;
    }
    currentSweep = await readSweepPage(currentSweep.nextCursor);
  }

  if (scanned > total) {
    total = scanned;
    totalPages = Math.max(1, Math.ceil(total / pageSize));
  }
  const hasMore: boolean = offset + sliceIds.length < total || !currentSweep.done;
  const nextAfterId: number | null =
    hasMore && sliceIds.length > 0 ? sliceIds[sliceIds.length - 1]! : null;
  return {
    sliceIds,
    page,
    pageSize,
    total,
    totalPages,
    nextAfterId,
  };
}

/** 新增或移除白名单/黑名单身份的入参。 */
export interface SetIdentityMembershipParams {
  /** 目标用户（正整数）或频道/群会话（负整数）ID。 */
  readonly id: number;
  /** `true` 表示加入名单，`false` 表示移出名单。 */
  readonly enabled: boolean;
  /** 可选的已知展示资料（如来自 `users_shared` / `chat_shared` 的名称与用户名）。 */
  readonly meta?: Readonly<Partial<TelegramIdentityMetadata>>;
}

/** 修改白名单单项权限的入参。 */
export interface SetMiniAppWhitelistPermissionParams {
  /** 目标白名单身份 ID。 */
  readonly id: number;
  /** 权限键名。 */
  readonly key: WhitelistPermissionKey;
  /** 目标布尔值。 */
  readonly value: boolean;
}

/**
 * 构建十八项白名单权限键及其中文说明列表。
 * @returns 权限键与说明的只读数组。
 */
export function buildPermissionDescriptors(): readonly Readonly<MiniAppPermissionDescriptor>[] {
  const helpMap: Readonly<Record<WhitelistPermissionKey, string>> =
    chatAtmosphere().WHITELIST_PERMISSION_HELP;
  return WHITELIST_PERMISSION_KEYS.map(
    (key: WhitelistPermissionKey): Readonly<MiniAppPermissionDescriptor> => ({
      key,
      description: helpMap[key],
    })
  );
}

/**
 * 根据持久化的 `TelegramIdentityMetadata` 合成人类可读展示名。
 * @param id 身份 ID。
 * @param meta 持久化的展示元数据。
 * @returns 非空展示名称。
 */
export function formatIdentityDisplayName(
  id: number,
  meta: Readonly<TelegramIdentityMetadata>
): string {
  const fullName: string = `${meta.firstName} ${meta.lastName}`
    .replace(MINI_APP_BIDI_CONTROL_CHARS_PATTERN, "")
    .trim();
  if (fullName.length > 0) return fullName;
  const cleanUsername: string = meta.username
    .replace(MINI_APP_BIDI_CONTROL_CHARS_PATTERN, "")
    .trim();
  if (cleanUsername.length > 0) return `@${cleanUsername}`;
  return id < 0 ? `频道 ${id}` : `用户 ${id}`;
}

/**
 * 为待写入白名单或黑名单的目标身份补齐 `TelegramIdentityMetadata`（优先采用调用方提供的资料，其次读取主线程发送者缓存，最后尽力通过 `getChat` 探测）。
 * @param id 目标身份 ID。
 * @param fallback 调用方传入的可选部分元数据。
 * @returns 完整的只读 `TelegramIdentityMetadata`。
 */
export async function resolveIdentityMetadataForMiniApp(
  id: number,
  fallback?: Readonly<Partial<TelegramIdentityMetadata>>
): Promise<Readonly<TelegramIdentityMetadata>> {
  const firstNameFromFallback: string = fallback?.firstName?.trim() ?? "";
  const lastNameFromFallback: string = fallback?.lastName?.trim() ?? "";
  const usernameFromFallback: string = fallback?.username?.trim() ?? "";
  if (firstNameFromFallback.length > 0 || usernameFromFallback.length > 0) {
    return {
      firstName: firstNameFromFallback,
      lastName: lastNameFromFallback,
      username: usernameFromFallback,
    };
  }

  const cachedUser: CachedUser = resolveIdTarget(id);
  const fromCached: TelegramIdentityMetadata =
    identityMetadataFromCachedUser(cachedUser);
  if (fromCached.firstName.length > 0 || fromCached.username.length > 0) {
    return fromCached;
  }

  const chatInfo: ChatFullInfo | undefined = await probeTelegramChatInfoSilent(id);
  if (chatInfo !== undefined) {
    const firstName: string =
      "first_name" in chatInfo && typeof chatInfo.first_name === "string"
        ? chatInfo.first_name.trim()
        : "title" in chatInfo && typeof chatInfo.title === "string"
          ? chatInfo.title.trim()
          : "";
    const lastName: string =
      "last_name" in chatInfo && typeof chatInfo.last_name === "string"
        ? chatInfo.last_name.trim()
        : "";
    const username: string =
      "username" in chatInfo && typeof chatInfo.username === "string"
        ? chatInfo.username.trim()
        : "";
    if (firstName.length > 0 || username.length > 0) {
      return { firstName, lastName, username };
    }
  }

  return fromCached;
}
