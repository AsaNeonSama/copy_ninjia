/**
 * Mini App 前端外壳导航、主题配色、状态轮询、名单分页、原生选择器轮询与通用交互时长常量。
 */

import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistMutationCode,
} from "../../types/miniApp/adBlacklists";
import type { MiniAppIdentityAddMode } from "../../types/miniApp/identities";
import type {
  MiniAppLanguage,
  MiniAppTabKey,
  MiniAppThemeMode,
} from "../../types/miniApp/ui";
import { exhaustiveList } from "../exhaustiveList";

/** 名单搜索输入框触发按名称过滤请求的防抖等待毫秒数（0.5 秒）。不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/IdentitySearchAndAddCard.tsx`。 */
export const MINI_APP_SEARCH_DEBOUNCE_MS: number = 500;

/** 白名单与黑名单列表接口缺省每页返回的条数（10 条）。不变量：属于 `MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/identities.ts` 与 `packages/mini-app-frontend/pages/IdentitiesPage.tsx`。 */
export const MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE: number = 10;

/** 白名单与黑名单列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/IdentitiesPage.tsx`。 */
export const MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * Mini App 首页实时状态轮询的间隔毫秒数（3 秒），自上一次响应结算起计时。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/status.ts`。
 */
export const MINI_APP_STATUS_POLL_INTERVAL_MS: number = 3_000;

/**
 * 实时状态页切换子系统折叠面板后暂缓提交状态快照的毫秒数；该时段内取得的快照在时段结束后才写入仓库，使快照重渲染落在展开/收起过渡之后。
 * 不变量：正整数毫秒数，大于等于 `MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS`。所属模块：`packages/mini-app-frontend/store/status.ts`。
 */
export const MINI_APP_STATUS_SNAPSHOT_HOLD_AFTER_TOGGLE_MS: number = 400;

/** 实时状态页 CPU 环形进度条 SVG 圆周长（半径 `r = 17.5` 时的 `2 * π * r` 近似值 `109.96`）。不变量：正浮点数，与 `StatusOverviewCard.tsx` 中环形进度圆的 `r="17.5"` 匹配。所属模块：`packages/mini-app-frontend/components/StatusOverviewCard.tsx`。 */
export const MINI_APP_CPU_RING_CIRCUMFERENCE: number = 109.96;

/**
 * 实时状态页骨架屏中能力折叠行占位的序号表（6 行，对应服务端状态快照的 6 项能力槽位）。
 * 不变量：从 0 起连续递增的只读整数数组，仅用作骨架行 key 与奇偶宽度切换。所属模块：`packages/mini-app-frontend/components/skeletons/StatusSkeleton.tsx`。
 */
export const MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES: readonly number[] = [0, 1, 2, 3, 4, 5];

/**
 * 实时状态页骨架屏中内存指标卡与图例占位的序号表（3 项，对应当前、峰值与堆内存）。
 * 不变量：从 0 起连续递增的只读整数数组，仅用作骨架节点 key。所属模块：`packages/mini-app-frontend/components/skeletons/StatusSkeleton.tsx`。
 */
export const MINI_APP_STATUS_SKELETON_MEMORY_INDICES: readonly number[] = [0, 1, 2];

/**
 * 热发言记录按发言人 ID 取模分配的头像与气泡色调档数。
 * 不变量：正整数，必须与 `styles/chats-detail.css` 中 `.tone-0` 至 `.tone-5` 的色调类数量一致。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGE_AVATAR_TONE_COUNT: number = 6;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的轮询间隔毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/api/pickerResult.ts`。
 */
export const MINI_APP_PICKER_POLL_INTERVAL_MS: number = 600;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的最大轮询次数。
 * 不变量：正整数。所属模块：`packages/mini-app-frontend/api/pickerResult.ts`。
 */
export const MINI_APP_PICKER_POLL_MAX_ATTEMPTS: number = 25;

/**
 * Mini App 顶部 Toast 提示自动消失毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/app.ts`。
 */
export const MINI_APP_TOAST_DURATION_MS: number = 2_600;

/**
 * Mini App 页面加载、列表刷新与图库骨架屏的最短展示毫秒数（260 毫秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/libs/loading.ts`。
 */
export const MINI_APP_MIN_LOADING_MS: number = 260;

/**
 * 分页控制栏按钮点击后临时 `.is-hovering` 类名与图库上传按钮点击后临时 `.is-pressing` 按压反馈保留的毫秒数（85 毫秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/PaginationBar.tsx` 与 `packages/mini-app-frontend/pages/GalleryPage.tsx`。
 */
export const MINI_APP_PAGINATION_HOVER_DURATION_MS: number = 85;

/**
 * 图库上传按钮与卡片悬浮按钮点击进入 `.hover-suppressed` 悬停抑制态后，指针距点击坐标移动超过该阈值（像素）时解除抑制并恢复悬停反馈。
 * 不变量：正整数像素值。所属模块：`packages/mini-app-frontend/pages/GalleryPage.tsx` 与 `packages/mini-app-frontend/components/GalleryGridList.tsx`。
 */
export const MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX: number = 4;

/**
 * Mini App 简体中文网页标题与顶栏主标题默认文案。
 * 不变量：非空短文本，与 `index.html` 的中文标题及 `i18n/languages/zh.ts` 的 `appTitle` 一致。所属模块：`packages/mini-app-frontend/i18n/languages/zh.ts`。
 */
export const MINI_APP_HTML_TITLE: string = "杂鱼控制台♡";

/**
 * Mini App 界面支持的语言键闭集（按英文、日文、中文顺序排列）。
 * 不变量：与 `MiniAppLanguage` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/PrefsBar.tsx`。
 */
export const MINI_APP_LANGUAGES: readonly MiniAppLanguage[] =
  exhaustiveList<MiniAppLanguage>()([
    "en",
    "ja",
    "zh",
  ]);

/** Mini App 初始主题模式（默认固定为亮色 `"light"`）。不变量：与 `index.html` 根节点 `<html>` 的初始 `data-theme="light"` 属性一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_INITIAL_THEME: MiniAppThemeMode = "light";

/** Mini App 界面支持的主题模式闭集（暗色、亮色）。不变量：与 `MiniAppThemeMode` 联合类型一一对应。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_THEME_MODES: readonly MiniAppThemeMode[] =
  exhaustiveList<MiniAppThemeMode>()([
    "dark",
    "light",
  ]);

/** Mini App 亮色主题页面背景色。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 亮色 `--bg` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_LIGHT_BG_COLOR: string = "#f6f2e8";

/** Mini App 暗色主题页面背景色（`#07080c`）。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 暗色 `--bg` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_DARK_BG_COLOR: string = "#07080c";

/** Mini App 亮色主题顶栏与卡片背景色。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 亮色 `--card` 及 `--header-bg` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_LIGHT_HEADER_COLOR: string = "#ffffff";

/** Mini App 暗色主题顶栏与工具栏背景色（`#232940`）。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 暗色 `--header-bg` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_DARK_HEADER_COLOR: string = "#232940";

/**
 * Mini App 名单与群内目标添加折叠菜单支持的添加模式闭集（按 ID、按联系人、按频道）。
 * 不变量：与 `MiniAppIdentityAddMode` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/AddModeButtonList.tsx`。
 */
export const MINI_APP_IDENTITY_ADD_MODES: readonly MiniAppIdentityAddMode[] =
  exhaustiveList<MiniAppIdentityAddMode>()([
    "id",
    "users",
    "channel",
  ]);

/**
 * Mini App 侧边栏主导航标签键闭集。
 * 不变量：与 `MiniAppTabKey` 联合类型一一对应，且 `"adBlacklists"` 紧跟 `"identities"` 之后、`"configs"` 紧跟 `"adBlacklists"` 之后。所属模块：`packages/mini-app-frontend/components/AppShell.tsx`。
 */
export const MINI_APP_TAB_KEYS: readonly MiniAppTabKey[] =
  exhaustiveList<MiniAppTabKey>()([
    "status",
    "chats",
    "identities",
    "adBlacklists",
    "configs",
    "gallery",
    "totp",
  ]);

/**
 * 内容黑名单页面支持的黑名单种类闭集（贴纸包、自定义表情包）。
 * 不变量：与 `MiniAppAdBlacklistKind` 联合类型一一对应；取值与 `packages/consts/miniApp/features.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/pages/AdBlacklistsPage.tsx`。
 */
export const MINI_APP_AD_BLACKLIST_KINDS: readonly MiniAppAdBlacklistKind[] =
  exhaustiveList<MiniAppAdBlacklistKind>()([
    "sticker",
    "emoji",
  ]);

/**
 * 内容黑名单分页接口缺省每页返回的条数（10 条）。
 * 不变量：属于 `MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS` 档位且不超过 `MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE`；取值与 `packages/consts/miniApp/features.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/adBlacklists.ts` 与 `packages/mini-app-frontend/pages/AdBlacklistsPage.tsx`。
 */
export const MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 内容黑名单分页接口单页允许的最大条数（20 条）。
 * 不变量：等于 `MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS` 的最大档位；取值与 `packages/consts/miniApp/features.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/pages/AdBlacklistsPage.tsx`。
 */
export const MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE: number = 20;

/**
 * 内容黑名单列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档，最大档等于 `MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE` 且包含 `MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE`。所属模块：`packages/mini-app-frontend/pages/AdBlacklistsPage.tsx`。
 */
export const MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 内容黑名单搜索关键字允许的最大字符数（128 字符）。
 * 不变量：正整数；取值与 `packages/consts/miniApp/features.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/adBlacklists.ts`、`packages/mini-app-frontend/store/adBlacklists.ts` 与 `packages/mini-app-frontend/pages/AdBlacklistsPage.tsx`。
 */
export const MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH: number = 128;

/**
 * 内容黑名单页内预览单页加载的贴纸/表情枚数（16 枚，对应 4×4 预览网格）。
 * 不变量：正整数，与 `packages/consts/miniApp/features.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/AdBlacklistPreviewModal.tsx`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE: number = 16;

/**
 * 内容黑名单页内预览弹窗在已知总枚数后执行「加载更多」时，按剩余枚数切片渲染精确格数图片骨架的序号表（上限 16 格，与 `MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE` 对齐）。
 * 不变量：从 0 起连续递增的只读整数数组，长度等于 `MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE`。所属模块：`packages/mini-app-frontend/components/AdBlacklistPreviewModal.tsx`。
 */
export const MINI_APP_AD_BLACKLIST_PREVIEW_SKELETON_INDICES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

/**
 * Telegram 贴纸包与自定义表情包 short name 的前端预校验匹配规则（1–64 位 ASCII 字母、数字或下划线）。
 * 不变量：不带全局标志 `g` 且只读，可无状态复用；取值与 `packages/consts/aiChat/stickers.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/adBlacklistPackInput.ts`。
 */
export const STICKER_PACK_NAME_PATTERN: Readonly<RegExp> = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Telegram 网页端贴纸包与自定义表情包分享链接匹配规则（支持 `t.me`、`telegram.me`、`telegram.dog`，协议头与尾部单斜杠均可选）。
 * 捕获组 1 为动作段（`addstickers` 或 `addemoji`），捕获组 2 为待经 `STICKER_PACK_NAME_PATTERN` 复核的包名候选段。
 * 不变量：不带全局标志 `g` 且只读，可无状态复用。所属模块：`packages/mini-app-frontend/libs/adBlacklistPackInput.ts`。
 */
export const MINI_APP_TELEGRAM_PACK_WEB_LINK_PATTERN: Readonly<RegExp> =
  /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(addstickers|addemoji)\/([^/?#\s]+)\/?$/i;

/**
 * Telegram 原生 `tg://` 贴纸包与自定义表情包深链匹配规则（`tg://addstickers?set=<pack>` 或 `tg://addemoji?set=<pack>`）。
 * 捕获组 1 为动作段（`addstickers` 或 `addemoji`），捕获组 2 为待经 `STICKER_PACK_NAME_PATTERN` 复核的包名候选段。
 * 不变量：不带全局标志 `g` 且只读，可无状态复用。所属模块：`packages/mini-app-frontend/libs/adBlacklistPackInput.ts`。
 */
export const MINI_APP_TELEGRAM_PACK_TG_LINK_PATTERN: Readonly<RegExp> =
  /^tg:\/\/(addstickers|addemoji)\/?\?set=([^&#\s]+)$/i;

/**
 * `POST /api/ad-blacklists` 服务端允许返回的全部业务状态码闭集（供前端识别非 2xx 结构化业务错误响应）。
 * 不变量：与 `MiniAppAdBlacklistMutationCode` 联合类型一一对应。所属模块：`packages/mini-app-frontend/api/adBlacklists.ts`。
 */
export const MINI_APP_AD_BLACKLIST_MUTATION_CODES: readonly MiniAppAdBlacklistMutationCode[] =
  exhaustiveList<MiniAppAdBlacklistMutationCode>()([
    "AD_BLACKLIST_ADDED",
    "AD_BLACKLIST_DUPLICATE",
    "AD_BLACKLIST_REMOVED",
    "AD_BLACKLIST_NOT_FOUND",
    "INVALID_AD_BLACKLIST_PARAMS",
    "INVALID_AD_BLACKLIST_PACK",
    "AD_BLACKLIST_BOT_OWN_PACK",
    "AD_BLACKLIST_STORAGE_UNAVAILABLE",
  ]);
