import { MINUTE_MS } from "./time";

/**
 * `memory/mini-app-totp/totp.json` 持久化记录的当前 Schema 版本号。
 * 不变量：恒为正整数 `1`。所属模块：`packages/miniApp/totpStorage.ts`。
 */
export const MINI_APP_TOTP_RECORD_VERSION: number = 1;

/**
 * 生成 RFC 6238 / Google Authenticator 兼容 TOTP 密钥的随机字节长度（20 字节 = 160 位，编码为 32 位无填充 Base32 字符串）。
 * 不变量：正整数 `20`，恰好被 5 位一组整除（`20 * 8 / 5 = 32`）。所属模块：`packages/libs/miniAppTotp.ts`。
 */
export const MINI_APP_TOTP_SECRET_BYTES: number = 20;

/**
 * TOTP 动态验证码的十进制数字位数（6 位）。
 * 不变量：遵循 Google Authenticator 默认规范，恒为 `6`。所属模块：`packages/libs/miniAppTotp.ts`。
 */
export const MINI_APP_TOTP_DIGITS: number = 6;

/**
 * TOTP 时间步长秒数（30 秒）。
 * 不变量：遵循 RFC 6238 与 Google Authenticator 默认规范，恒为 `30`。所属模块：`packages/libs/miniAppTotp.ts`。
 */
export const MINI_APP_TOTP_STEP_SECONDS: number = 30;

/**
 * 前端控制台生成待绑定 TOTP 密钥与二维码后，在主线程内存中的待确认有效期毫秒数（10 分钟）。
 * 不变量：到期未完成 6 位动态码核验的待绑定密钥自动失效。所属模块：`packages/miniApp/totpStorage.ts`。
 */
export const MINI_APP_TOTP_PENDING_TTL_MS: number = 10 * MINUTE_MS;

/**
 * `otpauth://totp/` 二维码 URI 中的签发方（`issuer`）名称。
 * 不变量：非空短文本，用于在 Google Authenticator 中标识本 Bot 控制台。所属模块：`packages/libs/miniAppTotp.ts`。
 */
export const MINI_APP_TOTP_ISSUER: string = "Copy Ninja";

/**
 * `otpauth://totp/` 二维码 URI 中的账户名前缀（后接 `SUPER_ADMIN_USER_ID`）。
 * 不变量：非空短文本。所属模块：`packages/libs/miniAppTotp.ts`。
 */
export const MINI_APP_TOTP_ACCOUNT_PREFIX: string = "SuperAdmin#";

/**
 * RFC 4648 标准 Base32 字母表（大写 `A-Z` 与 `2-7`，共 32 个字符）。
 * 不变量：长度恒为 32，供 TOTP 密钥编码与解码无状态查表。所属模块：`packages/libs/miniAppTotp.ts`。
 */
export const MINI_APP_TOTP_BASE32_ALPHABET: string =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * 合法 32 位 RFC 4648 Base32 TOTP 密钥的严格匹配规则。
 * 不变量：不带全局标志 `g`，供持久化文件解码与验证无状态复用。所属模块：`packages/libs/miniAppTotp.ts` 与 `packages/miniApp/totpStorage.ts`。
 */
export const MINI_APP_TOTP_SECRET_PATTERN: RegExp = /^[A-Z2-7]{32}$/u;

/**
 * 6 位十进制 TOTP 动态验证码的严格匹配规则。
 * 不变量：不带全局标志 `g`，供登录与绑定接口无状态复用。所属模块：`packages/libs/miniAppTotp.ts`。
 */
export const MINI_APP_TOTP_CODE_PATTERN: RegExp = /^\d{6}$/u;

/**
 * QR Code Byte 模式（纠错等级 L）支持的版本号列表（Version 4..8，覆盖 `otpauth://` URI 长度）。
 * 不变量：与 `QR_L_MAX_BYTES` 等并行数组按下标一一对应。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_L_VERSIONS: readonly number[] = [4, 5, 6, 7, 8];

/**
 * QR Code Version 4..8（纠错等级 L，Byte 模式）各自允许的最大 UTF-8 字节容量。
 * 不变量：升序正整数只读数组，与 `QR_L_VERSIONS` 同长度。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_L_MAX_BYTES: readonly number[] = [78, 106, 134, 154, 192];

/**
 * QR Code Version 4..8（纠错等级 L）的 Reed-Solomon 纠错分块数。
 * 不变量：正整数只读数组，与 `QR_L_VERSIONS` 同长度。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_L_NUM_BLOCKS: readonly number[] = [1, 1, 2, 2, 2];

/**
 * QR Code Version 4..8（纠错等级 L）每个纠错分块的数据码字（Data Codewords）字节数。
 * 不变量：正整数只读数组，与 `QR_L_VERSIONS` 同长度。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_L_DATA_CODEWORDS_PER_BLOCK: readonly number[] = [
  80, 108, 68, 78, 97,
];

/**
 * QR Code Version 4..8（纠错等级 L）每个纠错分块的纠错码字（EC Codewords）字节数。
 * 不变量：正整数只读数组，与 `QR_L_VERSIONS` 同长度。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_L_EC_CODEWORDS_PER_BLOCK: readonly number[] = [
  20, 26, 18, 20, 24,
];

/**
 * QR Code Version 4..8 校正图形（Alignment Pattern）中心行列坐标表。
 * 不变量：二维只读正整数数组，与 `QR_L_VERSIONS` 同长度。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_ALIGNMENT_CENTERS_V4_TO_V8: readonly (readonly number[])[] = [
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
];

/**
 * QR Code 数据区末尾不足容量时的交替填充字节（`0xEC` 与 `0x11`）。
 * 不变量：ISO/IEC 18004 规范固定值。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_PAD_BYTES: readonly number[] = [0xec, 0x11];

/**
 * QR Code 纠错等级 L 在 15 位格式信息中的 2 位标识值（`01`）。
 * 不变量：ISO/IEC 18004 规范固定值 `1`。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_FORMAT_ECC_L_BITS: number = 0b01;

/**
 * QR Code 15 位格式信息 BCH(15, 5) 纠错生成多项式（`0x537`）。
 * 不变量：ISO/IEC 18004 规范固定值。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_FORMAT_BCH_GENERATOR: number = 0x537;

/**
 * QR Code 15 位格式信息最终异或掩码（`0x5412`）。
 * 不变量：ISO/IEC 18004 规范固定值。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_FORMAT_BCH_MASK: number = 0x5412;

/**
 * QR Code Version 7+ 的 18 位版本信息 Golay(18, 6) 生成多项式（`0x1F25`）。
 * 不变量：ISO/IEC 18004 规范固定值。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_VERSION_BCH_GENERATOR: number = 0x1f25;

/**
 * QR Code Reed-Solomon 有限域 $\text{GF}(2^8)$ 的本原多项式（$x^8 + x^4 + x^3 + x^2 + 1 = \text{0x11D}$）。
 * 不变量：ISO/IEC 18004 规范固定值。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_GF256_PRIMITIVE_POLY: number = 0x11d;

/**
 * QR Code SVG 渲染四周留白静区（Quiet Zone）的模块宽度（4 个模块）。
 * 不变量：遵循 ISO/IEC 18004 最小静区要求，恒为 `4`。所属模块：`packages/libs/qrcodeSvg.ts`。
 */
export const QR_SVG_QUIET_ZONE_MODULES: number = 4;
