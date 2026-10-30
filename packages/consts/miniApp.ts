import type {
  MiniAppChatTargetsMutationAction,
  MiniAppFeatureKey,
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
  MiniAppTranslateLanguage,
} from "../types/miniApp";
import { exhaustiveList } from "./exhaustiveList";
import { MINUTE_MS } from "./time";

/**
 * `config/static/bot.json` 中 `mini_app.host` 缺省时绑定的本地回环地址。
 * 不变量：仅监听本机回环，由反向代理提供公网 HTTPS。所属模块：`packages/config/botInput.ts` 与 `packages/mini-app-api-server/server/serve.ts`。
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
 * 不变量：不带全局标志 `g`，供 HTTP 查询参数解析无状态复用。所属模块：`packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_SIGNED_INTEGER_PATTERN: RegExp = /^-?\d+$/u;

/**
 * IPv4 字面量主机名的匹配规则（用于拦截 `Host` 请求头回显源站 IP 字面量）。
 * 不变量：不带全局标志 `g`，供 `accessErrorResponse` 无状态复用。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_IPV4_HOST_PATTERN: RegExp = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

/**
 * Unicode 双向文本控制字符（LRM/RLM/ALM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI）的全局匹配规则。
 * 不变量：用于清洗 Telegram 昵称中的 RLO 等控制字符，防止反转整行 UI 布局。所属模块：`packages/mini-app-api-server/view/identities/metadata.ts`。
 */
export const MINI_APP_BIDI_CONTROL_CHARS_PATTERN: RegExp =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Mini App API 请求携带 Telegram WebApp `initData` 原始查询串的 HTTP 请求头名（小写）。
 * 不变量：所有 `/api/*` 鉴权统一读取该请求头。所属模块：`packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_INIT_DATA_HEADER: string = "x-telegram-init-data";

/**
 * Mini App 密码认证通过后签发的会话令牌 HTTP 请求头名（小写）。
 * 不变量：除 `/api/auth/precheck` 与 `/api/auth/login` 外，所有业务 `/api/*` 接口均要求携带有效会话令牌。所属模块：`packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_SESSION_HEADER: string = "x-mini-app-session";

/**
 * Mini App 会话令牌自动刷新时下发新到期毫秒时间戳的 HTTP 响应头名（小写）。
 * 不变量：当有效会话距离签发已超过 `MINI_APP_SESSION_REFRESH_THRESHOLD_MS` 时随刷新后的 `X-Mini-App-Session` 一并下发。所属模块：`packages/mini-app-api-server/middleware/sessionToken.ts` 与 `packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_SESSION_EXPIRES_AT_HEADER: string =
  "x-mini-app-session-expires-at";

/**
 * Mini App 访问密码认证会话的有效期毫秒数（45 分钟）。
 * 不变量：到期后必须重新输入密码完成认证。所属模块：`packages/mini-app-api-server/auth/session.ts` 与 `packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_SESSION_TTL_MS: number = 45 * MINUTE_MS;

/**
 * Mini App 会话令牌触发自动刷新与续期的已签发时长阈值毫秒数，同时也是刷新后上一轮旧令牌（`previousToken`）的并发宽限期（5 分钟）。
 * 不变量：正整数毫秒数，小于 `MINI_APP_SESSION_TTL_MS`；携带有效会话令牌访问服务端且距签发时刻超过 5 分钟时自动签发新令牌并顺延有效期，旧令牌在刷新后的 5 分钟内仍可通过核验。所属模块：`packages/mini-app-api-server/auth/session.ts`。
 */
export const MINI_APP_SESSION_REFRESH_THRESHOLD_MS: number = 5 * MINUTE_MS;

/**
 * 超级管理员 ID 连续输错 Mini App 访问密码允许的最大次数（3 次机会）。
 * 不变量：正整数，连续失败达到该次数后立即锁定该超级管理员 ID 30 分钟。所属模块：`packages/mini-app-api-server/auth/session.ts` 与 `packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_PASSWORD_MAX_ATTEMPTS: number = 3;

/**
 * 超级管理员 ID 连续输错 Mini App 访问密码达上限后的禁止访问锁定时长毫秒数（30 分钟）。
 * 不变量：锁定期内该超级管理员 ID 的一切预检、登录与 API 访问一律拒绝。所属模块：`packages/mini-app-api-server/handlers/auth.ts`。
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
 * Telegram WebApp `initData` 原始查询串允许的最大字符长度（4096 字符）。
 * 不变量：正整数上界，超出该长度的异常载荷在进入 `URLSearchParams` 解析与 HMAC 计算前直接按快路径拒绝。所属模块：`packages/libs/miniAppAuth.ts` 与 `packages/mini-app-api-server/middleware/headerGuard.ts`。
 */
export const MINI_APP_MAX_INIT_DATA_LENGTH: number = 4_096;

/**
 * 控制字符（Unicode `Cc` 分类，含 `0x00..0x1F` 与 `0x7F`）的匹配规则。
 * 不变量：不带全局标志 `g`，用于在鉴权快路径拦截含控制字符的畸形凭据头。所属模块：`packages/libs/miniAppAuth.ts` 与 `packages/mini-app-api-server/middleware/headerGuard.ts`。
 */
export const MINI_APP_CONTROL_CHARS_PATTERN: RegExp = /\p{Cc}/u;

/**
 * `Authorization: tma <initData>` 请求头的认证方案前缀（小写含尾空格）。
 * 不变量：与 `X-Telegram-Init-Data` 互为备选传递方式。所属模块：`packages/mini-app-api-server/libs/request.ts` 与 `packages/mini-app-api-server/middleware/headerGuard.ts`。
 */
export const MINI_APP_TMA_AUTH_PREFIX: string = "tma ";

/**
 * Mini App 响应禁止 Cloudflare Tunnel 边缘节点与浏览器缓存的 `Cache-Control` 取值。
 * 不变量：所有动态页面与业务 JSON API 响应均带上此防缓存头。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_NO_STORE_CACHE_CONTROL: string =
  "no-store, no-cache, must-revalidate, max-age=0";

/**
 * Mini App 受保护图库图片与 SVG 资源在通过鉴权后允许 Telegram WebView 客户端与 Cloudflare CDN 边缘节点持久化缓存 7 天的 `Cache-Control` 取值。
 * 不变量：仅用于已通过鉴权中间件核验的 `200 OK` / `304 Not Modified` 图片、SVG 与图标资源响应；未通过鉴权的 `401`/`403` 响应固定使用 `no-store`。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_ASSET_CACHE_CONTROL: string =
  "public, max-age=604800, s-maxage=604800, immutable";

/**
 * 派生 Mini App 受保护静态/图库资源稳定鉴权令牌（`assetToken`）的 HMAC-SHA256 种子字符串。
 * 不变量：由 `BOT_TOKEN` 与 `SUPER_ADMIN_USER_ID` 确定性派生，仅在通过第二层认证（或恢复未过期的 45 分钟解锁会话）后下发，使解锁后重开 Mini App 的图片/SVG URL 保持稳定以命中 WebView 与 CDN 缓存。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_ASSET_TOKEN_SECRET_SEED: string =
  "CopyNinjaMiniAppAssetTokenV1";

/**
 * Mini App 响应的 `Content-Security-Policy` 安全策略头取值。
 * 不变量：仅允许同源脚本、`https://telegram.org` 官方脚本与 `index.html` 内置的首屏 `lang`/`title` 语言初始化脚本哈希，彻底封死外联 XSS 与页面嵌套。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_CSP_HEADER_VALUE: string =
  "default-src 'self'; script-src 'self' https://telegram.org 'sha256-QWTSQdDnyTbsLW0pe3w3OntSBjLiStumg3aS49sZVGo='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * Mini App 响应的 `X-Frame-Options` 安全头取值。
 * 不变量：恒为 `"DENY"`，禁止任何恶意外层页面嵌套（Clickjacking）。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_X_FRAME_OPTIONS_VALUE: string = "DENY";

/**
 * Mini App JSON 写接口允许的最大请求体字节数（32 KiB）。
 * 不变量：用于 JSON 请求体解析边界。所属模块：`packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_MAX_JSON_BODY_BYTES: number = 32_768;

/**
 * Mini App HTTP 服务允许的最大请求体字节数（11 MiB，覆盖 10 MiB 随机图库单图上传上限并提供结构化超限报错余量）。
 * 不变量：大于 `RANDOM_IMAGE_MAX_BYTES`，配置到 `Bun.serve` 的 `maxRequestBodySize`。所属模块：`packages/mini-app-api-server/server/serve.ts`。
 */
export const MINI_APP_MAX_UPLOAD_BODY_BYTES: number = 11 * 1024 * 1024;

/**
 * 图库分页接口缺省每页返回的图片张数（10 张）。
 * 不变量：`1..MINI_APP_GALLERY_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/mini-app-api-server/view/gallery.ts`。
 */
export const MINI_APP_GALLERY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 图库分页接口单页允许的最大图片张数（20 张）。
 * 不变量：等于前端 `packages/mini-app-frontend/consts/miniApp.ts` 中 `MINI_APP_GALLERY_PAGE_SIZE_OPTIONS` 的最大档位，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-api-server/view/gallery.ts`。
 */
export const MINI_APP_GALLERY_MAX_PAGE_SIZE: number = 20;

/**
 * `/api/gallery/file/:fileName` 图库单张图片读取路由的匹配规则。
 * 不变量：不带全局标志 `g`，供受保护资源路径判定无状态复用。所属模块：`packages/mini-app-api-server/server/register.ts`。
 */
export const MINI_APP_GALLERY_FILE_ROUTE_PATTERN: RegExp =
  /^\/api\/gallery\/file\/([^/]+)$/u;

/**
 * `/api/gallery/download/:fileName` 图库单张图片附件下载路由的匹配规则。
 * 不变量：不带全局标志 `g`，供受保护资源路径判定排除附件下载路由无状态复用。所属模块：`packages/mini-app-api-server/server/register.ts`。
 */
export const MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN: RegExp =
  /^\/api\/gallery\/download\/([^/]+)$/u;

/**
 * 受保护图片与矢量图路径后缀的匹配规则（让携带图片后缀的未知路径先经受保护资源鉴权中间件链再返回 404，不含公开 `/favicon.ico`）。
 * 不变量：不带全局标志 `g`，大小写不敏感匹配常见图片与矢量图扩展名。所属模块：`packages/mini-app-api-server/server/register.ts`。
 */
export const MINI_APP_PROTECTED_ASSET_EXT_PATTERN: RegExp =
  /\.(?:svg|png|jpe?g|webp|gif|avif)$/iu;

/**
 * 图库允许通过 HTTP 读取的单张图片安全文件名匹配规则（非点号开头、仅含字母数字与 `._-`、以受支持图片扩展名结尾）。
 * 不变量：不含路径分隔符或空字符，防止目录穿越。所属模块：`packages/mini-app-api-server/view/gallery.ts`。
 */
export const MINI_APP_GALLERY_SAFE_FILE_NAME_PATTERN: RegExp =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp)$/iu;

/**
 * 群热发言记录接口缺省每页返回的条数（10 条）。
 * 不变量：`1..MINI_APP_MESSAGES_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/mini-app-api-server/view/messages.ts`。
 */
export const MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 群热发言记录接口单页允许的最大条数（20 条）。
 * 不变量：等于前端 `packages/mini-app-frontend/consts/miniApp.ts` 中 `MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS` 的最大档位，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-api-server/view/messages.ts`。
 */
export const MINI_APP_MESSAGES_MAX_PAGE_SIZE: number = 20;

/**
 * 白名单与黑名单列表接口缺省每页返回的条数（10 条）。
 * 不变量：`1..MINI_APP_IDENTITY_MAX_PAGE_SIZE` 之间的正整数。所属模块：`packages/mini-app-api-server/view/identities/whitelist.ts` 与 `packages/mini-app-api-server/view/identities/blocklist.ts`。
 */
export const MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE: number = 10;

/**
 * 白名单与黑名单列表接口单页允许的最大条数（20 条）。
 * 不变量：不超过 `IDENTITY_POLICY_SWEEP_PAGE_SIZE`，等于前端 `packages/mini-app-frontend/consts/miniApp.ts` 中 `MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS` 的最大档位，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-api-server/view/identities/whitelist.ts` 与 `packages/mini-app-api-server/view/identities/blocklist.ts`。
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
 * 不变量：正整数上界 24（对应 `DAY_MS`）。所属模块：`packages/mini-app-api-server/handlers/chats.ts`。
 */
export const MINI_APP_BATCH_KICK_MAX_HOURS: number = 24;

/**
 * Mini App 群内追着翻目标支持的目标语言闭集。
 * 不变量：与 `MiniAppTranslateLanguage` 联合类型及 `SUPPORTED_TRANSLATE_LANGUAGES` 一一对应。所属模块：`packages/mini-app-api-server/handlers/chats.ts`。
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
