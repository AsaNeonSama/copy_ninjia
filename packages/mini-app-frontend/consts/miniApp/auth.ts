/**
 * Mini App 前端认证请求头、会话存储键、签名公钥防环刷新窗与鉴权错误分类常量。
 * 与服务端重合的常量取值保持一致（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。
 */

import {
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../miniAppCrypto";
import { MINUTE_MS } from "../time";

/** 十六进制 SHA-256 摘要字符串（固定 64 位十六进制字符）的匹配规则。不变量：不带全局标志 `g`，供持久化会话令牌格式校验无状态复用；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/credentials.ts`、`packages/mini-app-frontend/api/authPrecheck.ts` 与 `packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_SHA256_HEX_PATTERN: Readonly<RegExp> = /^[0-9a-f]{64}$/i;

/** 十进制有符号整数文本（可带前导 `-`，仅含数字）的匹配规则。不变量：不带全局标志 `g`，拒绝 `0x1F`、`1e3`、小数等会被 `Number()` 宽松接受的写法；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/identitiesMutations.ts` 与 `packages/mini-app-frontend/store/chatTargetsMutations.ts`。 */
export const MINI_APP_SIGNED_INTEGER_PATTERN: Readonly<RegExp> = /^-?\d+$/u;

/** Unicode 双向文本控制字符（LRM/RLM/ALM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI）的匹配规则，供昵称与用户名展示前剥离双向控制符。不变量：携带全局标志 `g`；取值与 `packages/consts/text.ts` 的 `BIDI_CONTROL_PATTERN` 一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。 */
export const MINI_APP_BIDI_CONTROL_CHARS_PATTERN: Readonly<RegExp> =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Unicode 双向文本控制字符的非全局前置检测规则，与 `MINI_APP_BIDI_CONTROL_CHARS_PATTERN` 字符类完全一致。不变量：不带 `g`/`y` 标志，`test()` 不受 `lastIndex` 影响也不改写它，可无状态复用；取值与 `packages/consts/text.ts` 的 `BIDI_CONTROL_TEST_PATTERN` 一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。 */
export const MINI_APP_BIDI_CONTROL_CHARS_TEST_PATTERN: Readonly<RegExp> =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/** Mini App API 请求携带 Telegram WebApp `initData` 原始查询串的 HTTP 请求头名（小写）。不变量：所有 `/api/*` 鉴权统一读取该请求头；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_INIT_DATA_HEADER: string = "x-telegram-init-data";

/** Mini App 二次认证（密码或 TOTP 动态码）通过并完成临时密钥协商后签发的会话令牌 HTTP 请求头名（小写）。不变量：除 `/api/auth/precheck`、`/api/auth/login` 与 `/api/auth/logout` 外，所有业务 `/api/*` 接口均要求携带有效会话令牌；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts` 与 `packages/mini-app-frontend/api/authLogout.ts`。 */
export const MINI_APP_SESSION_HEADER: string = "x-mini-app-session";

/** Mini App 会话令牌自动刷新时下发新到期毫秒时间戳的 HTTP 响应头名（小写）。不变量：取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_SESSION_EXPIRES_AT_HEADER: string =
  "x-mini-app-session-expires-at";

/** Mini App 二次认证会话的有效期毫秒数（45 分钟）。不变量：到期后必须重新提交登录凭据（密码或 TOTP 动态码）完成认证；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/credentials.ts`、`packages/mini-app-frontend/api/authPrecheck.ts` 与 `packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_SESSION_TTL_MS: number = 45 * MINUTE_MS;

/** Mini App 在浏览器 `sessionStorage` 中持久化 45 分钟认证会话令牌与到期时间的存储键名（256-bit 不可导出 `CryptoKey` 另存于 IndexedDB，禁止在 Web Storage 中存放明文密钥）。不变量：仅持久化 `{ token, expiresAt }`，过期或主动锁定时连同 IndexedDB 密钥句柄一并清除。所属模块：`packages/mini-app-frontend/libs/credentials.ts`。 */
export const MINI_APP_SESSION_STORAGE_KEY: string =
  "copy_ninja_mini_app_session_v1";

/** Mini App 检测到服务端内存签名公钥轮换（`signature_mismatch`）后触发防死循环整页刷新的 `sessionStorage` 时间戳键名。不变量：仅记录最近一次自动刷新毫秒时间戳，成功完成 `precheckMiniAppAccess` 后清除。所属模块：`packages/mini-app-frontend/api/authPrecheck.ts`。 */
export const MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY: string =
  "copy_ninja_mini_app_signing_key_reload_v1";

/** Mini App 签名公钥失配触发自动整页刷新的最小冷却时间窗口（10 秒 = `10_000` 毫秒），防止代理缓存旧脚本或时钟异常时无限循环刷新。不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/api/authPrecheck.ts`。 */
export const MINI_APP_SIGNING_KEY_RELOAD_WINDOW_MS: number = 10_000;

/** Mini App 持久化不可导出会话 `CryptoKey` 句柄使用的 IndexedDB 数据库名称。不变量：仅存放 `{ token, cryptoKey }` 配对记录（`cryptoKey` 为不可导出 AES-256-GCM `CryptoKey`，不支持或清理时回退纯内存闭包态）。所属模块：`packages/mini-app-frontend/libs/sessionKeyStorage.ts`。 */
export const MINI_APP_SESSION_KEY_IDB_NAME: string =
  "copy_ninja_mini_app_auth_v1";

/** Mini App 持久化不可导出会话 `CryptoKey` 的 IndexedDB 对象存储仓库名。不变量：固定非空标识符。所属模块：`packages/mini-app-frontend/libs/sessionKeyStorage.ts`。 */
export const MINI_APP_SESSION_KEY_IDB_STORE: string = "session_keys";

/** Mini App 当前活跃会话 `{ token, cryptoKey }` 配对记录在 IndexedDB 中对应的固定记录键名。不变量：固定单一主键，锁定、过期或重写时原位覆盖/删除。所属模块：`packages/mini-app-frontend/libs/sessionKeyStorage.ts`。 */
export const MINI_APP_SESSION_KEY_IDB_RECORD_KEY: string = "active_session_key";

/** `Authorization: tma <initData>` 请求头的认证方案前缀（小写含尾空格）。不变量：与 `X-Telegram-Init-Data` 互为备选传递方式；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_TMA_AUTH_PREFIX: string = "tma ";

/**
 * 触发退回二次认证门禁（`gateState = "password"`）的会话过期、凭据失效与会话密钥吊销/失步错误代码集合。
 * 不变量：仅包含必须重新解锁会话才能恢复的错误码，绝不包含 `INVALID_PASSWORD`、`INVALID_TOTP_CODE`、`TOTP_SETUP_EXPIRED` 等业务校验错误码。
 * 所属模块：`packages/mini-app-frontend/api/authError.ts` 与 `packages/mini-app-frontend/store/appGateActions.ts`。
 */
export const MINI_APP_SESSION_REAUTH_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "PASSWORD_REQUIRED",
  "SESSION_EXPIRED",
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_INVALID_HANDSHAKE_CODE,
]);

/**
 * Telegram WebApp `initData.auth_date` 过期拒绝状态码。
 * 不变量：非空大写下划线状态码；配合活跃会话 2 小时 45 分钟延展窗口，仅当发包令牌仍为当前活跃会话或无发包令牌上下文时触发清理与门禁重定向。
 * 所属模块：`packages/mini-app-frontend/api/authError.ts`。
 */
export const MINI_APP_EXPIRED_AUTH_DATE_CODE: string = "EXPIRED_AUTH_DATE";

/**
 * 触发清除本地会话并回到 `checking` 重新预检（进入拦截诊断页 `AccessDeniedPage`）的一层网关、`initData` 时效、密码锁定与 WebCrypto 不可用错误代码集合。
 * 不变量：集合内任意状态码均表示无法仅靠在当前页面重新输入密码恢复，必须交由重新预检裁决或拒绝访问；其中 `MINI_APP_EXPIRED_AUTH_DATE_CODE` 依赖活跃会话延展窗口，由 `authError.ts` 按发包令牌一致性单独保护。
 * 所属模块：`packages/mini-app-frontend/api/authError.ts` 与 `packages/mini-app-frontend/store/appGateActions.ts`。
 */
export const MINI_APP_ACCESS_DENIED_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "PASSWORD_LOCKED",
  MINI_APP_EXPIRED_AUTH_DATE_CODE,
  "MISSING_INIT_DATA",
  "MALFORMED_INIT_DATA",
  "MISSING_HASH",
  "MISSING_USER",
  "INVALID_SIGNATURE",
  "FORBIDDEN_USER",
  "CROSS_SITE_FORBIDDEN",
  "DIRECT_NAVIGATION_FORBIDDEN",
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
]);

/** 匹配错误消息开头 `[CODE] 正文` 前缀形态的正则。不变量：不带全局标志 `g`，捕获组 1 为状态码、捕获组 2 为剥离前缀后的正文。所属模块：`packages/mini-app-frontend/api/authError.ts`。 */
export const MINI_APP_LEADING_AUTH_PREFIX_PATTERN: Readonly<RegExp> = /^\[([A-Z0-9_]+)\]\s*(.*)$/su;

/** 匹配错误消息任意位置 `[CODE]` 标记的正则。不变量：携带全局标志 `g`，仅配合 `String.prototype.matchAll` 无状态迭代使用。所属模块：`packages/mini-app-frontend/api/authError.ts`。 */
export const MINI_APP_EMBEDDED_AUTH_PREFIX_PATTERN: Readonly<RegExp> = /\[([A-Z0-9_]+)\]/gu;
