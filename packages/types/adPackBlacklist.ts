/** 广告包黑名单种类：贴纸包（`sticker`）或自定义表情包（`emoji`）。 */
export type AdPackBlacklistKind = "sticker" | "emoji";

/** 广告贴纸包与自定义表情包黑名单的条数统计。 */
export interface AdPackBlacklistCounts {
  /** 贴纸包黑名单当前总条数。 */
  readonly sticker: number;
  /** 自定义表情包黑名单当前总条数。 */
  readonly emoji: number;
}

/** SQLite 按 `(kind, pack)` 升序游标返回的一页广告黑名单包名；载荷受固定页大小硬顶。 */
export interface AdPackBlacklistPage {
  /** 当前页按 ASCII 字典序升序排列的包名列表。 */
  readonly packs: readonly string[];
  /** 本页最后一个包名；空页保持请求游标，完成页不再使用它续读。 */
  readonly nextCursor: string | null;
  /** `true` 表示当前游标之后该种类已没有更多有效包名。 */
  readonly done: boolean;
}

/** 主线程保留到 SQLite ACK 的广告包黑名单未确认写入元数据。 */
export interface UnacknowledgedAdPackBlacklistWrite {
  /** `true` 表示写入黑名单，`false` 表示从黑名单删除（不依赖 LRU 缓存驻留，供冷读覆盖与重放使用）。 */
  readonly blacklisted: boolean;
  /** 本次写入分配的单调递增 revision。 */
  readonly revision: number;
  /** 本次写入占用的准入估算字节数，计入 `unacknowledgedAdPackBlacklistTotals.bytes`。 */
  readonly bytes: number;
}

/** Disk I/O Worker 事务提交前保留的广告包黑名单最终变更。 */
export interface PendingAdPackBlacklistWrite {
  /** `true` 表示写入黑名单，`false` 表示从黑名单删除。 */
  readonly blacklisted: boolean;
  /** 主线程同一 `(kind, pack)` 主键的单调修订号。 */
  readonly revision: number;
}

/** 广告包黑名单单条持久化写入的落盘结果。 */
export interface AdPackBlacklistPersistResult {
  /** 本次调用是否改变了黑名单成员状态。 */
  readonly changed: boolean;
  /** 目标包名最新 revision 是否已收到 Disk I/O Worker 事务 ACK。 */
  readonly persisted: boolean;
}

/** 广告包黑名单批量新增结果的统计摘要。 */
export interface AdPackBlacklistBatchAddResult {
  /** 实际新增进贴纸包黑名单的包名列表。 */
  readonly addedStickerPacks: readonly string[];
  /** 实际新增进自定义表情包黑名单的包名列表。 */
  readonly addedEmojiPacks: readonly string[];
}

/** 广告包黑名单在主线程发生条数变化后的下游广播观察者签名。 */
export type AdPackBlacklistMutationObserver = (counts: Readonly<AdPackBlacklistCounts>) => void;
