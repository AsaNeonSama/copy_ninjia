import type {
  MiniAppFeatureKey,
  MiniAppIdentityAddMode,
  MiniAppLanguage,
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
  MiniAppTabKey,
  MiniAppThemeMode,
  MiniAppToggleableFeatureKey,
} from "../types/miniApp";
import { exhaustiveList } from "./exhaustiveList";
import { MINUTE_MS } from "./time";

/**
 * `config/static/bot.json` 中 `mini_app.host` 缺省时绑定的本地回环地址。
 * 不变量：仅监听本机回环，由反向代理提供公网 HTTPS。所属模块：`packages/config/botInput.ts` 与 `packages/miniApp/server.ts`。
 */
export const MINI_APP_DEFAULT_HOST: string = "127.0.0.1";

/**
 * `mini_app.port` 允许的最小 TCP 端口号。
 * 不变量：正整数下界为 1。所属模块：`packages/config/botInput.ts`。
 */
export const MINI_APP_PORT_MIN: number = 1;

/**
 * `mini_app.port` 允许的最大 TCP 端口号。
 * 不变量：16 位无符号端口上界 65535。所属模块：`packages/config/botInput.ts`。
 */
export const MINI_APP_PORT_MAX: number = 65_535;

/**
 * Telegram WebApp `initData` HMAC-SHA256 派生密钥的固定种子字符串。
 * 不变量：遵循 Telegram Mini Apps 官方验签规范，恒为 `"WebAppData"`。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_WEB_APP_DATA_SECRET_SEED: string = "WebAppData";

/**
 * Telegram WebApp `initData` 中 `auth_date` 允许的最大有效秒数（45 分钟，与密码认证会话窗口对齐）。
 * 不变量：正整数秒数，超出视为过期凭据拒绝访问。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_AUTH_MAX_AGE_SECONDS: number = 2_700;

/**
 * Telegram WebApp `initData` 校验 `auth_date` 时允许的未来时钟偏移容差秒数（5 分钟）。
 * 不变量：非负整数秒数，超出该未来偏移的 `auth_date` 拒绝通过。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_AUTH_CLOCK_SKEW_SECONDS: number = 300;

/**
 * 十六进制 SHA-256 摘要字符串（固定 64 位十六进制字符）的匹配规则。
 * 不变量：不带全局标志 `g`，供 `verifyMiniAppInitData` 无状态复用。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_SHA256_HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/i;

/**
 * 十进制正整数时间戳的匹配规则。
 * 不变量：不带全局标志 `g`，供 `verifyMiniAppInitData` 无状态复用。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_POSITIVE_INTEGER_PATTERN: RegExp = /^[1-9]\d*$/;

/**
 * 十进制有符号整数参数的匹配规则。
 * 不变量：不带全局标志 `g`，供 HTTP 查询参数解析无状态复用。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_SIGNED_INTEGER_PATTERN: RegExp = /^-?\d+$/u;

/**
 * IPv4 字面量主机名的匹配规则（用于拦截 `Host` 请求头回显源站 IP 字面量）。
 * 不变量：不带全局标志 `g`，供 `accessErrorResponse` 无状态复用。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_IPV4_HOST_PATTERN: RegExp = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

/**
 * Unicode 双向文本控制字符（LRM/RLM/ALM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI）的全局匹配规则。
 * 不变量：用于清洗 Telegram 昵称中的 RLO 等控制字符，防止反转整行 UI 布局。所属模块：`packages/miniApp/identities/metadata.ts` 与 `packages/miniApp/ui/formatters.ts`。
 */
export const MINI_APP_BIDI_CONTROL_CHARS_PATTERN: RegExp =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * `/api/chats/:chatId` 及其子路径（`feature` / `messages`）的匹配规则。
 * 不变量：不带全局标志 `g`，供 HTTP 路由兜底解析无状态复用。所属模块：`packages/miniApp/http/chatRoutes.ts`。
 */
export const MINI_APP_CHAT_ROUTE_PATTERN: RegExp =
  /^\/api\/chats\/(-?\d+)(?:\/(feature|messages))?$/u;

/**
 * Mini App API 请求携带 Telegram WebApp `initData` 原始查询串的 HTTP 请求头名（小写）。
 * 不变量：所有 `/api/*` 鉴权统一读取该请求头。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_INIT_DATA_HEADER: string = "x-telegram-init-data";

/**
 * Mini App 密码认证通过后签发的会话令牌 HTTP 请求头名（小写）。
 * 不变量：除 `/api/auth/precheck` 与 `/api/auth/login` 外，所有业务 `/api/*` 接口均要求携带有效会话令牌。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_SESSION_HEADER: string = "x-mini-app-session";

/**
 * Mini App 访问密码认证会话的有效期毫秒数（45 分钟）。
 * 不变量：到期后必须重新输入密码完成认证。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_SESSION_TTL_MS: number = 45 * MINUTE_MS;

/**
 * Mini App 在浏览器 `localStorage` / `sessionStorage` 中持久化 45 分钟认证会话凭据的存储键名。
 * 不变量：仅在 Mini App 客户端 WebView 环境内持久化 `{ token, expiresAt, assetToken }`，过期或主动锁定时立即清除。所属模块：`packages/miniApp/ui/api.ts`。
 */
export const MINI_APP_SESSION_STORAGE_KEY: string =
  "copy_ninja_mini_app_session_v1";

/**
 * 超级管理员 ID 连续输错 Mini App 访问密码允许的最大次数（3 次机会）。
 * 不变量：正整数，连续失败达到该次数后立即锁定该超级管理员 ID 30 分钟。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_PASSWORD_MAX_ATTEMPTS: number = 3;

/**
 * 超级管理员 ID 连续输错 Mini App 访问密码达上限后的禁止访问锁定时长毫秒数（30 分钟）。
 * 不变量：锁定期内该超级管理员 ID 的一切预检、登录与 API 访问一律拒绝。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_PASSWORD_LOCKOUT_MS: number = 30 * MINUTE_MS;

/**
 * 主线程同时保留的 Mini App 已认证密码会话数量上限。
 * 不变量：有界 FIFO 淘汰，超出时移除最早会话。所属模块：`packages/cache/main/miniApp.ts`。
 */
export const MINI_APP_SESSION_MAX: number = 8;

/**
 * `config/static/bot.json` 中 `mini_app.password` 禁止使用的示例占位字符串。
 * 不变量：配置解析时命中该占位符直接按致命错误拒绝。所属模块：`packages/config/botInput.ts`。
 */
export const MINI_APP_PASSWORD_PLACEHOLDER: string = "replace-with-mini-app-password";

/**
 * `mini_app.password` 必须包含至少 6 位阿拉伯数字（`0-9`）的匹配规则。
 * 不变量：不带全局标志 `g`，供配置解析器无状态复用。所属模块：`packages/config/botInput.ts`。
 */
export const MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN: RegExp =
  /^(?:\D*\d){6}/u;

/**
 * 测试环境在未显式挂载 `mini_app` 配置时供路由单测使用的默认访问密码（与 `config_example/static/bot.json` 一致，包含 6 位数字）。
 * 不变量：仅在 `miniAppActiveConfigHolder.current` 与 `getBotMiniAppConfig()` 均未配置时作为回退值。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_FALLBACK_TEST_PASSWORD: string =
  "mini-app-example-password-908172";

/**
 * `Authorization: tma <initData>` 请求头的认证方案前缀（小写含尾空格）。
 * 不变量：与 `X-Telegram-Init-Data` 互为备选传递方式。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_TMA_AUTH_PREFIX: string = "tma ";

/**
 * Mini App 响应禁止 Cloudflare Tunnel 边缘节点与浏览器缓存的 `Cache-Control` 取值。
 * 不变量：所有动态页面与业务 JSON API 响应均带上此防缓存头。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_NO_STORE_CACHE_CONTROL: string =
  "no-store, no-cache, must-revalidate, max-age=0";

/**
 * Mini App 受保护图库图片与 SVG 资源在通过鉴权后允许 Telegram WebView 客户端与 Cloudflare CDN 边缘节点持久化缓存 7 天的 `Cache-Control` 取值。
 * 不变量：仅用于已通过鉴权中间件核验的 `200 OK` / `304 Not Modified` 图片、SVG 与图标资源响应；未通过鉴权的 `401`/`403` 响应固定使用 `no-store`。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_ASSET_CACHE_CONTROL: string =
  "public, max-age=604800, s-maxage=604800, immutable";

/**
 * 派生 Mini App 受保护静态/图库资源稳定鉴权令牌（`assetToken`）的 HMAC-SHA256 种子字符串。
 * 不变量：由 `BOT_TOKEN` 与 `SUPER_ADMIN_USER_ID` 确定性派生，使关闭并重开 Mini App 后的图片/SVG URL 保持稳定以命中 WebView 与 CDN 缓存。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_ASSET_TOKEN_SECRET_SEED: string =
  "CopyNinjaMiniAppAssetTokenV1";

/**
 * Mini App 响应的 `Content-Security-Policy` 安全策略头取值。
 * 不变量：仅允许同源脚本与 `https://telegram.org` 官方脚本，彻底封死外联 XSS 与页面嵌套。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_CSP_HEADER_VALUE: string =
  "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * Mini App 响应的 `X-Frame-Options` 安全头取值。
 * 不变量：恒为 `"DENY"`，禁止任何恶意外层页面嵌套（Clickjacking）。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_X_FRAME_OPTIONS_VALUE: string = "DENY";

/**
 * 名单搜索输入框触发按名称过滤请求的防抖等待毫秒数（0.5 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/miniApp/ui/components/IdentitiesTab.tsx`。
 */
export const MINI_APP_SEARCH_DEBOUNCE_MS: number = 500;

/**
 * Mini App JSON 写接口允许的最大请求体字节数（32 KiB）。
 * 不变量：用于 JSON 请求体解析边界。所属模块：`packages/miniApp/http/common.ts`。
 */
export const MINI_APP_MAX_JSON_BODY_BYTES: number = 32_768;

/**
 * Mini App HTTP 服务允许的最大请求体字节数（11 MiB，覆盖 10 MiB 随机图库单图上传上限并提供结构化超限报错余量）。
 * 不变量：大于 `RANDOM_IMAGE_MAX_BYTES`，配置到 `Bun.serve` 的 `maxRequestBodySize`。所属模块：`packages/miniApp/server.ts`。
 */
export const MINI_APP_MAX_UPLOAD_BODY_BYTES: number = 11 * 1024 * 1024;

/**
 * 图库分页接口缺省每页返回的图片张数（10 张）。
 * 不变量：`1..MINI_APP_GALLERY_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/miniApp/galleryView.ts`。
 */
export const MINI_APP_GALLERY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 图库分页接口单页允许的最大图片张数（20 张）。
 * 不变量：等于 `MINI_APP_GALLERY_PAGE_SIZE_OPTIONS` 的最大档位。所属模块：`packages/miniApp/galleryView.ts`。
 */
export const MINI_APP_GALLERY_MAX_PAGE_SIZE: number = 20;

/**
 * 图库页面可选的每页张数档位（默认 10 张，可切换 15、20 张）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/miniApp/ui/components/GalleryTab.tsx`。
 */
export const MINI_APP_GALLERY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * `/api/gallery/file/:fileName` 图库单张图片读取路由的匹配规则。
 * 不变量：不带全局标志 `g`，供 HTTP 路由兜底解析无状态复用。所属模块：`packages/miniApp/http/galleryRoutes.ts`。
 */
export const MINI_APP_GALLERY_FILE_ROUTE_PATTERN: RegExp =
  /^\/api\/gallery\/file\/([^/]+)$/u;

/**
 * `/api/gallery/download/:fileName` 图库单张图片附件下载路由的匹配规则。
 * 不变量：不带全局标志 `g`，供 HTTP 路由与资源鉴权中间件无状态复用。所属模块：`packages/miniApp/http/galleryRoutes.ts` 与 `packages/miniApp/http/middleware.ts`。
 */
export const MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN: RegExp =
  /^\/api\/gallery\/download\/([^/]+)$/u;

/**
 * `/api/resources/svg/:fileName` 与 `/miniAppResoures/:fileName` 受保护 SVG 资源读取路由的匹配规则。
 * 不变量：不带全局标志 `g`，供 HTTP 路由与资源鉴权中间件无状态复用。所属模块：`packages/miniApp/http/galleryRoutes.ts` 与 `packages/miniApp/http/middleware.ts`。
 */
export const MINI_APP_SVG_RESOURCE_ROUTE_PATTERN: RegExp =
  /^\/(?:api\/resources\/svg|miniAppResoures)\/([^/]+)$/u;

/**
 * 允许通过受保护 HTTP 路由读取的 SVG 图标安全文件名匹配规则（非点号开头、仅含字母数字与 `._-`、以 `.svg` 结尾）。
 * 不变量：不含路径分隔符或空字符，防止目录穿越。所属模块：`packages/miniApp/galleryView.ts`。
 */
export const MINI_APP_SVG_SAFE_FILE_NAME_PATTERN: RegExp =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/iu;

/**
 * 静态图片与 SVG 资源路径后缀的匹配规则（用于统一纳入受保护资源鉴权中间件链，不含公开 `/favicon.ico`）。
 * 不变量：不带全局标志 `g`，大小写不敏感匹配常见图片与矢量图扩展名。所属模块：`packages/miniApp/http/middleware.ts`。
 */
export const MINI_APP_PROTECTED_ASSET_EXT_PATTERN: RegExp =
  /\.(?:svg|png|jpe?g|webp|gif|avif)$/iu;

/**
 * 图库允许通过 HTTP 读取的单张图片安全文件名匹配规则（非点号开头、仅含字母数字与 `._-`、以受支持图片扩展名结尾）。
 * 不变量：不含路径分隔符或空字符，防止目录穿越。所属模块：`packages/miniApp/galleryView.ts`。
 */
export const MINI_APP_GALLERY_SAFE_FILE_NAME_PATTERN: RegExp =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp)$/iu;

/**
 * 群热发言记录接口缺省每页返回的条数（10 条）。
 * 不变量：`1..MINI_APP_MESSAGES_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/miniApp/messagesView.ts`。
 */
export const MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 群热发言记录接口单页允许的最大条数（20 条）。
 * 不变量：等于 `MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS` 的最大档位。所属模块：`packages/miniApp/messagesView.ts`。
 */
export const MINI_APP_MESSAGES_MAX_PAGE_SIZE: number = 20;

/**
 * 群热发言记录页面可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/miniApp/ui/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 已 `/init` 受管群列表缺省每页显示的群数量（10 条）。
 * 不变量：正整数。所属模块：`packages/miniApp/ui/components/ChatsTab.tsx`。
 */
export const MINI_APP_CHATS_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 已 `/init` 受管群列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/miniApp/ui/components/ChatsTab.tsx`。
 */
export const MINI_APP_CHATS_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 白名单与黑名单列表接口缺省每页返回的条数（10 条）。
 * 不变量：`1..MINI_APP_IDENTITY_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/miniApp/identities/whitelist.ts` 与 `packages/miniApp/identities/blocklist.ts`。
 */
export const MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 白名单与黑名单列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。
 * 不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/miniApp/ui/components/IdentitiesTab.tsx`。
 */
export const MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * 白名单与黑名单列表接口单页允许的最大条数（20 条）。
 * 不变量：不超过 `IDENTITY_POLICY_SWEEP_PAGE_SIZE`，等于 `MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS` 的最大档位。所属模块：`packages/miniApp/identities/whitelist.ts` 与 `packages/miniApp/identities/blocklist.ts`。
 */
export const MINI_APP_IDENTITY_MAX_PAGE_SIZE: number = 20;

/**
 * `savePreparedKeyboardButton` 预备选择器会话在主线程缓存中的存活时长（10 分钟）。
 * 不变量：到期后未消费的 `request_id` 记录自动淘汰。所属模块：`packages/miniApp/picker.ts`。
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
 * 不变量：Telegram Bot API 规定的上限为 10。所属模块：`packages/miniApp/picker.ts`。
 */
export const MINI_APP_PICKER_MAX_USERS_QUANTITY: number = 10;

/**
 * Mini App 单页 HTML 标题与超级管理员私聊菜单按钮显示文字。
 * 不变量：非空短文本。所属模块：`packages/miniApp/routes.ts` 与 `packages/app/commandMenu.ts`。
 */
export const MINI_APP_HTML_TITLE: string = "Copy Ninja 管理中心";

/**
 * Mini App 首页实时状态自动轮询间隔毫秒数（3 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/miniApp/ui/components/StatusTab.tsx`。
 */
export const MINI_APP_STATUS_POLL_INTERVAL_MS: number = 3_000;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的轮询间隔毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/miniApp/ui/components/IdentitiesTab.tsx`。
 */
export const MINI_APP_PICKER_POLL_INTERVAL_MS: number = 600;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的最大轮询次数。
 * 不变量：正整数。所属模块：`packages/miniApp/ui/components/IdentitiesTab.tsx`。
 */
export const MINI_APP_PICKER_POLL_MAX_ATTEMPTS: number = 25;

/**
 * Mini App 顶部 Toast 提示自动消失毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/miniApp/ui/App.tsx`。
 */
export const MINI_APP_TOAST_DURATION_MS: number = 2_600;

/**
 * Mini App 页面加载、列表刷新与图库骨架屏的最短动画展示毫秒数（0.26 秒，保证闪光骨架与过渡动画完整平滑呈现）。
 * 不变量：正整数毫秒数。所属模块：`packages/miniApp/ui/formatters.ts`。
 */
export const MINI_APP_MIN_LOADING_MS: number = 260;

/**
 * 超级管理员私聊左下角 `MenuButtonWebApp` 的显示文字。
 * 不变量：非空短文本。所属模块：`packages/app/commandMenu.ts`。
 */
export const MINI_APP_BUTTON_TEXT: string = "App";

/**
 * 已 `/init` 群内可独立开关的子功能键闭集。
 * 不变量：与 `MiniAppToggleableFeatureKey` 联合类型一一对应。所属模块：`packages/miniApp/chats/toggle.ts`。
 */
export const MINI_APP_TOGGLEABLE_FEATURE_KEYS: readonly MiniAppToggleableFeatureKey[] =
  exhaustiveList<MiniAppToggleableFeatureKey>()([
    "aiChat",
    "translation",
    "adDetect",
    "floodControl",
    "antiRaid",
    "proxySend",
  ]);

/**
 * Mini App 群详情页可操作的功能开关全集（含 `/init` 总开关）。
 * 不变量：与 `MiniAppFeatureKey` 联合类型一一对应。所属模块：`packages/miniApp/chats/toggle.ts`。
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
 * Mini App 原生选择器支持的目标名单类型闭集。
 * 不变量：与 `MiniAppPickerTargetList` 联合类型一一对应。所属模块：`packages/miniApp/picker.ts`。
 */
export const MINI_APP_PICKER_TARGET_LISTS: readonly MiniAppPickerTargetList[] =
  exhaustiveList<MiniAppPickerTargetList>()([
    "whitelist",
    "blocklist",
  ]);

/**
 * Mini App 原生选择器支持的身份种类闭集。
 * 不变量：与 `MiniAppPickerSubjectKind` 联合类型一一对应。所属模块：`packages/miniApp/picker.ts`。
 */
export const MINI_APP_PICKER_SUBJECT_KINDS: readonly MiniAppPickerSubjectKind[] =
  exhaustiveList<MiniAppPickerSubjectKind>()([
    "users",
    "channel",
  ]);

/**
 * Mini App 界面支持的语言键闭集（中文、日文、英文）。
 * 不变量：与 `MiniAppLanguage` 联合类型一一对应。所属模块：`packages/miniApp/ui/store.ts`。
 */
export const MINI_APP_LANGUAGES: readonly MiniAppLanguage[] =
  exhaustiveList<MiniAppLanguage>()([
    "zh",
    "ja",
    "en",
  ]);

/**
 * Mini App 界面支持的主题模式闭集（暗色、亮色）。
 * 不变量：与 `MiniAppThemeMode` 联合类型一一对应。所属模块：`packages/miniApp/ui/store.ts`。
 */
export const MINI_APP_THEME_MODES: readonly MiniAppThemeMode[] =
  exhaustiveList<MiniAppThemeMode>()([
    "dark",
    "light",
  ]);

/**
 * Mini App 名单添加折叠按钮支持的添加模式闭集（按 ID、按联系人、按频道）。
 * 不变量：与 `MiniAppIdentityAddMode` 联合类型一一对应。所属模块：`packages/miniApp/ui/components/IdentitiesTab.tsx`。
 */
export const MINI_APP_IDENTITY_ADD_MODES: readonly MiniAppIdentityAddMode[] =
  exhaustiveList<MiniAppIdentityAddMode>()([
    "id",
    "users",
    "channel",
  ]);

/**
 * Mini App 侧边栏主导航标签键闭集。
 * 不变量：与 `MiniAppTabKey` 联合类型一一对应。所属模块：`packages/miniApp/ui/App.tsx`。
 */
export const MINI_APP_TAB_KEYS: readonly MiniAppTabKey[] =
  exhaustiveList<MiniAppTabKey>()([
    "status",
    "chats",
    "identities",
    "gallery",
    "totp",
  ]);
