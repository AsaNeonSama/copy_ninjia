/**
 * `memory/mini-app-totp/totp.json` 中单实例谷歌验证器（TOTP）的持久化记录结构。
 */
export interface MiniAppTotpRecord {
  /** Schema 版本号（固定为 `1`）。 */
  readonly version: number;
  /** 32 位大写 RFC 4648 Base32 编码的 160-bit 密钥。 */
  readonly secret: string;
  /** 创建或修改绑定的毫秒时间戳。 */
  readonly createdAt: number;
}

/**
 * 主线程内存中暂存的待扫码确认 TOTP 绑定会话（10 分钟有效期，连续输错达上限立即作废）。
 */
export interface MiniAppPendingTotpSetup {
  /** 待确认的 32 位 Base32 密钥。 */
  readonly secret: string;
  /** 兼容 Google Authenticator 的 `otpauth://totp/...` 标准 URI。 */
  readonly otpauthUri: string;
  /** 服务端纯计算生成的内联 `<svg>` 二维码字符串。 */
  readonly qrSvg: string;
  /** 生成该待确认密钥时的毫秒时间戳。 */
  readonly createdAt: number;
  /** 待确认密钥过期毫秒时间戳。 */
  readonly expiresAt: number;
  /** 当前待确认密钥已连续输错动态码的次数。 */
  readonly failedAttempts: number;
}

/**
 * Mini App 登录门禁当前生效的认证方式（存在 TOTP 验证器时固定优先 `"totp"`，未配置验证器时为 `"password"`）。
 */
export type MiniAppAuthMode = "totp" | "password";

/**
 * `GET /api/totp` 返回给前端控制台的 TOTP 验证器状态视图（脱敏，绝不回显完整已保存明文密钥）。
 */
export interface MiniAppTotpStatusView {
  /** 当前是否已在 `memory/mini-app-totp/totp.json` 启用验证器。 */
  readonly enabled: boolean;
  /** 绑定毫秒时间戳；未启用时为 `null`。 */
  readonly createdAt: number | null;
  /** 脱敏展示的密钥摘要（如 `"ABCD••••WXYZ"`）；未启用时为 `null`。 */
  readonly maskedSecret: string | null;
}

/**
 * `POST /api/totp/setup` 在前端控制台发起新增或修改验证器时返回的待扫码绑定信息。
 */
export interface MiniAppTotpSetupResponse {
  readonly ok: true;
  /** 供手动输入的 32 位 Base32 密钥。 */
  readonly secret: string;
  /** 兼容 Google Authenticator 的 `otpauth://totp/...` 标准 URI。 */
  readonly otpauthUri: string;
  /** 服务端纯计算生成的内联 `<svg>` 二维码字符串。 */
  readonly qrSvg: string;
  /** 待绑定密钥过期毫秒时间戳。 */
  readonly expiresAt: number;
}

/**
 * `POST /api/totp/enable` 与 `DELETE /api/totp` 的操作结果响应。
 */
export interface MiniAppTotpMutationResponse {
  readonly ok: boolean;
  readonly message: string;
  readonly status: Readonly<MiniAppTotpStatusView>;
}
