import type { MiniAppAuthMode } from "../miniAppTotp";
import type { MiniAppEncryptedPayload } from "./configs";

/** Telegram WebApp `initData` 中解析出的用户身份摘要（固定四字段形状，缺省可选字段显式置为 `undefined`）。 */
export interface MiniAppInitDataUser {
  readonly id: number;
  readonly firstName: string;
  readonly lastName: string | undefined;
  /** 公开用户名（不含 `@`）；未提供时为 `undefined`。 */
  readonly username: string | undefined;
}

/** `initData` 验签失败的原因分类。 */
type MiniAppAuthFailureReason =
  | "missing_init_data" | "malformed_init_data" | "invalid_signature"
  | "expired_auth_date" | "missing_user" | "forbidden_user";

/** `initData` 验签与超级管理员身份核验结果。 */
export type MiniAppAuthResult =
  | { readonly ok: true; readonly authDate: number; readonly user: Readonly<MiniAppInitDataUser> }
  | { readonly ok: false; readonly reason: MiniAppAuthFailureReason };

/** 主线程内存中保存的 Mini App 二次认证（访问密码或 6 位 TOTP 动态码）会话与 256-bit 临时密钥记录（有效期见 `MINI_APP_SESSION_TTL_MS`）。 */
export interface MiniAppAuthSession {
  /** 同一次登录签发的会话在历次滑动轮换间保持不变的 32 位十六进制内部谱系标识（不下发客户端）；用于解密窗口内令牌被轮换确认后的在途提交、TOTP 变更时保留调用者会话、图库下载票据绑定以及按谱系吊销会话。 */
  readonly lineageId: string;
  /** 64 位十六进制随机会话令牌。 */
  readonly token: string;
  /** 最近一次滑动续期前的旧会话令牌（仅在并发在途宽限期内且新令牌尚未被客户端确认使用前有效；新签发或确认替换后立即置为 `undefined`）。 */
  readonly previousToken: string | undefined;
  /** 登录响应序列化前短暂持有的 256-bit（64 位小写十六进制）密钥明文；响应序列化完成后立即清除为 `undefined`。 */
  readonly pendingSessionKey: string | undefined;
  /** 本代密钥经上一代密钥 AES-256-GCM 封装（AAD 绑定本代 `token`）的 `<ivBase64>.<cipherBase64>` 密文（不含明文）；与 `previousToken` 同步保留及作废，供携带 `previousToken` 的加密响应路由请求重新附带轮换响应头。 */
  readonly sealedSessionKey: string | undefined;
  /** 轮换提交时同步启动的共享密文封装 `Promise`（仅解析为 `<ivBase64>.<cipherBase64>` 密文，不长驻明文密钥）；在密文写入 `sealedSessionKey` 后、新令牌确认或宽限期满时清除为 `undefined`，供封装完成前命中 `previousToken` 的并发请求等待同一密文结果。 */
  readonly sealedSessionKeyPromise?: Promise<string>;
  /** 当前生效会话临时密钥预先导入的 `AES-GCM` `CryptoKey` Promise 句柄。 */
  readonly cryptoKey: Promise<CryptoKey>;
  /** 当前密钥纪元内已受理请求使用过的 12 字节 IV（Base64）去重集合（防同一密钥下请求信封重放，新密钥纪元重置）。 */
  readonly seenRequestIvs: Set<string>;
  /** 最近一次滑动续期前的旧 `AES-GCM` `CryptoKey` Promise 句柄（与 `previousToken` 同步保留及作废）。 */
  readonly previousCryptoKey: Promise<CryptoKey> | undefined;
  /** 并发在途宽限期内旧密钥纪元已受理请求的 IV 去重集合（与 `previousToken` 同步保留及作废）。 */
  readonly previousSeenRequestIvs: Set<string> | undefined;
  /** 本次登录会话首次签发的毫秒时间戳（用于限制滑动续期绝对总生命周期 `MINI_APP_SESSION_MAX_LIFETIME_MS`）。 */
  readonly issuedAt: number;
  /** 最近一次签发或滑动续期的时间戳（用于计算上一轮旧凭据的 `MINI_APP_SESSION_PREVIOUS_GRACE_MS` 并发在途宽限期）。 */
  readonly createdAt: number;
  /** 本代临时密钥按时间触发下一次滑动续期与密钥轮换的最早毫秒时间戳（在 `[createdAt + MINI_APP_SESSION_REFRESH_MIN_MS, createdAt + MINI_APP_SESSION_REFRESH_MAX_MS]` 闭区间内均匀随机生成；若 `seenRequestIvs.size` 先达到 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` 水位，也会提前触发轮换并在新纪元重新采样该间隔）。 */
  readonly nextRefreshAt: number;
  /** 当前滑动窗口过期毫秒时间戳（不超过 `absoluteExpiresAt`）。 */
  readonly expiresAt: number;
  /** 本次登录会话滑动续期的绝对失效毫秒时间戳（`issuedAt + MINI_APP_SESSION_MAX_LIFETIME_MS`）。 */
  readonly absoluteExpiresAt: number;
}

/** 最近一次已成功签发会话所消费的 TOTP 步进窗记录（同一密钥下防止同一或更早 30 秒时间步动态码被重放）。 */
export interface MiniAppConsumedTotpStep {
  readonly secret: string;
  readonly counter: number;
}

/** 主线程缓存中暂存的临时 X25519 登录握手记录（完成一次登录密钥协商后立即消费销毁）。 */
export interface MiniAppAuthHandshakeRecord {
  /** 32 位小写十六进制临时握手标识（同步作为 HKDF-SHA256 的 salt）。 */
  readonly handshakeId: string;
  /** 服务端本次握手独占生成的不可导出 X25519 临时私钥。 */
  readonly serverPrivateKey: CryptoKey;
  /** Base64 编码的 32 字节服务端 X25519 临时公钥。 */
  readonly serverPublicKey: string;
  /** 签发毫秒时间戳。 */
  readonly createdAt: number;
  /** 未消费兜底过期毫秒时间戳（`createdAt + MINI_APP_HANDSHAKE_TTL_MS`）。 */
  readonly expiresAt: number;
}

/** 主线程每次启动时在内存中重新生成的 Mini App 源站 Ed25519 签名密钥对（私钥不可导出，不落盘）。 */
export interface MiniAppRuntimeSigningKeyPair {
  /** 不可导出的 Web Crypto `Ed25519` 签名私钥句柄（仅 `["sign"]`）。 */
  readonly privateKey: CryptoKey;
  /** 标准 RFC 4648 Base64 编码的 32 字节 Ed25519 原始公钥（44 字符，运行时注入前端打包 JS 产物）。 */
  readonly publicKeyBase64: string;
}

/** 超级管理员 ID 的 Mini App 二次认证（访问密码或 6 位 TOTP 动态码）连续失败计数与锁定状态。 */
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
  /** 处于登录失败锁定期时剩余的锁定分钟数（仅 `PASSWORD_LOCKED` 携带）。 */
  readonly remainingMinutes?: number;
}

/** `GET /api/auth/precheck` 在尚未建立活跃会话时动态下发并经本次启动内存 Ed25519 私钥签名的临时 X25519 握手公钥凭据。 */
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
