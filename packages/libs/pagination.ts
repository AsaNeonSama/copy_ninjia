/**
 * 列表分页参数规范化与游标叠加合并纯函数，供存储分页与 Mini App 视图层共用。
 */

/**
 * 将请求每页条数裁剪为 `[1, maxPageSize]` 闭区间内的整数；非有限数值回落至 `defaultPageSize`。
 *
 * @param rawPageSize 请求传入的每页条数（可缺省）。
 * @param defaultPageSize 缺省或非有限值时采用的默认每页条数。
 * @param maxPageSize 允许的单页最大条数。
 * @returns 规范化后的每页条数。
 */
export function clampPageSize(
  rawPageSize: number | undefined,
  defaultPageSize: number,
  maxPageSize: number
): number {
  const effective: number =
    rawPageSize !== undefined && Number.isFinite(rawPageSize)
      ? Math.trunc(rawPageSize)
      : defaultPageSize;
  return Math.min(maxPageSize, Math.max(1, effective));
}

/**
 * 将请求页码规范化为不小于 `1` 的整数；缺省或非有限值回落为 `1`。
 *
 * @param rawPage 请求传入的页码（可缺省）。
 * @returns 至少为 `1` 的整数页码。
 */
export function clampRequestedPage(rawPage: number | undefined): number {
  if (rawPage === undefined || !Number.isFinite(rawPage)) {
    return 1;
  }
  return Math.max(1, Math.trunc(rawPage));
}

/**
 * 计算给定总条数与每页条数对应的总页数（至少为 `1`）。
 *
 * @param total 总条数。
 * @param pageSize 正整数每页条数。
 * @returns 至少为 `1` 的总页数。
 */
export function totalPagesFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 游标分页叠加未确认本地写入所需的通用入参。 */
export interface OverlayCursorPageParams<TKey, TPending> {
  /** 本次游标读取返回的已持久化有序键列表。 */
  readonly items: readonly TKey[];
  /** 游标起点键（不含）；首页为 `null`。 */
  readonly afterCursor: TKey | null;
  /** 底层游标页返回的下一页游标。 */
  readonly nextCursor: TKey | null;
  /** 是否已到达游标末尾页。 */
  readonly done: boolean;
  /** 本地尚未收到落盘 ACK 的增量写入表。 */
  readonly pendingWrites: ReadonlyMap<TKey, TPending>;
  /** 判断单条未确认写入是否为删除操作。 */
  readonly isDeleted: (change: TPending) => boolean;
  /** 键的严格升序比较函数（返回值 `< 0`、`0` 或 `> 0`）。 */
  readonly compare: (left: TKey, right: TKey) => number;
}

/** 叠加未确认本地写入后的有序游标分页结果。 */
export interface OverlaidCursorPage<TKey> {
  /** 合并并按升序重排后的当前页键列表。 */
  readonly items: readonly TKey[];
  /** 合并后的下一页游标键。 */
  readonly nextCursor: TKey | null;
  /** 是否已到达末尾页。 */
  readonly done: boolean;
}

/**
 * 将磁盘游标页与尚未收到落盘 ACK 的本地增删写入叠加合并，确保并发增删立即可见且游标严格递增。
 *
 * @param params 游标页原始结果、未确认写入表、删除判定与升序比较函数。
 * @returns 合并后的游标页；无未确认写入时直接复用原 `items`。
 */
export function overlayCursorPage<TKey, TPending>({
  items,
  afterCursor,
  nextCursor,
  done,
  pendingWrites,
  isDeleted,
  compare,
}: Readonly<OverlayCursorPageParams<TKey, TPending>>): Readonly<OverlaidCursorPage<TKey>> {
  if (pendingWrites.size === 0) {
    return { items, nextCursor, done };
  }
  const mergedSet: Set<TKey> = new Set<TKey>(items);
  for (const [key, change] of pendingWrites) {
    if (isDeleted(change)) {
      mergedSet.delete(key);
      continue;
    }
    if (afterCursor !== null && compare(key, afterCursor) <= 0) continue;
    if (!done && nextCursor !== null && compare(key, nextCursor) > 0) continue;
    mergedSet.add(key);
  }
  const merged: TKey[] = [...mergedSet].sort(compare);
  return {
    items: merged,
    nextCursor: done
      ? (merged.length === 0 ? afterCursor : merged[merged.length - 1]!)
      : nextCursor,
    done,
  };
}
