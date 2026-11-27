/**
 * Mini App 前端广告包黑名单（贴纸包 / 自定义表情包）分页查询、增删与页内包预览接口契约类型。
 * 与服务端 `packages/types/miniApp/adBlacklists.ts` 同名的声明保持编译期恒等（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。
 */

/** 广告包黑名单的种类（贴纸包或自定义表情包）。 */
export type MiniAppAdBlacklistKind = "sticker" | "emoji";

/** 广告包黑名单分页列表中的单条包名记录。 */
export interface MiniAppAdBlacklistItem {
  /** Telegram 贴纸包或自定义表情包的 short name。 */
  readonly pack: string;
}

/** `GET /api/ad-blacklists` 返回的广告包黑名单分页视图。 */
export interface MiniAppAdBlacklistsResponse {
  /** 当前查询的黑名单种类。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 当前页的包名条目列表。 */
  readonly items: readonly MiniAppAdBlacklistItem[];
  /** 服务端夹紧后的当前页码（1 起）。 */
  readonly page: number;
  /** 服务端夹紧后的每页条数。 */
  readonly pageSize: number;
  /** 当前过滤条件下的命中总条数。 */
  readonly total: number;
  /** 总页数（至少为 1）。 */
  readonly totalPages: number;
  /** 贴纸包黑名单全量条数。 */
  readonly stickerTotal: number;
  /** 自定义表情包黑名单全量条数。 */
  readonly emojiTotal: number;
  /** 服务端规范化后的搜索关键字。 */
  readonly query: string;
}

/** `POST /api/ad-blacklists` 服务端返回的状态码闭集。 */
export type MiniAppAdBlacklistMutationCode =
  | "AD_BLACKLIST_ADDED"
  | "AD_BLACKLIST_DUPLICATE"
  | "AD_BLACKLIST_REMOVED"
  | "AD_BLACKLIST_NOT_FOUND"
  | "INVALID_AD_BLACKLIST_PARAMS"
  | "INVALID_AD_BLACKLIST_PACK"
  | "AD_BLACKLIST_BOT_OWN_PACK"
  | "AD_BLACKLIST_STORAGE_UNAVAILABLE";

/** `POST /api/ad-blacklists` 请求体载荷。 */
export interface MiniAppAdBlacklistMutationRequest {
  /** 目标黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** Telegram 贴纸包或自定义表情包 short name。 */
  readonly pack: string;
  /** `true` 表示加入黑名单，`false` 表示从黑名单移除。 */
  readonly enabled: boolean;
}

/** `POST /api/ad-blacklists` 响应体载荷。 */
export interface MiniAppAdBlacklistMutationResponse {
  /** 本次业务操作是否成功。 */
  readonly ok: boolean;
  /** 目标黑名单种类。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 规范化后的包名。 */
  readonly pack: string;
  /** 请求动作（`true` 为新增，`false` 为移除）。 */
  readonly enabled: boolean;
  /** 内存与持久化集合是否发生实际变更。 */
  readonly changed: boolean;
  /** 新增时是否因包名已存在于黑名单而判重。 */
  readonly duplicate?: boolean;
  /** 本次写入是否已完成 SQLite 落盘确认。 */
  readonly persisted?: boolean;
  /** 服务端返回的英文状态码，由前端映射为三语言提示。 */
  readonly code: MiniAppAdBlacklistMutationCode;
  /** 服务端返回的状态说明。 */
  readonly message: string;
}

/** 内容黑名单包预览中单个贴纸或自定义表情的媒体形态。 */
export type MiniAppAdBlacklistStickerFormat = "static" | "animated" | "video";

/** Telegram `StickerSet` 返回的包类型联合。 */
export type MiniAppAdBlacklistStickerSetType = "regular" | "mask" | "custom_emoji";

/** `GET /api/ad-blacklists/preview` 返回的单个贴纸 / 自定义表情预览条目。 */
export interface MiniAppAdBlacklistPreviewItem {
  /** 贴纸/表情的 Telegram 唯一文件标识。 */
  readonly fileUniqueId: string;
  /** 关联的默认 Emoji 字符（缺失时为 `null`）。 */
  readonly emoji: string | null;
  /** 媒体形态（静态图片、TGS 矢量动画或 WEBM 视频）。 */
  readonly format: MiniAppAdBlacklistStickerFormat;
  /** Telegram 侧是否存在可下载的静态预览缩略图或静态原图（供 `metaOnly=1` 阶段精准渲染骨架槽位）。 */
  readonly hasImage: boolean;
  /** 经魔数嗅探封装的静态缩略图 `data:image/...;base64,...`；仅拉取元数据、下载失败或无可用静态缩略图时为 `null`。 */
  readonly imageDataUrl: string | null;
}

/** `GET /api/ad-blacklists/preview` 返回的贴纸包 / 自定义表情包页内预览分页视图。 */
export interface MiniAppAdBlacklistPreviewResponse {
  /** 请求所属内容黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 目标贴纸包或自定义表情包 short name。 */
  readonly pack: string;
  /** Telegram 返回的包标题。 */
  readonly title: string;
  /** Telegram 返回的包类型（`"regular"`、`"mask"` 或 `"custom_emoji"`）。 */
  readonly stickerType: MiniAppAdBlacklistStickerSetType;
  /** 包内贴纸 / 自定义表情总枚数。 */
  readonly totalCount: number;
  /** 本页起始偏移下标（从 0 起）。 */
  readonly offset: number;
  /** 是否仍有更多未加载条目。 */
  readonly hasMore: boolean;
  /** 下一页查询偏移下标。 */
  readonly nextOffset: number;
  /** 本页预览条目列表（保持包内原始顺序）。 */
  readonly items: readonly MiniAppAdBlacklistPreviewItem[];
}
