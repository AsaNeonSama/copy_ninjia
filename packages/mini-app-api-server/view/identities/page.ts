import { unacknowledgedIdentityWrites } from "../../../cache/main/identityStorage";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_MAX_PAGE_SIZE,
} from "../../../consts/miniApp";
import {
  getIdentityEntryCount,
  readIdentityPolicyEntries,
  readIdentitySweepPage,
} from "../../../infra/identityStorage";
import { stripLeadingAtSigns } from "../../../libs/text";
import {
  formatIdentityDisplayName,
  syncIdentityMetadataWithBotCache,
} from "./metadata";
import type {
  BlocklistEntryData,
  IdentityPolicyTable,
  TelegramIdentityMetadata,
  WhitelistEntryData,
} from "../../../types/identityPolicy";
import type {
  IdentityIdPage,
  UnacknowledgedIdentityWrite,
} from "../../../types/identityStorage";

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
  /** 按名称、用户名或 ID 模糊搜索的关键字。 */
  readonly query?: string;
}

/**
 * 读取一页游标 ID 并叠加当前尚未收到落盘 ACK 的内存身份增删写入，确保 Bot 或 API 侧刚提交的名单变更立即可见。
 *
 * @param table 目标身份策略表名。
 * @param afterId 游标起点 ID。
 * @returns 叠加未确认内存写入后的游标页。
 */
async function readOverlaySweepPage(
  table: IdentityPolicyTable,
  afterId: number | null
): Promise<IdentityIdPage> {
  const sweep: IdentityIdPage = await readIdentitySweepPage(table, afterId);
  const pendingWrites: ReadonlyMap<number, UnacknowledgedIdentityWrite> =
    unacknowledgedIdentityWrites(table);
  if (pendingWrites.size === 0) return sweep;
  const idSet: Set<number> = new Set(sweep.ids);
  for (const [id, change] of pendingWrites) {
    if (change.data === null) {
      idSet.delete(id);
      continue;
    }
    if (afterId !== null && id <= afterId) continue;
    if (!sweep.done && sweep.nextCursor !== null && id > sweep.nextCursor) {
      continue;
    }
    idSet.add(id);
  }
  const ids: number[] = [...idSet].sort(
    (left: number, right: number): number => left - right
  );
  return {
    ids,
    nextCursor: sweep.done
      ? (ids.length === 0 ? afterId : ids[ids.length - 1]!)
      : sweep.nextCursor,
    done: sweep.done,
  };
}

/**
 * 读取指定身份策略表的全部身份 ID（供按名称搜索过滤时遍历）。
 *
 * @param table 身份策略表名；读取时叠加该表本地未确认内存写入。
 * @returns 表中全部身份 ID 列表。
 */
async function collectAllIdentityIds(
  table: IdentityPolicyTable
): Promise<readonly number[]> {
  const allIds: number[] = [];
  let cursor: number | null = null;
  while (true) {
    const sweep: IdentityIdPage = await readOverlaySweepPage(table, cursor);
    for (const id of sweep.ids) {
      allIds.push(id);
    }
    if (sweep.done || sweep.nextCursor === null || sweep.ids.length === 0) {
      break;
    }
    cursor = sweep.nextCursor;
  }
  return allIds;
}

/** 预先规范化的名单搜索关键字（每次查询请求构造一次）。 */
interface IdentitySearchQuery {
  /** 已 trim 并转小写的搜索关键字。 */
  readonly normalized: string;
  /** 剥离前导 `@` 后的小写搜索关键字。 */
  readonly withoutAt: string;
}

/** 待匹配的单个名单身份候选字段。 */
interface IdentitySearchCandidate {
  /** 身份数字 ID。 */
  readonly id: number;
  /** 格式化后的展示名称。 */
  readonly displayName: string;
  /** 可选的用户名（不含 `@`）。 */
  readonly username?: string;
}

/**
 * 为一次名单搜索请求构造预先规范化的搜索关键字。
 *
 * @param normalizedQuery 已 trim 并转小写的非空搜索关键字。
 * @returns 供 `matchesIdentitySearchQuery` 逐条复用的搜索关键字对象。
 */
function toIdentitySearchQuery(
  normalizedQuery: string
): Readonly<IdentitySearchQuery> {
  return {
    normalized: normalizedQuery,
    withoutAt: stripLeadingAtSigns(normalizedQuery),
  };
}

/**
 * 判断单个名单条目的展示名称、用户名或数字 ID 是否命中搜索关键字（忽略大小写）。
 *
 * @param query 预先规范化的搜索关键字对象。
 * @param candidate 待匹配的名单身份候选字段。
 * @returns 命中搜索关键字时返回 `true`。
 */
function matchesIdentitySearchQuery(
  query: Readonly<IdentitySearchQuery>,
  candidate: Readonly<IdentitySearchCandidate>
): boolean {
  const lowerDisplayName: string = candidate.displayName.toLowerCase();
  if (lowerDisplayName.includes(query.normalized)) return true;
  if (query.withoutAt.length > 0 && lowerDisplayName.includes(query.withoutAt)) {
    return true;
  }
  if (
    candidate.username !== undefined &&
    query.withoutAt.length > 0 &&
    candidate.username.toLowerCase().includes(query.withoutAt)
  ) {
    return true;
  }
  return String(candidate.id).includes(query.normalized);
}

/** 身份名单分页切片与总量统计结果。 */
interface CollectedIdentityPageSlice {
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
 * @returns 当前页身份 ID 列表及分页统计元数据。
 */
async function collectIdentityPageIds(
  table: IdentityPolicyTable,
  params: ListIdentityPageParams
): Promise<Readonly<CollectedIdentityPageSlice>> {
  const rawPageSize: number =
    params.pageSize ?? params.limit ?? MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE;
  const pageSize: number = Math.min(
    MINI_APP_IDENTITY_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(rawPageSize))
  );
  const requestedPage: number = Math.max(1, Math.trunc(params.page ?? 1));

  if (params.afterId !== undefined && params.afterId !== null) {
    const cursorSweep: IdentityIdPage = await readOverlaySweepPage(
      table,
      params.afterId
    );
    const knownTotal: number = getIdentityEntryCount(table);
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

  const firstSweep: IdentityIdPage = await readOverlaySweepPage(table, null);
  const knownTotal: number = getIdentityEntryCount(table);
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
  let currentSweep: IdentityIdPage = firstSweep;

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
    currentSweep = await readOverlaySweepPage(table, currentSweep.nextCursor);
  }

  if (scanned > total) {
    total = scanned;
    totalPages = Math.max(1, Math.ceil(total / pageSize));
  }
  const hasMore: boolean =
    offset + sliceIds.length < total || !currentSweep.done;
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

/** 身份策略表名到条目持久化载荷类型的映射。 */
interface IdentityPolicyEntryDataMap {
  /** 白名单条目载荷。 */
  readonly whitelist: WhitelistEntryData;
  /** 黑名单条目载荷。 */
  readonly blocklist: BlocklistEntryData;
}

/** 白名单与黑名单列表项共用的身份展示基础字段。 */
export interface IdentityPolicyEntryBaseView {
  /** 身份数字 ID（正整数为用户，负整数为频道/群会话）。 */
  readonly id: number;
  /** 是否为频道或群会话身份（`id < 0`）。 */
  readonly isChannel: boolean;
  /** 格式化后的非空展示名称。 */
  readonly displayName: string;
  /** 可选的用户名（不含 `@`）。 */
  readonly username?: string;
}

/**
 * 将持久化身份元数据与 Bot 发送者缓存对齐后构造列表项共用基础展示字段。
 *
 * @param id 身份数字 ID。
 * @param meta 条目持久化的身份展示元数据。
 * @returns 列表项共用基础展示视图。
 */
function toIdentityEntryBaseView(
  id: number,
  meta: Readonly<TelegramIdentityMetadata>
): Readonly<IdentityPolicyEntryBaseView> {
  const effectiveMeta: Readonly<TelegramIdentityMetadata> =
    syncIdentityMetadataWithBotCache(id, meta);
  return {
    id,
    isChannel: id < 0,
    displayName: formatIdentityDisplayName(id, effectiveMeta),
    username:
      effectiveMeta.username.length > 0 ? effectiveMeta.username : undefined,
  };
}

/** `listIdentityPolicyPage` 的入参。 */
export interface ListIdentityPolicyPageParams<
  TTable extends IdentityPolicyTable,
  TView
> {
  /** 目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。 */
  readonly table: TTable;
  /** 分页、游标与搜索查询参数。 */
  readonly params: ListIdentityPageParams;
  /** 将身份基础展示字段与条目持久化载荷组装为单条视图项的转换回调。 */
  readonly toView: (
    base: Readonly<IdentityPolicyEntryBaseView>,
    entry: Readonly<IdentityPolicyEntryDataMap[TTable]>
  ) => Readonly<TView>;
}

/** 白名单与黑名单列表共用的分页结果骨架。 */
export interface IdentityPolicyPageResult<TView> {
  /** 当前页视图项列表。 */
  readonly items: readonly Readonly<TView>[];
  /** 当前页码（从 1 开始）。 */
  readonly page: number;
  /** 每页条数。 */
  readonly pageSize: number;
  /** 当前查询条件下的总条数。 */
  readonly total: number;
  /** 当前查询条件下的总页数（至少为 1）。 */
  readonly totalPages: number;
  /** 白名单当前总条数。 */
  readonly whitelistTotal: number;
  /** 黑名单当前总条数。 */
  readonly blocklistTotal: number;
  /** 下一页游标（传入下一次请求的 `afterId`）；无更多页时为 `null`。 */
  readonly nextAfterId: number | null;
}

/**
 * 分页列出或按关键字搜索指定身份策略表（`"whitelist"` 或 `"blocklist"`）的持久化成员。
 * 条目经 `readIdentityPolicyEntries` 直接冷读并在本次请求内局部持有，不读写 Bot 的合并身份缓存。
 *
 * @param options 目标表名 `table`、分页/搜索参数 `params` 与单条视图转换函数 `toView`。
 * @returns 组装完成的身份名单分页结果骨架；`table` 自身的总条数取持久化计数与本次扫描所得条数的较大值。
 */
export async function listIdentityPolicyPage<
  TTable extends IdentityPolicyTable,
  TView
>({
  table,
  params,
  toView,
}: ListIdentityPolicyPageParams<TTable, TView>): Promise<
  Readonly<IdentityPolicyPageResult<TView>>
> {
  const isWhitelist: boolean = table === "whitelist";
  const otherTable: IdentityPolicyTable = isWhitelist ? "blocklist" : "whitelist";
  const normalizedQuery: string = params.query?.trim().toLowerCase() ?? "";
  if (normalizedQuery.length > 0) {
    const rawPageSize: number =
      params.pageSize ?? params.limit ?? MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE;
    const pageSize: number = Math.min(
      MINI_APP_IDENTITY_MAX_PAGE_SIZE,
      Math.max(1, Math.trunc(rawPageSize))
    );
    const requestedPage: number = Math.max(1, Math.trunc(params.page ?? 1));
    const allIds: readonly number[] = await collectAllIdentityIds(table);
    const tableTotal: number = Math.max(
      getIdentityEntryCount(table),
      allIds.length
    );
    const otherTableTotal: number = getIdentityEntryCount(otherTable);
    const entries: ReadonlyMap<
      number,
      Readonly<IdentityPolicyEntryDataMap[TTable]>
    > = (await readIdentityPolicyEntries(allIds))[table] as ReadonlyMap<
      number,
      Readonly<IdentityPolicyEntryDataMap[TTable]>
    >;
    const searchQuery: Readonly<IdentitySearchQuery> =
      toIdentitySearchQuery(normalizedQuery);
    const matchedItems: Readonly<TView>[] = [];
    for (const id of allIds) {
      const entry: Readonly<IdentityPolicyEntryDataMap[TTable]> | undefined =
        entries.get(id);
      if (entry === undefined) continue;
      const base: Readonly<IdentityPolicyEntryBaseView> =
        toIdentityEntryBaseView(id, entry.meta);
      if (!matchesIdentitySearchQuery(searchQuery, base)) continue;
      matchedItems.push(toView(base, entry));
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
      whitelistTotal: isWhitelist ? tableTotal : otherTableTotal,
      blocklistTotal: isWhitelist ? otherTableTotal : tableTotal,
      nextAfterId: null,
    };
  }

  const slice: Readonly<CollectedIdentityPageSlice> =
    await collectIdentityPageIds(table, params);
  const otherTableTotal: number = getIdentityEntryCount(otherTable);
  const entries: ReadonlyMap<
    number,
    Readonly<IdentityPolicyEntryDataMap[TTable]>
  > = (await readIdentityPolicyEntries(slice.sliceIds))[table] as ReadonlyMap<
    number,
    Readonly<IdentityPolicyEntryDataMap[TTable]>
  >;
  const items: Readonly<TView>[] = [];
  for (const id of slice.sliceIds) {
    const entry: Readonly<IdentityPolicyEntryDataMap[TTable]> | undefined =
      entries.get(id);
    if (entry === undefined) continue;
    items.push(toView(toIdentityEntryBaseView(id, entry.meta), entry));
  }

  return {
    items,
    page: slice.page,
    pageSize: slice.pageSize,
    total: slice.total,
    totalPages: slice.totalPages,
    whitelistTotal: isWhitelist ? slice.total : otherTableTotal,
    blocklistTotal: isWhitelist ? otherTableTotal : slice.total,
    nextAfterId: slice.nextAfterId,
  };
}
