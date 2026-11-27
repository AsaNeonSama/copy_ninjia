import type { MiniAppAdBlacklistKind } from "../../types/miniApp/adBlacklists";
import type {
  MiniAppChatTargetsMutationAction,
  MiniAppFeatureKey,
  MiniAppTranslateLanguage,
} from "../../types/miniApp/chats";
import type {
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
} from "../../types/miniApp/identities";
import { exhaustiveList } from "../exhaustiveList";
import { MINUTE_MS } from "../time";

/**
 * 图库分页接口缺省每页返回的图片张数（10 张）。
 * 不变量：`1..MINI_APP_GALLERY_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/mini-app-api-server/view/gallery.ts`。
 */
export const MINI_APP_GALLERY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 图库分页接口单页允许的最大图片张数（20 张）。
 * 不变量：等于前端 `packages/mini-app-frontend/consts/miniApp.ts` 中 `MINI_APP_GALLERY_PAGE_SIZE_OPTIONS` 的最大档位，
 * 由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-api-server/view/gallery.ts`。
 */
export const MINI_APP_GALLERY_MAX_PAGE_SIZE: number = 20;

/**
 * 图库允许通过 HTTP 读取的单张图片安全文件名匹配规则（非点号开头、仅含字母数字与 `._-`、以受支持图片扩展名结尾）。
 * 不变量：拒绝含路径分隔符或空字符的文件名。所属模块：`packages/mini-app-api-server/view/gallery.ts`。
 */
export const MINI_APP_GALLERY_SAFE_FILE_NAME_PATTERN: Readonly<RegExp> =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp)$/iu;

/**
 * 群热发言记录接口缺省每页返回的条数（10 条）。
 * 不变量：`1..MINI_APP_MESSAGES_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/mini-app-api-server/view/messages.ts`。
 */
export const MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 群热发言记录接口单页允许的最大条数（20 条）。
 * 不变量：等于前端 `packages/mini-app-frontend/consts/miniApp.ts` 中 `MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS` 的最大档位，
 * 由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-api-server/view/messages.ts`。
 */
export const MINI_APP_MESSAGES_MAX_PAGE_SIZE: number = 20;

/**
 * 白名单与黑名单列表接口缺省每页返回的条数（10 条）。
 * 不变量：`1..MINI_APP_IDENTITY_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/mini-app-api-server/view/identities/page.ts`。
 */
export const MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 白名单与黑名单列表接口单页允许的最大条数（20 条）。
 * 不变量：不超过 `BLOCKLIST_SWEEP_PAGE_SIZE`，等于前端 `packages/mini-app-frontend/consts/miniApp.ts` 中
 * `MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS` 的最大档位，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。
 * 所属模块：`packages/mini-app-api-server/view/identities/page.ts`。
 */
export const MINI_APP_IDENTITY_MAX_PAGE_SIZE: number = 20;

/**
 * `savePreparedKeyboardButton` 预备选择器会话在主线程缓存中的存活时长（10 分钟）。
 * 不变量：到期后未消费的 `request_id` 记录自动淘汰。所属模块：`packages/mini-app-api-server/picker/sessions.ts`。
 */
export const MINI_APP_PICKER_TTL_MS: number = 10 * MINUTE_MS;

/**
 * 主线程同时保留的待完成选择器会话容量上限。
 * 不变量：有界 FIFO 淘汰，超出时移除最早的未完成会话。所属模块：`packages/cache/main/miniApp.ts`。
 */
export const MINI_APP_PICKER_MAX_PENDING: number = 32;

/**
 * 主线程保留的已完成选择器结果事件容量上限。
 * 不变量：有界 FIFO 淘汰，供前端查询最新一次选择导入回执。所属模块：`packages/cache/main/miniApp.ts`。
 */
export const MINI_APP_PICKER_MAX_RESULTS: number = 32;

/**
 * Telegram `KeyboardButtonRequestUsers` 单次允许选择的最大用户数量。
 * 不变量：Telegram Bot API 规定的上限为 10。所属模块：`packages/mini-app-api-server/picker/prepare.ts`。
 */
export const MINI_APP_PICKER_MAX_USERS_QUANTITY: number = 10;

/**
 * 超级管理员私聊左下角 `MenuButtonWebApp` 的显示文字。
 * 不变量：非空短文本。所属模块：`packages/app/commandMenu.ts`。
 */
export const MINI_APP_BUTTON_TEXT: string = "App";

/**
 * Mini App 群详情页可操作的功能开关全集（含 `/init` 总开关）。
 * 不变量：与 `MiniAppFeatureKey` 联合类型一一对应。所属模块：`packages/mini-app-api-server/handlers/chats.ts`。
 */
export const MINI_APP_FEATURE_KEYS: readonly MiniAppFeatureKey[] =
  exhaustiveList<MiniAppFeatureKey>()([
    "init",
    "aiChat",
    "translation",
    "adDetect",
    "floodControl",
    "antiRaid",
    "proxySend",
  ]);

/**
 * Mini App 原生选择器支持的目标名单类型闭集（白名单、黑名单、删发言目标、翻译目标）。
 * 不变量：与 `MiniAppPickerTargetList` 联合类型一一对应。所属模块：`packages/mini-app-api-server/handlers/identities.ts`。
 */
export const MINI_APP_PICKER_TARGET_LISTS: readonly MiniAppPickerTargetList[] =
  exhaustiveList<MiniAppPickerTargetList>()([
    "whitelist",
    "blocklist",
    "deleteMessage",
    "translate",
  ]);

/**
 * Mini App 原生选择器支持的身份种类闭集。
 * 不变量：与 `MiniAppPickerSubjectKind` 联合类型一一对应。所属模块：`packages/mini-app-api-server/handlers/identities.ts`。
 */
export const MINI_APP_PICKER_SUBJECT_KINDS: readonly MiniAppPickerSubjectKind[] =
  exhaustiveList<MiniAppPickerSubjectKind>()([
    "users",
    "channel",
  ]);

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）允许的最短回溯小时数。
 * 不变量：正整数下界 1。所属模块：`packages/mini-app-api-server/handlers/chats.ts`。
 */
export const MINI_APP_BATCH_KICK_MIN_HOURS: number = 1;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）允许的最长回溯小时数。
 * 不变量：正整数上界 24（对应 `DAY_MS`）。所属模块：`packages/mini-app-api-server/handlers/chats.ts` 与 `packages/mini-app-api-server/view/chats/query.ts`。
 */
export const MINI_APP_BATCH_KICK_MAX_HOURS: number = 24;

/**
 * Mini App 群内追着翻目标支持的目标语言闭集。
 * 不变量：与 `MiniAppTranslateLanguage` 及 `TranslateLanguage` 联合类型一一对应。
 * 所属模块：`packages/mini-app-api-server/handlers/chats.ts`、`packages/mini-app-api-server/handlers/identities.ts`
 * 与 `packages/mini-app-api-server/view/chats/targets.ts`。
 */
export const MINI_APP_TRANSLATE_LANGUAGES: readonly MiniAppTranslateLanguage[] =
  exhaustiveList<MiniAppTranslateLanguage>()([
    "ja",
    "cn",
    "en",
    "uk",
    "ru",
  ]);

/**
 * Mini App 群内问答对、追着删目标与追着翻目标增删接口支持的操作键闭集。
 * 不变量：与 `MiniAppChatTargetsMutationAction` 联合类型一一对应。所属模块：`packages/mini-app-api-server/handlers/chats.ts`。
 */
export const MINI_APP_CHAT_TARGETS_MUTATION_ACTIONS: readonly MiniAppChatTargetsMutationAction[] =
  exhaustiveList<MiniAppChatTargetsMutationAction>()([
    "setQa",
    "removeQa",
    "addDeleteTarget",
    "removeDeleteTarget",
    "addTranslateTarget",
    "removeTranslateTarget",
  ]);

/**
 * Mini App 内容黑名单支持的种类闭集（贴纸包与自定义表情包）。
 * 不变量：与 `MiniAppAdBlacklistKind` 联合类型一一对应，由 `test/mini-app-frontend/frontendParity.test.ts` 与前端副本核对一致。
 * 所属模块：`packages/mini-app-api-server/handlers/adBlacklists.ts`。
 */
export const MINI_APP_AD_BLACKLIST_KINDS: readonly MiniAppAdBlacklistKind[] =
  exhaustiveList<MiniAppAdBlacklistKind>()([
    "sticker",
    "emoji",
  ]);

/**
 * 内容黑名单分页接口缺省每页返回的条数（10 条）。
 * 不变量：`1..MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE` 之间的正整数，与其他分页列表统一，由 `test/mini-app-frontend/frontendParity.test.ts` 与前端副本核对一致。
 * 所属模块：`packages/mini-app-api-server/handlers/adBlacklists.ts` 与 `packages/mini-app-api-server/view/adBlacklists.ts`。
 */
export const MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 内容黑名单分页接口单页允许的最大条数（20 条）。
 * 不变量：等于前端 `packages/mini-app-frontend/consts/miniApp/ui.ts` 中 `MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS` 的最大档位，由 `test/mini-app-frontend/frontendParity.test.ts` 与前端副本核对一致。
 * 所属模块：`packages/mini-app-api-server/handlers/adBlacklists.ts` 与 `packages/mini-app-api-server/view/adBlacklists.ts`。
 */
export const MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE: number = 20;

/**
 * 内容黑名单分页搜索关键字（`query`）经首尾裁剪后允许的最大字符长度（128 字符）。
 * 不变量：正整数上界，超出时 `GET /api/ad-blacklists` 返回 `400 INVALID_AD_BLACKLIST_PARAMS`，由 `test/mini-app-frontend/frontendParity.test.ts` 与前端副本核对一致。
 * 所属模块：`packages/mini-app-api-server/handlers/adBlacklists.ts`。
 */
export const MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH: number = 128;

/**
 * 内容黑名单包预览接口单页最多拉取并内联缩略图的贴纸/自定义表情枚数（16 枚，对应 4×4 预览网格）。
 * 不变量：正整数，与前端 `packages/mini-app-frontend/consts/miniApp/ui.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。
 * 所属模块：`packages/mini-app-api-server/view/adBlacklistsPreview.ts`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE: number = 16;

/**
 * 内容黑名单包预览并发下载缩略图的最大在途任务数（4 路有界并发）。
 * 不变量：正安全整数，经 `runBoundedSettledBatch` 约束 Telegram 下载闸门并发。
 * 所属模块：`packages/mini-app-api-server/view/adBlacklistsPreview.ts`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_DOWNLOAD_CONCURRENCY: number = 4;

/**
 * 内容黑名单包预览单枚贴纸/缩略图下载允许的最大字节数（512 KiB）。
 * 不变量：正整数，超限时该枚优雅降级为 Emoji/格式占位，不拖垮整包预览。
 * 所属模块：`packages/mini-app-api-server/view/adBlacklistsPreview.ts`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_ITEM_MAX_BYTES: number = 512 * 1024;

/**
 * 内容黑名单包预览调用 `getStickerSet` 获取包元数据的超时毫秒数（10 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-api-server/view/adBlacklistsPreview.ts`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_SET_TIMEOUT_MS: number = 10_000;

/**
 * 内容黑名单包预览单枚贴纸/缩略图调用 `getFile` 的超时毫秒数（5 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-api-server/view/adBlacklistsPreview.ts`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_FILE_META_TIMEOUT_MS: number = 5_000;

/**
 * 内容黑名单包预览单枚贴纸/缩略图 HTTP 下载阶段的超时毫秒数（8 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-api-server/view/adBlacklistsPreview.ts`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_FILE_DOWNLOAD_TIMEOUT_MS: number = 8_000;

/**
 * 内容黑名单包预览单页批量下载缩略图的总超时预算毫秒数（15 秒）。
 * 不变量：正整数毫秒数，防止大量慢连接阻塞预览响应。所属模块：`packages/mini-app-api-server/view/adBlacklistsPreview.ts`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_BATCH_TIMEOUT_MS: number = 15_000;

/**
 * Telegram `getStickerSet` 返回贴纸/自定义表情包不存在或已失效时的错误描述匹配规则（`400 STICKERSET_INVALID`）。
 * 不变量：不带全局标志 `g` 且只读，可无状态复用。所属模块：`packages/mini-app-api-server/view/adBlacklistsPreview.ts`。
 */
export const MINI_APP_AD_BLACKLIST_STICKERSET_INVALID_PATTERN: Readonly<RegExp> =
  /STICKERSET_INVALID/iu;
