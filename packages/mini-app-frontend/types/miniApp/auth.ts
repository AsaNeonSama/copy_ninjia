/**
 * Mini App 前端鉴权、预检诊断与临时 X25519 ECDH 登录握手类型。
 * 与服务端 `packages/types/miniApp/auth.ts` 同名的声明是 HTTP 接口契约副本，
 * 由 `test/mini-app-frontend/frontendParity.test.ts` 逐项核对编译期恒等；其余声明仅属于前端。
 */

import type { MiniAppEncryptedPayload } from "../miniAppConfigs";
import type { MiniAppAuthMode } from "../miniAppTotp";

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

/** `GET /api/auth/precheck` 在尚未建立活跃会话时动态下发并经源站 Ed25519 签名的临时 X25519 握手公钥凭据。 */
export interface MiniAppAuthHandshakeOffer {
  /** 32 位小写十六进制临时握手标识。 */
  readonly handshakeId: string;
  /** 标准 Base64 编码的 32 字节服务端临时 X25519 公钥。 */
  readonly serverPublicKey: string;
  /** 该临时公钥未消费时的过期毫秒时间戳。 */
  readonly expiresAt: number;
  /** 源站本次启动内存 Ed25519 私钥对规范抄本签出的 64 字节标准 Base64 签名。 */
  readonly signature: string;
}

/** `POST /api/auth/login` 使用客户端临时 X25519 ECDH + HKDF 派生密钥加密提交登录凭据的请求体。 */
export interface MiniAppEncryptedLoginRequest {
  /** 首屏预检签发的 32 位十六进制临时握手标识（用完即焚）。 */
  readonly handshakeId: string;
  /** 客户端为本次登录生成的 32 字节临时 X25519 公钥（标准 Base64 编码）。 */
  readonly clientPublicKey: string;
  /** 由 c2s AES-256-GCM 密钥加密的登录凭据载荷（明文为 `{ handshakeId, password }` 或 `{ handshakeId, totpCode }`，AAD 绑定 `"POST /api/auth/login:request"`）。 */
  readonly encryptedPayload: Readonly<MiniAppEncryptedPayload>;
}

/** `POST /api/auth/login` 通过密码或 TOTP 二次认证后签发 45 分钟会话令牌与 256-bit AES PSK 的加密响应明文载荷。 */
export interface MiniAppLoginSuccessResponse {
  readonly ok: true;
  /** 签发的 64 位十六进制会话令牌。 */
  readonly sessionToken: string;
  /** 签发的 256-bit（64 位小写十六进制）会话临时加密密钥（仅在登录协商与滑动续期时加密下发）。 */
  readonly sessionKey: string;
  readonly expiresAt: number;
  /** 会话总有效时长毫秒数（`MINI_APP_SESSION_TTL_MS`）。 */
  readonly ttlMs: number;
}

/** `GET /api/auth/precheck` 首屏认证与会话预检响应（未解锁时附带已签名的临时 X25519 握手公钥）。 */
export interface MiniAppAuthPrecheckResponse {
  /** 预检是否通过。 */
  readonly ok: true;
  /** 会话总有效时长毫秒数（`MINI_APP_SESSION_TTL_MS`）。 */
  readonly ttlMs: number;
  /** 当前是否已配置并启用谷歌验证器（TOTP）。 */
  readonly totpEnabled: boolean;
  /** 当前登录门禁优先使用的认证方式（`"totp"` 或 `"password"`）。 */
  readonly authMode: MiniAppAuthMode;
  /** 客户端持久化的会话令牌在服务端是否仍在有效期内。 */
  readonly sessionValid?: boolean;
  /** 客户端持久化会话的服务端到期毫秒时间戳。 */
  readonly sessionExpiresAt?: number;
  /** 预检响应可选回传的会话令牌字段（首屏只读核验默认省略，不轮换密钥）。 */
  readonly sessionToken?: string;
  /** 尚未解锁活跃会话时立即签发的临时 X25519 ECDH 握手公钥与 Ed25519 签名（用完即焚）。 */
  readonly handshake?: Readonly<MiniAppAuthHandshakeOffer>;
}

/** `GET /api/auth/precheck` 首屏签名预检结果。 */
export type MiniAppPrecheckResult =
  | {
    readonly ok: true;
    readonly ttlMs: number;
    /** 当前是否已配置并启用谷歌验证器（TOTP）。 */
    readonly totpEnabled?: boolean;
    /** 当前登录门禁优先使用的认证方式（有验证器时为 `"totp"`，否则为 `"password"`）。 */
    readonly authMode?: MiniAppAuthMode;
    /** 客户端持久化的会话令牌在服务端是否仍在 45 分钟有效期内。 */
    readonly sessionValid?: boolean;
    /** 客户端持久化会话的到期时刻，已按响应 `Date` 头换算为本机时钟毫秒时间戳（无效或未携带时为 `0`）。 */
    readonly sessionExpiresAt?: number;
  }
  | {
    readonly ok: false;
    readonly diagnostics: Readonly<MiniAppAccessDiagnostics>;
  };
