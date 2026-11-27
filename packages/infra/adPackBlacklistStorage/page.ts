/**
 * 主线程广告包黑名单游标冷读分页与搜索（不污染 768 LRU 热缓存），供 `/ad_detect list` 与 Mini App 共用。
 */

import {
  nextAdPackBlacklistRevision,
  unacknowledgedAdPackBlacklistWrites,
} from "../../cache/main/adPackBlacklist";
import { AD_PACK_BLACKLIST_PAGE_SIZE } from "../../consts/identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../consts/paths";
import {
  assertAdPackBlacklistKind,
  assertAdPackBlacklistPack,
} from "../../database/codec/adPackBlacklist";
import {
  clampPageSize,
  clampRequestedPage,
  overlayCursorPage,
  totalPagesFor,
} from "../../libs/pagination";
import type { OverlaidCursorPage } from "../../libs/pagination";
import type {
  AdPackBlacklistKind,
  AdPackBlacklistPage,
  UnacknowledgedAdPackBlacklistWrite,
} from "../../types/adPackBlacklist";
import type { DomainFlushOutcome } from "../../types/diskIO/replies";
import * as diskIO from "../diskIO";
import { adPackBlacklistRowSource, getAdPackBlacklistCount } from "./read";

/** 分页或搜索冷读广告包黑名单的入参。 */
export interface ListAdPackBlacklistPageOptions {
  /** 目标黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: AdPackBlacklistKind;
  /** 请求页码（从 1 开始）。 */
  readonly page: number;
  /** 每页条数（正整数）。 */
  readonly pageSize: number;
  /** 可选的大小写不敏感子串搜索关键字（已裁剪；缺省或空串表示不搜索）。 */
  readonly query?: string;
  /** 为 `true` 时越界页码自动夹紧到 `[1, totalPages]`；为 `false` 时保留请求页码并标记 `outOfRange`。 */
  readonly clampPage?: boolean;
}

/** 冷读分页或搜索广告包黑名单的返回结果。 */
export interface AdPackBlacklistPageSlice {
  /** 当前页按 ASCII 字典序升序排列的包名列表（未夹紧且越界时为空）。 */
  readonly packs: readonly string[];
  /** 生效页码（`clampPage: true` 时已夹紧至 `1..totalPages`）。 */
  readonly page: number;
  /** 本次生效的每页条数。 */
  readonly pageSize: number;
  /** 当前条件（含搜索过滤）下的总条数。 */
  readonly total: number;
  /** 当前条件下的总页数（至少为 1）。 */
  readonly totalPages: number;
  /** 目标种类不受搜索过滤影响的全量条数。 */
  readonly kindTotal: number;
  /** 仅在 `clampPage: false` 且 `total > 0` 且请求页码超过 `totalPages` 时为 `true`。 */
  readonly outOfRange: boolean;
}

/**
 * 按 ASCII 字典序升序比较两个包名。
 *
 * @param left 左侧包名。
 * @param right 右侧包名。
 * @returns 升序比较结果（`-1`、`0` 或 `1`）。
 */
function comparePackNamesAscending(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 校验 Disk I/O 回传的广告包黑名单游标页满足固定大小、严格升序与续读游标契约。
 *
 * @param kind 目标黑名单种类。
 * @param page Disk I/O Worker 返回的包名游标页。
 * @param afterPack 本次分页读取传入的起始游标包名（首页为 `null`）。
 * @returns 校验通过的原游标页对象。
 */
function validateAdPackBlacklistPage(
  kind: AdPackBlacklistKind,
  page: AdPackBlacklistPage,
  afterPack: string | null
): AdPackBlacklistPage {
  if (page.packs.length > AD_PACK_BLACKLIST_PAGE_SIZE) {
    throw new Error(
      `Ad pack blacklist page exceeds ${AD_PACK_BLACKLIST_PAGE_SIZE} entries.`
    );
  }
  let previous: string | null = afterPack;
  for (const pack of page.packs) {
    assertAdPackBlacklistPack(pack, adPackBlacklistRowSource(kind, pack));
    if (previous !== null && pack <= previous) {
      throw new Error("Ad pack blacklist page must be strictly ordered after its cursor.");
    }
    previous = pack;
  }
  const expectedCursor: string | null = page.packs.length === 0
    ? afterPack
    : page.packs[page.packs.length - 1]!;
  if (page.nextCursor !== expectedCursor) {
    throw new Error("Ad pack blacklist page returned an inconsistent next cursor.");
  }
  if (!page.done && page.packs.length !== AD_PACK_BLACKLIST_PAGE_SIZE) {
    throw new Error("A non-final ad pack blacklist page must fill the fixed page size.");
  }
  return page;
}

/**
 * 统计指定种类中 revision 不晚于 `coveredRevision` 且仍未收到 durable ACK 的写入条数。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param coveredRevision 本次 flush 发起前捕获的写入 revision 上界。
 * @returns 仍未收到 ACK 的写入条数。
 */
function countUnacknowledgedWritesThrough(
  kind: AdPackBlacklistKind,
  coveredRevision: number
): number {
  let count: number = 0;
  for (const write of unacknowledgedAdPackBlacklistWrites[kind].values()) {
    if (write.revision <= coveredRevision) count++;
  }
  return count;
}

/**
 * 按 `(kind, pack)` 稳定游标冷读一页 SQLite 广告包黑名单（不污染 768 LRU 热缓存）：
 * 读取前先 flush `"adPackBlacklist"` 领域并核验发出前已登记的 revision 全部已 ACK。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param afterPack 上一页末尾的包名游标；读取首页时传 `null`。
 * @returns 经事务落盘与契约校验后的包名游标页。
 */
async function readAdPackBlacklistSweepPage(
  kind: AdPackBlacklistKind,
  afterPack: string | null
): Promise<AdPackBlacklistPage> {
  assertAdPackBlacklistKind(kind, `${IDENTITY_DATABASE_PATH}:ad_pack_blacklists`);
  if (afterPack !== null) {
    assertAdPackBlacklistPack(afterPack, adPackBlacklistRowSource(kind, afterPack));
  }
  const coveredRevision: number = nextAdPackBlacklistRevision.current;
  const outcome: DomainFlushOutcome = await diskIO.flushDiskIODomain("adPackBlacklist");
  if (outcome.result !== "flushed") {
    throw new Error(`Ad pack blacklist page flush for ${kind} ${outcome.result}.`);
  }
  const unacknowledged: number = countUnacknowledgedWritesThrough(kind, coveredRevision);
  if (unacknowledged !== 0) {
    throw new Error(
      `Ad pack blacklist page flush for ${kind} left ${unacknowledged} unacknowledged write(s).`
    );
  }
  const page: AdPackBlacklistPage = await diskIO.readAdPackBlacklistPage(kind, afterPack);
  return validateAdPackBlacklistPage(kind, page, afterPack);
}

/**
 * 冷读一页游标包名并叠加 flush 期间可能新排入的本地未 ACK 写入，确保并发增删立即可见。
 *
 * @param kind 目标黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param afterPack 游标起点包名（不含）；首页传 `null`。
 * @returns 叠加未确认本地写入后的游标页。
 */
async function readOverlayAdPackBlacklistPage(
  kind: AdPackBlacklistKind,
  afterPack: string | null
): Promise<AdPackBlacklistPage> {
  const sweep: AdPackBlacklistPage = await readAdPackBlacklistSweepPage(kind, afterPack);
  const pendingWrites: ReadonlyMap<string, UnacknowledgedAdPackBlacklistWrite> =
    unacknowledgedAdPackBlacklistWrites[kind];
  if (pendingWrites.size === 0) return sweep;
  const overlaid: Readonly<OverlaidCursorPage<string>> = overlayCursorPage({
    items: sweep.packs,
    afterCursor: afterPack,
    nextCursor: sweep.nextCursor,
    done: sweep.done,
    pendingWrites,
    isDeleted: (change: UnacknowledgedAdPackBlacklistWrite): boolean => !change.blacklisted,
    compare: comparePackNamesAscending,
  });
  return {
    packs: overlaid.items,
    nextCursor: overlaid.nextCursor,
    done: overlaid.done,
  };
}

/** `searchAdPackBlacklistPage` 流式游标搜索过滤的入参。 */
interface SearchAdPackBlacklistPageOptions {
  /** 目标黑名单种类。 */
  readonly kind: AdPackBlacklistKind;
  /** 请求页码（1 起）。 */
  readonly requestedPage: number;
  /** 每页条数。 */
  readonly pageSize: number;
  /** 已裁剪并转小写的非空搜索关键字。 */
  readonly lowerQuery: string;
  /** 是否将越界页码夹紧至 `[1, totalPages]`。 */
  readonly clampPage: boolean;
}

/**
 * 游标扫描指定种类下满足给定大小写不敏感子串关键字的全部包名并切出目标页（不污染 768 LRU）。
 *
 * @param options 搜索种类、页码、每页条数、规范化关键字与页码夹紧策略。
 * @returns 搜索过滤后的分页切片。
 */
async function searchAdPackBlacklistPage({
  kind,
  requestedPage,
  pageSize,
  lowerQuery,
  clampPage,
}: Readonly<SearchAdPackBlacklistPageOptions>): Promise<Readonly<AdPackBlacklistPageSlice>> {
  const matched: string[] = [];
  let scanned: number = 0;
  let cursor: string | null = null;
  while (true) {
    const sweep: AdPackBlacklistPage = await readOverlayAdPackBlacklistPage(kind, cursor);
    for (const pack of sweep.packs) {
      scanned += 1;
      if (pack.toLowerCase().includes(lowerQuery)) {
        matched.push(pack);
      }
    }
    if (sweep.done || sweep.nextCursor === null) break;
    cursor = sweep.nextCursor;
  }
  const kindTotal: number = Math.max(getAdPackBlacklistCount(kind), scanned);
  const total: number = matched.length;
  const totalPages: number = totalPagesFor(total, pageSize);
  if (!clampPage && total > 0 && requestedPage > totalPages) {
    return {
      packs: [],
      page: requestedPage,
      pageSize,
      total,
      totalPages,
      kindTotal,
      outOfRange: true,
    };
  }
  const page: number = clampPage ? Math.min(requestedPage, totalPages) : requestedPage;
  const offset: number = (page - 1) * pageSize;
  return {
    packs: matched.slice(offset, offset + pageSize),
    page,
    pageSize,
    total,
    totalPages,
    kindTotal,
    outOfRange: false,
  };
}

/**
 * 按页码冷读广告包黑名单（支持可选大小写不敏感子串搜索），不读写主线程 768 LRU 缓存：
 * 无搜索词时按游标前进至目标页即停，不将整张表一次性读入内存；有搜索词时逐游标页流式过滤。
 *
 * @param options 查询种类、页码、每页条数、可选搜索词与页码夹紧策略。
 * @returns 当前页包名列表与精确分页统计。
 */
export async function listAdPackBlacklistPage({
  kind,
  page: rawPage,
  pageSize: rawPageSize,
  query = "",
  clampPage = true,
}: Readonly<ListAdPackBlacklistPageOptions>): Promise<Readonly<AdPackBlacklistPageSlice>> {
  assertAdPackBlacklistKind(kind, `${IDENTITY_DATABASE_PATH}:ad_pack_blacklists`);
  const pageSize: number = clampPageSize(rawPageSize, 1, Number.MAX_SAFE_INTEGER);
  const requestedPage: number = clampRequestedPage(rawPage);
  const lowerQuery: string = query.trim().toLowerCase();
  if (lowerQuery.length > 0) {
    return await searchAdPackBlacklistPage({
      kind,
      requestedPage,
      pageSize,
      lowerQuery,
      clampPage,
    });
  }

  const firstSweep: AdPackBlacklistPage = await readOverlayAdPackBlacklistPage(kind, null);
  const knownTotal: number = getAdPackBlacklistCount(kind);
  if (firstSweep.done) {
    const total: number = firstSweep.packs.length;
    const totalPages: number = totalPagesFor(total, pageSize);
    if (!clampPage && total > 0 && requestedPage > totalPages) {
      return {
        packs: [],
        page: requestedPage,
        pageSize,
        total,
        totalPages,
        kindTotal: total,
        outOfRange: true,
      };
    }
    const page: number = clampPage ? Math.min(requestedPage, totalPages) : requestedPage;
    const offset: number = (page - 1) * pageSize;
    return {
      packs: firstSweep.packs.slice(offset, offset + pageSize),
      page,
      pageSize,
      total,
      totalPages,
      kindTotal: total,
      outOfRange: false,
    };
  }

  let total: number = Math.max(knownTotal, firstSweep.packs.length + 1);
  let totalPages: number = totalPagesFor(total, pageSize);
  if (!clampPage && requestedPage > totalPages) {
    return {
      packs: [],
      page: requestedPage,
      pageSize,
      total,
      totalPages,
      kindTotal: total,
      outOfRange: true,
    };
  }
  const page: number = clampPage ? Math.min(requestedPage, totalPages) : requestedPage;
  const offset: number = (page - 1) * pageSize;
  const targetEnd: number = offset + pageSize;
  const slicePacks: string[] = [];
  let tailPacks: string[] = [];
  let scanned: number = 0;
  let currentSweep: AdPackBlacklistPage = firstSweep;

  while (true) {
    for (const pack of currentSweep.packs) {
      if (scanned >= offset && slicePacks.length < pageSize) {
        slicePacks.push(pack);
      }
      scanned += 1;
    }
    if (clampPage && currentSweep.packs.length > 0) {
      if (currentSweep.packs.length >= pageSize) {
        tailPacks = currentSweep.packs.slice(currentSweep.packs.length - pageSize);
      } else {
        tailPacks.push(...currentSweep.packs);
        if (tailPacks.length > pageSize) {
          tailPacks = tailPacks.slice(tailPacks.length - pageSize);
        }
      }
    }
    if (
      scanned >= targetEnd ||
      currentSweep.done ||
      currentSweep.nextCursor === null
    ) {
      break;
    }
    currentSweep = await readOverlayAdPackBlacklistPage(kind, currentSweep.nextCursor);
  }

  if (currentSweep.done) {
    total = scanned;
    totalPages = totalPagesFor(total, pageSize);
  } else if (scanned >= total) {
    total = scanned + 1;
    totalPages = totalPagesFor(total, pageSize);
  }
  if (!clampPage && total > 0 && requestedPage > totalPages) {
    return {
      packs: [],
      page: requestedPage,
      pageSize,
      total,
      totalPages,
      kindTotal: total,
      outOfRange: true,
    };
  }
  if (clampPage && currentSweep.done && total > 0 && page > totalPages) {
    const lastPageCount: number = total - (totalPages - 1) * pageSize;
    return {
      packs: tailPacks.slice(tailPacks.length - lastPageCount),
      page: totalPages,
      pageSize,
      total,
      totalPages,
      kindTotal: total,
      outOfRange: false,
    };
  }
  return {
    packs: slicePacks,
    page: clampPage ? Math.min(page, totalPages) : page,
    pageSize,
    total,
    totalPages,
    kindTotal: total,
    outOfRange: false,
  };
}
