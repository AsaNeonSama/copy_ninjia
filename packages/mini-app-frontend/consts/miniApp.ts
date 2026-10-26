import type {
  MiniAppFeatureKey,
  MiniAppIdentityAddMode,
  MiniAppLanguage,
  MiniAppTabKey,
  MiniAppThemeMode,
} from "../types/miniApp";
import { exhaustiveList } from "./exhaustiveList";
import { MINUTE_MS } from "./time";

/**
 * 十六进制 SHA-256 摘要字符串（固定 64 位十六进制字符）的匹配规则。
 * 不变量：不带全局标志 `g`，供持久化会话令牌格式校验无状态复用；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/credentials.ts`。
 */
export const MINI_APP_SHA256_HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/i;

/**
 * Unicode 双向文本控制字符（LRM/RLM/ALM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI）的全局匹配规则。
 * 不变量：用于清洗 Telegram 昵称中的 RLO 等控制字符，防止反转整行 UI 布局；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。
 */
export const MINI_APP_BIDI_CONTROL_CHARS_PATTERN: RegExp =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Mini App API 请求携带 Telegram WebApp `initData` 原始查询串的 HTTP 请求头名（小写）。
 * 不变量：所有 `/api/*` 鉴权统一读取该请求头；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。
 */
export const MINI_APP_INIT_DATA_HEADER: string = "x-telegram-init-data";

/**
 * Mini App 密码认证通过后签发的会话令牌 HTTP 请求头名（小写）。
 * 不变量：除 `/api/auth/precheck` 与 `/api/auth/login` 外，所有业务 `/api/*` 接口均要求携带有效会话令牌；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。
 */
export const MINI_APP_SESSION_HEADER: string = "x-mini-app-session";

/**
 * Mini App 访问密码认证会话的有效期毫秒数（45 分钟）。
 * 不变量：到期后必须重新输入密码完成认证；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/credentials.ts` 与 `packages/mini-app-frontend/api/authPrecheck.ts`。
 */
export const MINI_APP_SESSION_TTL_MS: number = 45 * MINUTE_MS;

/**
 * Mini App 在浏览器 `localStorage` / `sessionStorage` 中持久化 45 分钟认证会话凭据的存储键名。
 * 不变量：仅在 Mini App 客户端 WebView 环境内持久化 `{ token, expiresAt, assetToken }`，过期或主动锁定时立即清除。所属模块：`packages/mini-app-frontend/libs/credentials.ts`。
 */
export const MINI_APP_SESSION_STORAGE_KEY: string =
  "copy_ninja_mini_app_session_v1";

/**
 * `Authorization: tma <initData>` 请求头的认证方案前缀（小写含尾空格）。
 * 不变量：与 `X-Telegram-Init-Data` 互为备选传递方式；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。
 */
export const MINI_APP_TMA_AUTH_PREFIX: string = "tma ";

/**
 * 名单搜索输入框触发按名称过滤请求的防抖等待毫秒数（0.5 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/IdentitiesTab.tsx`。
 */
export const MINI_APP_SEARCH_DEBOUNCE_MS: number = 500;

/**
 * 图库分页接口缺省每页返回的图片张数（10 张）。
 * 不变量：属于 `MINI_APP_GALLERY_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/gallery.ts`。
 */
export const MINI_APP_GALLERY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 图库页面可选的每页张数档位（默认 10 张，可切换 15、20 张）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/components/GalleryTab.tsx`。
 */
export const MINI_APP_GALLERY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 群热发言记录接口缺省每页返回的条数（10 条）。
 * 不变量：属于 `MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/messages.ts` 与 `packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 群热发言记录页面可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 已 `/init` 受管群列表缺省每页显示的群数量（10 条）。
 * 不变量：正整数。所属模块：`packages/mini-app-frontend/store/chats.ts` 与 `packages/mini-app-frontend/components/ChatsTab.tsx`。
 */
export const MINI_APP_CHATS_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 已 `/init` 受管群列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/components/ChatsTab.tsx`。
 */
export const MINI_APP_CHATS_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 白名单与黑名单列表接口缺省每页返回的条数（10 条）。
 * 不变量：属于 `MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/identities.ts` 与 `packages/mini-app-frontend/components/IdentitiesTab.tsx`。
 */
export const MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 白名单与黑名单列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/components/IdentitiesTab.tsx`。
 */
export const MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * Mini App 首页实时状态自动轮询间隔毫秒数（3 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/StatusTab.tsx`。
 */
export const MINI_APP_STATUS_POLL_INTERVAL_MS: number = 3_000;

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
 * 不变量：正整数，必须与 `styles.css` 中 `.tone-0` 至 `.tone-5` 的色调类数量一致。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGE_AVATAR_TONE_COUNT: number = 6;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的轮询间隔毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/identities.ts`。
 */
export const MINI_APP_PICKER_POLL_INTERVAL_MS: number = 600;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的最大轮询次数。
 * 不变量：正整数。所属模块：`packages/mini-app-frontend/store/identities.ts`。
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
 * Mini App 管理界面的标题文字。
 * 不变量：非空短文本。所属模块：Mini App 前端（`packages/mini-app-frontend/`），当前未被引用。
 */
export const MINI_APP_HTML_TITLE: string = "Copy Ninja 管理中心";

/**
 * Mini App 群详情页可操作的功能开关全集（含 `/init` 总开关）。
 * 不变量：与 `MiniAppFeatureKey` 联合类型一一对应；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/miniApp/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatsTab.tsx` 与 `packages/mini-app-frontend/components/skeletons/ChatDetailSkeleton.tsx`。
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
 * Mini App 名单添加折叠按钮支持的添加模式闭集（按 ID、按联系人、按频道）。
 * 不变量：与 `MiniAppIdentityAddMode` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/IdentitiesTab.tsx`。
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
