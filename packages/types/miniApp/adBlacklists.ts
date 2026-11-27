import type { AdPackBlacklistKind } from "../adPackBlacklist";

/** Mini App 广告包黑名单种类（贴纸包或自定义表情包）。 */
export type MiniAppAdBlacklistKind = AdPackBlacklistKind;

/** 广告包黑名单分页接口单项视图。 */
export interface MiniAppAdBlacklistItem {
  /** Telegram 贴纸包或自定义表情包 short name。 */
  readonly pack: string;
}

/** `GET /api/ad-blacklists` 分页与搜索响应。 */
export interface MiniAppAdBlacklistsResponse {
  /** 当前查询的黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 当前页升序排列的黑名单条目列表。 */
  readonly items: readonly MiniAppAdBlacklistItem[];
  /** 夹紧至 `1..totalPages` 后的当前页码。 */
  readonly page: number;
  /** 本次查询生效的每页条数。 */
  readonly pageSize: number;
  /** 当前种类与搜索条件下的匹配总条数。 */
  readonly total: number;
  /** 当前查询条件下的总页数（至少为 1）。 */
  readonly totalPages: number;
  /** 贴纸包黑名单当前总条数（不受搜索关键字过滤影响）。 */
  readonly stickerTotal: number;
  /** 自定义表情包黑名单当前总条数（不受搜索关键字过滤影响）。 */
  readonly emojiTotal: number;
  /** 经首尾裁剪后的当前搜索关键字（无搜索时为空串）。 */
  readonly query: string;
}

/** `POST /api/ad-blacklists` 增删操作的稳定英文状态码联合。 */
export type MiniAppAdBlacklistMutationCode =
  | "AD_BLACKLIST_ADDED"
  | "AD_BLACKLIST_DUPLICATE"
  | "AD_BLACKLIST_REMOVED"
  | "AD_BLACKLIST_NOT_FOUND"
  | "INVALID_AD_BLACKLIST_PARAMS"
  | "INVALID_AD_BLACKLIST_PACK"
  | "AD_BLACKLIST_BOT_OWN_PACK"
  | "AD_BLACKLIST_STORAGE_UNAVAILABLE";

/** `POST /api/ad-blacklists` 请求体。 */
export interface MiniAppAdBlacklistMutationRequest {
  /** 目标黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 目标贴纸包或自定义表情包 short name。 */
  readonly pack: string;
  /** `true` 表示加入黑名单，`false` 表示从黑名单移除。 */
  readonly enabled: boolean;
}

/** `POST /api/ad-blacklists` 变更结果响应体。 */
export interface MiniAppAdBlacklistMutationResponse {
  /** 本次变更是否被业务接纳且已落盘确认。 */
  readonly ok: boolean;
  /** 本次操作的目标黑名单种类。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 经首尾裁剪后的目标包名 short name。 */
  readonly pack: string;
  /** 本次请求的启用方向（`true` 新增，`false` 移除）。 */
  readonly enabled: boolean;
  /** 本次操作是否实际修改了主线程权威内存集合。 */
  readonly changed: boolean;
  /** 新增目标已存在于黑名单中时为 `true`。 */
  readonly duplicate?: boolean;
  /** 目标写入最新 revision 是否已收到 Disk I/O 事务 ACK。 */
  readonly persisted?: boolean;
  /** 稳定英文状态码。 */
  readonly code: MiniAppAdBlacklistMutationCode;
  /** 服务端返回的英文状态码字串，供前端映射为多语言提示。 */
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
