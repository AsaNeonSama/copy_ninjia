import type {
  MiniAppChatTargetKind,
  MiniAppFeatureKey,
  MiniAppIdentityAddMode,
  MiniAppLanguage,
  MiniAppTabKey,
  MiniAppThemeMode,
  MiniAppTranslateLanguage,
} from "../types/miniApp";
import { exhaustiveList } from "./exhaustiveList";
import { MINUTE_MS } from "./time";

/**
 * 十六进制 SHA-256 摘要字符串（固定 64 位十六进制字符）的匹配规则。
 * 不变量：不带全局标志 `g`，供持久化会话令牌格式校验无状态复用；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/credentials.ts`。
 */
export const MINI_APP_SHA256_HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/i;

/**
 * Unicode 双向文本控制字符（LRM/RLM/ALM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI）的全局匹配规则。
 * 不变量：用于清洗 Telegram 昵称中的 RLO 等控制字符，防止反转整行 UI 布局；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。
 */
export const MINI_APP_BIDI_CONTROL_CHARS_PATTERN: RegExp =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Mini App API 请求携带 Telegram WebApp `initData` 原始查询串的 HTTP 请求头名（小写）。
 * 不变量：所有 `/api/*` 鉴权统一读取该请求头；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。
 */
export const MINI_APP_INIT_DATA_HEADER: string = "x-telegram-init-data";

/**
 * Mini App 密码认证通过后签发的会话令牌 HTTP 请求头名（小写）。
 * 不变量：除 `/api/auth/precheck` 与 `/api/auth/login` 外，所有业务 `/api/*` 接口均要求携带有效会话令牌；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。
 */
export const MINI_APP_SESSION_HEADER: string = "x-mini-app-session";

/**
 * Mini App 会话令牌自动刷新时下发新到期毫秒时间戳的 HTTP 响应头名（小写）。
 * 不变量：取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。
 */
export const MINI_APP_SESSION_EXPIRES_AT_HEADER: string =
  "x-mini-app-session-expires-at";

/**
 * Mini App 访问密码认证会话的有效期毫秒数（45 分钟）。
 * 不变量：到期后必须重新输入密码完成认证；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/credentials.ts` 与 `packages/mini-app-frontend/api/authPrecheck.ts`。
 */
export const MINI_APP_SESSION_TTL_MS: number = 45 * MINUTE_MS;

/**
 * Mini App 会话令牌触发自动刷新与续期的已签发时长阈值毫秒数（5 分钟）。
 * 不变量：正整数毫秒数，小于 `MINI_APP_SESSION_TTL_MS`；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。
 */
export const MINI_APP_SESSION_REFRESH_THRESHOLD_MS: number = 5 * MINUTE_MS;

/**
 * Mini App 在浏览器 `localStorage` / `sessionStorage` 中持久化 45 分钟认证会话凭据的存储键名。
 * 不变量：仅在 Mini App 客户端 WebView 环境内持久化 `{ token, expiresAt, assetToken }`，过期或主动锁定时立即清除。所属模块：`packages/mini-app-frontend/libs/credentials.ts`。
 */
export const MINI_APP_SESSION_STORAGE_KEY: string =
  "copy_ninja_mini_app_session_v1";

/**
 * `Authorization: tma <initData>` 请求头的认证方案前缀（小写含尾空格）。
 * 不变量：与 `X-Telegram-Init-Data` 互为备选传递方式；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。
 */
export const MINI_APP_TMA_AUTH_PREFIX: string = "tma ";

/**
 * 名单搜索输入框触发按名称过滤请求的防抖等待毫秒数（0.5 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/pages/IdentitiesPage.tsx`。
 */
export const MINI_APP_SEARCH_DEBOUNCE_MS: number = 500;

/**
 * 图库分页接口缺省每页返回的图片张数（10 张）。
 * 不变量：属于 `MINI_APP_GALLERY_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/gallery.ts`。
 */
export const MINI_APP_GALLERY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 图库页面可选的每页张数档位（默认 10 张，可切换 15、20 张）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/GalleryPage.tsx`。
 */
export const MINI_APP_GALLERY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 群热发言记录接口缺省每页返回的条数（10 条）。
 * 不变量：属于 `MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/messages.ts` 与 `packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 群热发言记录页面可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 已 `/init` 受管群列表缺省每页显示的群数量（10 条）。
 * 不变量：正整数。所属模块：`packages/mini-app-frontend/store/chats.ts` 与 `packages/mini-app-frontend/pages/ChatsPage.tsx`。
 */
export const MINI_APP_CHATS_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 已 `/init` 受管群列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx`。
 */
export const MINI_APP_CHATS_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 白名单与黑名单列表接口缺省每页返回的条数（10 条）。
 * 不变量：属于 `MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/identities.ts` 与 `packages/mini-app-frontend/pages/IdentitiesPage.tsx`。
 */
export const MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 白名单与黑名单列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/IdentitiesPage.tsx`。
 */
export const MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * Mini App 首页实时状态轮询的间隔毫秒数（3 秒），自上一次响应结算起计时。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/status.ts`。
 */
export const MINI_APP_STATUS_POLL_INTERVAL_MS: number = 3_000;

/**
 * 实时状态页子系统折叠面板展开过渡的最短时长毫秒数（收起时长另乘 `MINI_APP_CAP_CLOSE_DURATION_FACTOR`）。
 * 不变量：正整数毫秒数，小于等于 `MINI_APP_CAP_COLLAPSE_MAX_DURATION_MS`。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。
 */
export const MINI_APP_CAP_COLLAPSE_MIN_DURATION_MS: number = 160;

/**
 * 实时状态页子系统折叠面板展开过渡的最长时长毫秒数（收起时长另乘 `MINI_APP_CAP_CLOSE_DURATION_FACTOR`）。
 * 不变量：正整数毫秒数，大于等于 `MINI_APP_CAP_COLLAPSE_MIN_DURATION_MS`。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。
 */
export const MINI_APP_CAP_COLLAPSE_MAX_DURATION_MS: number = 210;

/**
 * 实时状态页子系统折叠面板收起过渡时长相对同一内容高度展开时长的倍率（乘积取整）。
 * 不变量：大于等于 1 的有限浮点数。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。
 */
export const MINI_APP_CAP_CLOSE_DURATION_FACTOR: number = 1.1;

/**
 * 实时状态页切换子系统折叠面板后暂缓提交状态快照的毫秒数；该时段内取得的快照在时段结束后才写入仓库，使快照重渲染落在展开/收起过渡之后。
 * 不变量：正整数毫秒数，大于等于收起过渡的最长时长（`MINI_APP_CAP_COLLAPSE_MAX_DURATION_MS` 乘以 `MINI_APP_CAP_CLOSE_DURATION_FACTOR` 后取整）。所属模块：`packages/mini-app-frontend/store/status.ts`。
 */
export const MINI_APP_STATUS_SNAPSHOT_HOLD_AFTER_TOGGLE_MS: number = 250;

/**
 * 实时状态页子系统折叠面板在未测得内容高度时的缺省展开过渡时长毫秒数（收起时长另乘 `MINI_APP_CAP_CLOSE_DURATION_FACTOR`）。
 * 不变量：落在 `[MINI_APP_CAP_COLLAPSE_MIN_DURATION_MS, MINI_APP_CAP_COLLAPSE_MAX_DURATION_MS]` 区间内。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。
 */
export const MINI_APP_CAP_COLLAPSE_DEFAULT_DURATION_MS: number = 178;

/**
 * 实时状态页子系统折叠面板按内容高度线性折算展开过渡时长的基础毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。
 */
export const MINI_APP_CAP_COLLAPSE_BASE_DURATION_MS: number = 147;

/**
 * 实时状态页子系统折叠面板每像素内容高度折算的额外展开过渡毫秒系数。
 * 不变量：正有限浮点数。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。
 */
export const MINI_APP_CAP_COLLAPSE_HEIGHT_DURATION_FACTOR: number = 0.153;

/**
 * 实时状态页子系统折叠面板展开动画完成后，触发视口平滑向下跟滚前的稳定等待毫秒数。
 * 不变量：非负整数毫秒数。所属模块：`packages/mini-app-frontend/components/animations/CapabilityCollapseBody.tsx`。
 */
export const MINI_APP_CAP_SCROLL_SETTLE_DELAY_MS: number = 15;

/**
 * 实时状态页子系统折叠面板标题栏的估算像素高度（用于展开后跟滚时保留标题可见）。
 * 不变量：正整数像素值。所属模块：`packages/mini-app-frontend/components/animations/CapabilityCollapseBody.tsx`。
 */
export const MINI_APP_CAP_HEADER_ESTIMATED_HEIGHT_PX: number = 50;

/**
 * 折叠项展开完成后视口跟滚时，折叠项标题栏距离视口顶部的最小保留像素边距（实时状态页子系统面板、白名单权限抽屉与验证器绑定面板共用）。
 * 不变量：非负整数像素值。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX: number = 16;

/**
 * 折叠项展开完成后视口跟滚时，展开内容底部距离视口下沿的目标保留像素边距（实时状态页子系统面板、白名单权限抽屉与验证器绑定面板共用）。
 * 不变量：非负整数像素值。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX: number = 24;

/**
 * 折叠项展开完成后视口跟滚时，触发舒适阅读区上移的视口高度比例阈值（标题栏顶部低于该比例处才上移；实时状态页子系统面板、白名单权限抽屉与验证器绑定面板共用）。
 * 不变量：`(0, 1)` 区间内的浮点数。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_COMFORT_TOP_RATIO: number = 0.28;

/**
 * 折叠项位于视口中下半区展开完成后，按展开内容高度折算跟滚距离的比例系数（实时状态页子系统面板、白名单权限抽屉与验证器绑定面板共用）。
 * 不变量：`(0, 1)` 区间内的浮点数。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR: number = 0.55;

/**
 * 折叠项展开完成后触发视口平滑跟滚的最小像素位移阈值（小于等于该值时不触发滚动；实时状态页子系统面板、白名单权限抽屉与验证器绑定面板共用）。
 * 不变量：非负整数像素值。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX: number = 4;

/**
 * Google Authenticator (TOTP) 管理卡片绑定表单收起过渡动画的毫秒数（与 `styles/auth.css` 的 `0.24s` 齐平）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/pages/TotpPage.tsx`。
 */
export const MINI_APP_TOTP_SETUP_COLLAPSE_MS: number = 240;

/**
 * 图库大图预览卡片关闭收起过渡动画的毫秒数（与 `styles/gallery.css` 的 `0.24s` 齐平）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/pages/GalleryPage.tsx`。
 */
export const MINI_APP_GALLERY_PREVIEW_COLLAPSE_MS: number = 240;

/**
 * 群内目标管理弹窗关闭收起退场动画的毫秒数（与 `styles/chats.css` 的 `0.18s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const MINI_APP_TARGETS_MODAL_CLOSE_MS: number = 180;

/**
 * 底部 Toast 提示淡出退场动画的毫秒数（与 `styles/overlays.css` 的 `0.2s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/Toast.tsx`。
 */
export const MINI_APP_TOAST_CLOSE_ANIMATION_MS: number = 200;

/**
 * 自定义确认弹窗关闭收起退场动画的毫秒数（与 `styles/overlays.css` 的 `0.18s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/ConfirmModal.tsx`。
 */
export const MINI_APP_CONFIRM_CLOSE_ANIMATION_MS: number = 180;

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
 * 不变量：正整数，必须与 `styles/chats.css` 中 `.tone-0` 至 `.tone-5` 的色调类数量一致。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGE_AVATAR_TONE_COUNT: number = 6;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的轮询间隔毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/identities.ts` 与 `packages/mini-app-frontend/store/chatTargetsActions.ts`。
 */
export const MINI_APP_PICKER_POLL_INTERVAL_MS: number = 600;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的最大轮询次数。
 * 不变量：正整数。所属模块：`packages/mini-app-frontend/store/identities.ts` 与 `packages/mini-app-frontend/store/chatTargetsActions.ts`。
 */
export const MINI_APP_PICKER_POLL_MAX_ATTEMPTS: number = 25;

/**
 * Mini App 顶部 Toast 提示自动消失毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/app.ts`。
 */
export const MINI_APP_TOAST_DURATION_MS: number = 2_600;

/**
 * Mini App 页面加载、列表刷新与图库骨架屏的最短动画展示毫秒数（0.26 秒，保证闪光骨架与过渡动画完整平滑呈现）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/libs/loading.ts`。
 */
export const MINI_APP_MIN_LOADING_MS: number = 260;

/**
 * 分页控制栏按钮点击后 hover 视觉状态固定保留的毫秒数（85 毫秒，消除移动设备点击翻页后残留的粘滞 hover 状态）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/PaginationBar.tsx`。
 */
export const MINI_APP_PAGINATION_HOVER_DURATION_MS: number = 85;

/**
 * Mini App 管理界面的标题文字。
 * 不变量：非空短文本。所属模块：Mini App 前端（`packages/mini-app-frontend/`），当前未被引用。
 */
export const MINI_APP_HTML_TITLE: string = "杂鱼控制台♡";

/**
 * Mini App 群详情页可操作的功能开关全集（含 `/init` 总开关）。
 * 不变量：与 `MiniAppFeatureKey` 联合类型一一对应；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx` 与 `packages/mini-app-frontend/components/skeletons/ChatDetailSkeleton.tsx`。
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
 * Mini App 界面支持的语言键闭集（中文、日文、英文）。
 * 不变量：与 `MiniAppLanguage` 联合类型一一对应。所属模块：`packages/mini-app-frontend/store/app.ts` 与 `packages/mini-app-frontend/components/PrefsBar.tsx`。
 */
export const MINI_APP_LANGUAGES: readonly MiniAppLanguage[] =
  exhaustiveList<MiniAppLanguage>()([
    "zh",
    "ja",
    "en",
  ]);

/**
 * Mini App 界面支持的主题模式闭集（暗色、亮色）。
 * 不变量：与 `MiniAppThemeMode` 联合类型一一对应。所属模块：Mini App 前端（`packages/mini-app-frontend/`），当前未被引用。
 */
export const MINI_APP_THEME_MODES: readonly MiniAppThemeMode[] =
  exhaustiveList<MiniAppThemeMode>()([
    "dark",
    "light",
  ]);

/**
 * Mini App 名单与群内目标添加折叠菜单支持的添加模式闭集（按 ID、按联系人、按频道）。
 * 不变量：与 `MiniAppIdentityAddMode` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/IdentitySearchAndAddCard.tsx` 与 `packages/mini-app-frontend/components/ChatTargetsMemberPanels.tsx`。
 */
export const MINI_APP_IDENTITY_ADD_MODES: readonly MiniAppIdentityAddMode[] =
  exhaustiveList<MiniAppIdentityAddMode>()([
    "id",
    "users",
    "channel",
  ]);

/**
 * Mini App 侧边栏主导航标签键闭集。
 * 不变量：与 `MiniAppTabKey` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/AppShell.tsx`。
 */
export const MINI_APP_TAB_KEYS: readonly MiniAppTabKey[] =
  exhaustiveList<MiniAppTabKey>()([
    "status",
    "chats",
    "identities",
    "gallery",
    "totp",
  ]);

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）允许的最短回溯小时数。
 * 不变量：正整数下界 1，与 `packages/consts/miniApp.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/chats.ts` 与 `packages/mini-app-frontend/components/ChatJoinCleanCard.tsx`。
 */
export const MINI_APP_BATCH_KICK_MIN_HOURS: number = 1;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）允许的最长回溯小时数。
 * 不变量：正整数上界 24，与 `packages/consts/miniApp.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/chats.ts` 与 `packages/mini-app-frontend/components/ChatJoinCleanCard.tsx`。
 */
export const MINI_APP_BATCH_KICK_MAX_HOURS: number = 24;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）的初始默认回溯小时数。
 * 不变量：`MINI_APP_BATCH_KICK_MIN_HOURS..MINI_APP_BATCH_KICK_MAX_HOURS` 之间的正整数。所属模块：`packages/mini-app-frontend/store/chats.ts`。
 */
export const MINI_APP_BATCH_KICK_DEFAULT_HOURS: number = 1;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）的快捷小时档位列表。
 * 不变量：严格递增的 `1..24` 正整数只读数组。所属模块：`packages/mini-app-frontend/components/ChatJoinCleanCard.tsx`。
 */
export const MINI_APP_BATCH_KICK_PRESET_HOURS: readonly number[] = [1, 3, 6, 12, 24];

/**
 * Mini App 群详情页在后台 `/batch_kick` 批次执行期间轮询服务端完成回调状态的间隔毫秒数（90 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx`。
 */
export const MINI_APP_BATCH_KICK_POLL_INTERVAL_MS: number = 90_000;

/**
 * Mini App 群详情页切换回溯清理时间窗口（滑块、步进或预设档位）时触发实时入群人数查询的防抖等待毫秒数（0.5 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/chats.ts`。
 */
export const MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS: number = 500;

/**
 * Mini App 群详情页点击回溯清理窗口小时按钮（步进 `−`/`+` 或快捷档位 `1h`–`24h`）时进度条与滑块平滑生长并带定点弹性回弹的动画时长毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。
 */
export const MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS: number = 320;

/**
 * Mini App 群详情页目标管理下拉菜单与弹窗支持的类别键闭集（问答对、追着删目标、追着翻目标）。
 * 不变量：与 `MiniAppChatTargetKind` 联合类型一一对应；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx` 与 `packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const MINI_APP_CHAT_TARGET_KINDS: readonly MiniAppChatTargetKind[] =
  exhaustiveList<MiniAppChatTargetKind>()([
    "qa",
    "deleteMessage",
    "translate",
  ]);

/**
 * Mini App 群内追着翻目标支持的目标语言闭集。
 * 不变量：与 `MiniAppTranslateLanguage` 联合类型一一对应；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsMemberPanels.tsx`。
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
 * 群内目标管理弹窗数据条目骨架屏中列表行占位的序号表（3 行）。
 * 不变量：从 0 起连续递增的只读整数数组，仅用作骨架行 key。所属模块：`packages/mini-app-frontend/components/skeletons/ChatTargetsListSkeleton.tsx`。
 */
export const MINI_APP_TARGETS_SKELETON_ROW_INDICES: readonly number[] = [0, 1, 2];
