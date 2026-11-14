import type { MiniAppAuthMode } from "../miniAppTotp";

/** Telegram WebApp `initData` 中解析出的用户身份摘要。 */
export interface MiniAppInitDataUser {
  readonly id: number;
  readonly firstName: string;
  readonly lastName?: string;
  /** 公开用户名（不含 `@`）。 */
  readonly username?: string;
}

/** `initData` 验签失败的原因分类。 */
type MiniAppAuthFailureReason =
  | "missing_init_data" | "malformed_init_data" | "invalid_signature"
  | "expired_auth_date" | "missing_user" | "forbidden_user";

/** `initData` 验签与超级管理员身份核验结果。 */
export type MiniAppAuthResult =
  | { readonly ok: true; readonly authDate: number; readonly user: Readonly<MiniAppInitDataUser> }
  | { readonly ok: false; readonly reason: MiniAppAuthFailureReason };

/** 主线程内存中保存的 Mini App 密码认证会话记录（有效期 45 分钟）。 */
export interface MiniAppAuthSession {
  /** 64 位十六进制随机会话令牌。 */
  readonly token: string;
  /** 最近一次刷新前的旧会话令牌（距 `createdAt` 5 分钟宽限期内有效；新签发时为 `undefined`）。 */
  readonly previousToken: string | undefined;
  readonly createdAt: number;
  /** 会话过期毫秒时间戳（`createdAt + MINI_APP_SESSION_TTL_MS`）。 */
  readonly expiresAt: number;
}

/** 超级管理员 ID 的 Mini App 密码连续错误计数与 30 分钟锁定状态。 */
export interface MiniAppPasswordGuardState {
  readonly userId: number;
  /** 当前连续输错次数；达到 `MINI_APP_PASSWORD_MAX_ATTEMPTS` 时锁定，锁定期内顺延的并发登录继续累加。 */
  readonly failedAttempts: number;
  /** 锁定截止毫秒时间戳（未锁定时为 `0`）。 */
  readonly lockedUntil: number;
}

/** 服务端返回的真实请求上下文与拒绝诊断信息（用于 403 访问拒绝页与鉴权诊断）。 */
export interface MiniAppAccessDiagnostics {
  /** 服务端为本次 HTTP 请求生成的 16 位十六进制请求追踪 ID（与 `X-Request-Id` 响应头一致）。 */
  readonly requestId: string;
  /** 服务端处理本次请求时的真实 UTC 时间字符串（`YYYY-MM-DD HH:mm:ss UTC`）。 */
  readonly timestamp: string;
  readonly clientIp: string;
  readonly host: string;
  readonly path: string;
  readonly status: number;
  readonly code: string;
  readonly error: string;
  /** 凭据校验失败时剩余的可尝试次数（仅 `INVALID_PASSWORD` / `INVALID_TOTP_CODE` 携带）。 */
  readonly remainingAttempts?: number;
  /** 处于 30 分钟锁定期时剩余的锁定分钟数（仅 `PASSWORD_LOCKED` 携带）。 */
  readonly remainingMinutes?: number;
}

/** `POST /api/auth/login` 密码或 TOTP 认证成功响应。 */
export interface MiniAppLoginSuccessResponse {
  readonly ok: true;
  /** 签发的 64 位十六进制会话令牌。 */
  readonly sessionToken: string;
  readonly expiresAt: number;
  /** 会话总有效时长毫秒数（45 分钟 = 2,700,000 ms）。 */
  readonly ttlMs: number;
  /** 供受保护图片与 SVG 资源跨会话稳定缓存复用的确定性鉴权令牌。 */
  readonly assetToken?: string;
}

/** `GET /api/auth/precheck` 首屏认证与会话预检响应。 */
export interface MiniAppAuthPrecheckResponse {
  /** 预检是否通过。 */
  readonly ok: true;
  /** 会话总有效时长毫秒数（45 分钟 = 2,700,000 ms）。 */
  readonly ttlMs: number;
  /** 当前是否已配置并启用谷歌验证器（TOTP）。 */
  readonly totpEnabled: boolean;
  /** 当前登录门禁优先使用的认证方式（`"totp"` 或 `"password"`）。 */
  readonly authMode: MiniAppAuthMode;
  /** 客户端持久化的会话令牌在服务端是否仍在有效期内。 */
  readonly sessionValid?: boolean;
  /** 客户端持久化会话的服务端到期毫秒时间戳。 */
  readonly sessionExpiresAt?: number;
  /** 触发 5 分钟滑动续期时服务端签发的新会话令牌。 */
  readonly sessionToken?: string;
  /** 供受保护图片与 SVG 资源跨会话稳定缓存复用的确定性鉴权令牌。 */
  readonly assetToken?: string;
}
