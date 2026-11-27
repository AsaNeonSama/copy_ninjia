import type * as TeasingTexts from "../consts/atmosphere/teasing";

/** Bot 部署配置中的通知风格枚举。 */
export type BotAtmosphere = "mesugaki" | "normal";

/** 通知文案表的内部风格键；由启动总闸确定，优先映射 Bot 显式配置，缺省规则见 docs/cn/04-invariants.md。 */
export type Atmosphere = "teasing" | "plain";

/** `/ad_detect <sticker|emoji> list` 分页列表头部的格式化入参。 */
export interface AdDetectBlacklistListHeaderParams {
  /** 黑名单种类展示名（如「贴纸包」或「自定义表情包」）。 */
  readonly kindLabel: string;
  /** 当前展示的页码（1 起）。 */
  readonly page: number;
  /** 总页数（1 起）。 */
  readonly totalPages: number;
  /** 当前已收录条数。 */
  readonly total: number;
}

/** `/ad_detect <sticker|emoji> list` 页码越界提示的格式化入参。 */
export interface AdDetectBlacklistPageOutOfRangeParams {
  /** 黑名单种类展示名（如「贴纸包」或「自定义表情包」）。 */
  readonly kindLabel: string;
  /** 调用方请求的页码。 */
  readonly page: number;
  /** 当前最大可用页码（1 起）。 */
  readonly totalPages: number;
  /** 当前已收录条数。 */
  readonly total: number;
}

/** `/ad_detect <sticker|emoji> <list|add|remove>` 黑名单管理子命令的全部文案。 */
export interface AdDetectBlacklistTexts {
  /** 贴纸包黑名单的中文展示名。 */
  readonly kindSticker: string;
  /** 自定义表情包黑名单的中文展示名。 */
  readonly kindEmoji: string;
  /** 黑名单子命令缺少或无法识别动作时的用法提示。 */
  readonly usage: string;
  /** `list` 页码参数不是正整数或携带多余参数时的提示。 */
  readonly listInvalidPage: string;
  /** 指定种类黑名单为空时的提示。 */
  readonly listEmpty: (kindLabel: string) => string;
  /** 指定页码超出总页数时的提示。 */
  readonly listOutOfRange: (params: AdDetectBlacklistPageOutOfRangeParams) => string;
  /** 分页列表首行标题。 */
  readonly listHeader: (params: AdDetectBlacklistListHeaderParams) => string;
  /** `add`/`remove` 既未指定包名又未显式回复消息时的提示。 */
  readonly missingPacks: (kindLabel: string, action: string) => string;
  /** `sticker add|remove` 回复的消息不是贴纸或不包含所属贴纸包名时的提示。 */
  readonly replyMissingStickerPack: string;
  /** `emoji add|remove` 回复的消息不含任何自定义表情实体时的提示。 */
  readonly replyMissingEmoji: string;
  /** `emoji add|remove` 调用 Telegram 接口查询自定义表情元数据失败时的提示。 */
  readonly replyEmojiQueryFailed: string;
  /** `emoji add|remove` 查到的自定义表情均未携带所属表情包名时的提示。 */
  readonly replyEmojiNoPack: string;
  /** 参数中存在不符合 `STICKER_PACK_NAME_PATTERN` 的包名、整批拒绝时的提示。 */
  readonly invalidPacks: (packs: string) => string;
  /** `sticker add` 命中机器人自身 `stickers.json` 已配置贴纸包、整批拒绝时的提示。 */
  readonly ownStickerPacksBlocked: (packs: string) => string;
  /** 变更结果首行标题，展示更新后的当前总条数。 */
  readonly mutationHeader: (kindLabel: string, total: number) => string;
  /** `add` 实际新增成功的包名汇总行。 */
  readonly addedLine: (packs: string) => string;
  /** `add` 原已在黑名单中的包名汇总行。 */
  readonly alreadyExistsLine: (packs: string) => string;
  /** `remove` 实际移除成功的包名汇总行。 */
  readonly removedLine: (packs: string) => string;
  /** `remove` 原不在黑名单中的包名汇总行。 */
  readonly notFoundLine: (packs: string) => string;
  /** 内存黑名单已更新但 SQLite 落盘尚未确认时的告警行。 */
  readonly persistUnconfirmedLine: string;
  /** 查询、写入或移除发生存储异常时的提示行。 */
  readonly storageFailed: string;
}

/** 各风格文案表必须提供相同的键和格式化函数签名。 */
export type AtmosphereTexts = typeof TeasingTexts;
