import type { MiniAppAuthPolicy } from "../../types/miniApp/server";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../time";

/**
 * Telegram WebApp `initData` HMAC-SHA256 派生密钥的固定种子字符串。
 * 不变量：遵循 Telegram Mini Apps 官方验签规范，恒为 `"WebAppData"`。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_WEB_APP_DATA_SECRET_SEED: string = "WebAppData";

/**
 * Telegram WebApp `initData` 中 `auth_date` 允许的最大有效秒数（与二次认证会话窗口对齐）。
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
 * 不变量：不带全局标志 `g`，供 `verifyMiniAppInitData` 及会话令牌格式核验无状态复用。
 * 所属模块：`packages/libs/miniAppAuth.ts`、`packages/mini-app-api-server/auth/sessionLookup.ts`、
 * `packages/mini-app-api-server/auth/sessionLifecycle.ts` 与 `packages/mini-app-api-server/middleware/sessionToken.ts`。
 */
export const MINI_APP_SHA256_HEX_PATTERN: Readonly<RegExp> = /^[0-9a-f]{64}$/i;

/**
 * Mini App API 请求携带 Telegram WebApp `initData` 原始查询串的 HTTP 请求头名（小写）。
 * 不变量：所有 `/api/*` 鉴权统一读取该请求头。
 * 所属模块：`packages/mini-app-api-server/middleware/headerGuard.ts` 与 `packages/mini-app-api-server/middleware/initData.ts`。
 */
export const MINI_APP_INIT_DATA_HEADER: string = "x-telegram-init-data";

/**
 * Mini App 二次认证（访问密码或 6 位 TOTP 动态码）通过并完成临时密钥协商后签发的会话令牌 HTTP 请求头名（小写）。
 * 不变量：除 `/api/auth/precheck`、`/api/auth/login`、`/api/auth/logout` 与受路径白名单豁免的公共资源接口外，
 * 业务 `/api/*` 接口均要求携带有效会话令牌。
 * 所属模块：`packages/mini-app-api-server/libs/request.ts` 与 `packages/mini-app-api-server/auth/sessionLifecycle.ts`。
 */
export const MINI_APP_SESSION_HEADER: string = "x-mini-app-session";

/**
 * Mini App 会话滑动续期时下发新到期毫秒时间戳的 HTTP 响应头名（小写）。
 * 不变量：加密业务响应达到本代 `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]` 随机轮换阈值或 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` IV 水位时，随轮换后的 `X-Mini-App-Session` 与 `X-Mini-App-Session-Key` 同步下发。
 * 所属模块：`packages/mini-app-api-server/auth/sessionLifecycle.ts`。
 */
export const MINI_APP_SESSION_EXPIRES_AT_HEADER: string =
  "x-mini-app-session-expires-at";

/**
 * Mini App 二次认证会话的有效期毫秒数。
 * 不变量：到期后必须重新完成二次认证（6 位 TOTP 动态码或访问密码）。
 * 所属模块：`packages/mini-app-api-server/auth/sessionLifecycle.ts`、`packages/mini-app-api-server/auth/sessionCommit.ts` 与 `packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_SESSION_TTL_MS: number = 45 * MINUTE_MS;

/**
 * Mini App 单次登录签发会话允许滑动续期的绝对最长存活时长（2 小时）。
 * 不变量：无论滑动续期发生多少次，会话自初次登录签发起超过该时长后一律失效，必须重新完成二次认证。
 * 所属模块：`packages/mini-app-api-server/auth/sessionLifecycle.ts`。
 */
export const MINI_APP_SESSION_MAX_LIFETIME_MS: number = 2 * HOUR_MS;

/**
 * Mini App 加密业务路由触发会话令牌与 256-bit 临时密钥滑动轮换的最短间隔毫秒数（5 秒）。
 * 不变量：正整数毫秒数且不大于 `MINI_APP_SESSION_REFRESH_MAX_MS`；每代密钥在 `[MIN, MAX]` 闭区间内均匀随机抽取下一次触发轮换时间点。
 * 所属模块：`packages/mini-app-api-server/auth/sessionLifecycle.ts`。
 */
export const MINI_APP_SESSION_REFRESH_MIN_MS: number = 5 * SECOND_MS;

/**
 * Mini App 加密业务路由触发会话令牌与 256-bit 临时密钥滑动轮换的最长间隔毫秒数（5 分钟）。
 * 不变量：正整数毫秒数且不小于 `MINI_APP_SESSION_REFRESH_MIN_MS`、小于 `MINI_APP_SESSION_TTL_MS`。
 * 所属模块：`packages/mini-app-api-server/auth/sessionLifecycle.ts`。
 */
export const MINI_APP_SESSION_REFRESH_MAX_MS: number = 5 * MINUTE_MS;

/**
 * Mini App 会话令牌与 256-bit 密钥轮换后上一轮旧凭据（`previousToken` / `previousCryptoKey`）的最长并发在途宽限期毫秒数（5 分钟）。
 * 不变量：独立于 `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]` 随机轮换阈值，且客户端首次携带新令牌成功提交请求时立即作废。
 * 所属模块：`packages/mini-app-api-server/auth/sessionLookup.ts`。
 */
export const MINI_APP_SESSION_PREVIOUS_GRACE_MS: number = 5 * MINUTE_MS;

/**
 * 超级管理员 ID 连续输错 Mini App 访问密码或动态口令允许的最大次数。
 * 不变量：正整数，连续失败达到该次数后立即按 `MINI_APP_PASSWORD_LOCKOUT_MS` 锁定该超级管理员 ID。
 * 所属模块：`packages/mini-app-api-server/handlers/auth.ts` 与 `packages/mini-app-api-server/auth/totpStorage.ts`。
 */
export const MINI_APP_PASSWORD_MAX_ATTEMPTS: number = 3;

/**
 * 超级管理员 ID 连续输错 Mini App 二次认证凭据（访问密码或动态口令）达上限后的禁止访问锁定时长毫秒数。
 * 不变量：锁定期内该超级管理员 ID 的一切预检、登录与 API 访问一律拒绝。所属模块：`packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_PASSWORD_LOCKOUT_MS: number = 30 * MINUTE_MS;

/**
 * 主线程同时缓存的未过期 Mini App 会话与 256-bit 临时密钥数量硬上限（最多 5 个客户端会话）。
 * 不变量：达到上限且均未过期时，新登录照常签发并淘汰签发或最近一次轮换距今最久的会话。
 * 所属模块：`packages/cache/main/miniApp.ts`、`packages/mini-app-api-server/auth/sessionLifecycle.ts` 与 `packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_SESSION_MAX: number = 5;

/**
 * `config/static/bot.json` 中 `mini_app.password` 禁止使用的示例占位字符串。
 * 不变量：配置解析时命中该占位符直接按致命错误拒绝。所属模块：`packages/config/botInput.ts` 与 `scripts/install/runtime.ts`。
 */
export const MINI_APP_PASSWORD_PLACEHOLDER: string = "replace-with-mini-app-password";

/**
 * `mini_app.password` 必须包含至少 6 位阿拉伯数字（`0-9`）的匹配规则。
 * 不变量：不带全局标志 `g`，供配置解析器无状态复用。所属模块：`packages/config/botInput.ts`。
 */
export const MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN: Readonly<RegExp> =
  /^(?:\D*\d){6}/u;

/**
 * Telegram WebApp `initData` 原始查询串允许的最大字符长度（4096 字符）。
 * 不变量：正整数上界，超出该长度的载荷在进入 `URLSearchParams` 解析与 HMAC 计算前直接按快路径拒绝。
 * 所属模块：`packages/libs/miniAppAuth.ts` 与 `packages/mini-app-api-server/middleware/headerGuard.ts`。
 */
export const MINI_APP_MAX_INIT_DATA_LENGTH: number = 4_096;

/**
 * 控制字符（Unicode `Cc` 分类，含 `0x00..0x1F` 与 `0x7F`）的匹配规则。
 * 不变量：不带全局标志 `g`，用于在鉴权快路径拦截含控制字符的畸形凭据头。
 * 所属模块：`packages/libs/miniAppAuth.ts` 与 `packages/mini-app-api-server/middleware/headerGuard.ts`。
 */
export const MINI_APP_CONTROL_CHARS_PATTERN: Readonly<RegExp> = /\p{Cc}/u;

/**
 * `Authorization: tma <initData>` 请求头的认证方案前缀（小写含尾空格）。
 * 不变量：与 `X-Telegram-Init-Data` 互为备选传递方式。所属模块：`packages/mini-app-api-server/middleware/headerGuard.ts`。
 */
export const MINI_APP_TMA_AUTH_PREFIX: string = "tma ";

/**
 * Mini App 单页入口通过超级管理员门禁校验后签发的 `HttpOnly` 门禁 Cookie 名称。
 * 不变量：仅携带合法超级管理员 `initData` 预检或登录成功后通过 `Set-Cookie` 下发，锁定或校验失败时清除。
 * 所属模块：`packages/mini-app-api-server/auth/pageGate.ts`。
 */
export const MINI_APP_PAGE_GATE_COOKIE_NAME: string = "copy_ninja_mini_app_gate";

/**
 * 派生 Mini App 单页门禁令牌（`<issuedAtMs>.<hmacHex>`）HMAC-SHA256 签名密钥的域分离种子字符串。
 * 不变量：恒为 `"CopyNinjaMiniAppPageGateV1"`，与 `WebAppData` 派生密钥严格域分离。
 * 所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_PAGE_GATE_SECRET_SEED: string =
  "CopyNinjaMiniAppPageGateV1";

/**
 * Mini App 单页门禁令牌（`<issuedAtMs>.<hmacHex>`）计算 HMAC-SHA256 时的消息前缀。
 * 不变量：恒为 `"mini-app-page-gate:"`，后接 `${SUPER_ADMIN_USER_ID}:${issuedAtMs}`，
 * 以 `deriveMiniAppPageGateSecretKey(BOT_TOKEN)` 派生的密钥签名。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_PAGE_GATE_PAYLOAD_PREFIX: string = "mini-app-page-gate:";

/**
 * Mini App 单页门禁令牌校验签发时间戳时允许的未来时钟偏移容差毫秒数（60 秒）。
 * 不变量：非负整数毫秒数，签发时间超出当前时刻加该容差时拒绝通过。所属模块：`packages/libs/miniAppAuth.ts`。
 */
export const MINI_APP_PAGE_GATE_CLOCK_SKEW_MS: number = MINUTE_MS;

/**
 * Mini App 单页门禁 Cookie 的 `Max-Age` 有效期秒数（与 `MINI_APP_SESSION_TTL_MS` 对齐）。
 * 不变量：正整数秒数，清除门禁 Cookie 时固定改发 `Max-Age=0`。所属模块：`packages/mini-app-api-server/auth/pageGate.ts`。
 */
export const MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS: number = 2_700;

/**
 * 首屏预检与临时公钥下发、ECDH 加密登录以及登出路由的鉴权策略配置（仅校验请求头快路径、Telegram WebApp 签名、超管 ID 与登录失败锁定，不要求既有二次认证会话）。
 * 不变量：供 `packages/mini-app-api-server/routes/auth.ts` 声明路由策略，登出路径不因先验会话自动续期。
 * 所属模块：`packages/mini-app-api-server/middleware/pipeline.ts`。
 */
export const MINI_APP_INIT_DATA_AUTH_POLICY: Readonly<MiniAppAuthPolicy> = {
  requireSession: false,
  encryptRequest: false,
  encryptResponse: false,
};

/**
 * 未命中路由表的受保护非 API 图片后缀路径兜底鉴权策略配置：
 * - 请求头快路径拦截跨站与直接导航；
 * - 强制要求超级管理员 `initData` 与有效的二次认证会话（不接受 URL 查询参数凭据，不加密响应）。
 * 不变量：仅用于 `packages/mini-app-api-server/server/register.ts` 对未知非 `/api/` 图片后缀路径的兜底拦截（图库读取路由已改用 `MINI_APP_GALLERY_FILE_AUTH_POLICY`）。
 * 所属模块：`packages/mini-app-api-server/middleware/pipeline.ts`。
 */
export const MINI_APP_PROTECTED_ASSET_AUTH_POLICY: Readonly<MiniAppAuthPolicy> = {
  requireSession: true,
  encryptRequest: false,
  encryptResponse: false,
};

/**
 * 业务 JSON 与写操作 API 的完整双层鉴权与 AES-256-GCM 传输加密策略配置（请求头快路径 + Telegram WebApp 超管签名 + 二次认证会话 + 请求/响应体加密）。
 * 不变量：不接受 URL 查询参数凭据；供各 API 路由表与 `packages/mini-app-api-server/server/register.ts` 使用。
 * 所属模块：`packages/mini-app-api-server/middleware/pipeline.ts`。
 */
export const MINI_APP_API_AUTH_POLICY: Readonly<MiniAppAuthPolicy> = {
  requireSession: true,
  encryptRequest: true,
  encryptResponse: true,
};

/**
 * 图库原图附件下载路由（`GET|HEAD /api/gallery/download`）的双轨鉴权与加密查询策略配置：
 * - 浏览器降级路径：请求头快路径 + Telegram WebApp 超管签名 + 二次认证会话 + `?e=` AES-256-GCM 加密查询参数；
 * - Telegram 原生 `WebApp.downloadFile` 路径：由加密 `POST /api/gallery/download-ticket` 签发 60 秒单次一次性 `?ticket=` 票据并在 `routes/gallery.ts` 中旁路校验；
 * - 二进制附件流响应体不加密，不轮换会话密钥。
 * 不变量：仅允许 `?e=` 或独立 `?ticket=`，拒绝 `?token=`/`?initData=`/`?session=` 等查询凭据；供 `packages/mini-app-api-server/routes/gallery.ts` 使用。
 * 所属模块：`packages/mini-app-api-server/middleware/pipeline.ts`。
 */
export const MINI_APP_GALLERY_DOWNLOAD_AUTH_POLICY: Readonly<MiniAppAuthPolicy> = {
  requireSession: true,
  encryptRequest: true,
  encryptResponse: false,
};
