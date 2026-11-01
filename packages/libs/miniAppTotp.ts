import {
  MINI_APP_TOTP_ACCOUNT_PREFIX,
  MINI_APP_TOTP_BASE32_ALPHABET,
  MINI_APP_TOTP_CODE_PATTERN,
  MINI_APP_TOTP_DIGITS,
  MINI_APP_TOTP_ISSUER,
  MINI_APP_TOTP_SECRET_BYTES,
  MINI_APP_TOTP_SECRET_PATTERN,
  MINI_APP_TOTP_STEP_SECONDS,
} from "../consts/miniAppTotp";
import { timingSafeStringEqual } from "./digestEqual";

/**
 * 将字节数组编码为无填充的 RFC 4648 大写 Base32 字符串。
 * @param bytes 待编码的原始字节数组。
 * @returns 大写 Base32 字符串。
 */
export function encodeTotpBase32(bytes: Uint8Array): string {
  let bits: number = 0;
  let value: number = 0;
  let output: string = "";
  for (let i: number = 0; i < bytes.byteLength; i += 1) {
    value = (value << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const index: number = (value >>> bits) & 0x1f;
      output += MINI_APP_TOTP_BASE32_ALPHABET[index] ?? "A";
    }
  }
  if (bits > 0) {
    const index: number = (value << (5 - bits)) & 0x1f;
    output += MINI_APP_TOTP_BASE32_ALPHABET[index] ?? "A";
  }
  return output;
}

/**
 * 将 32 位 RFC 4648 Base32 密钥字符串解码为 20 字节的 HMAC-SHA1 密钥。
 * @param secret 32 位 Base32 密钥字符串。
 * @returns 合法时返回 20 字节 `Uint8Array`，非法时返回 `null`。
 */
export function decodeTotpBase32(secret: string): Uint8Array | null {
  const normalized: string = secret.trim().toUpperCase();
  if (!MINI_APP_TOTP_SECRET_PATTERN.test(normalized)) {
    return null;
  }
  const output: Uint8Array = new Uint8Array(MINI_APP_TOTP_SECRET_BYTES);
  let bits: number = 0;
  let value: number = 0;
  let byteIndex: number = 0;
  for (let i: number = 0; i < normalized.length; i += 1) {
    const charCode: number = normalized.charCodeAt(i);
    let quintet: number;
    if (charCode >= 65 && charCode <= 90) {
      quintet = charCode - 65;
    } else if (charCode >= 50 && charCode <= 55) {
      quintet = charCode - 24;
    } else {
      return null;
    }
    value = (value << 5) | quintet;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output[byteIndex] = (value >>> bits) & 0xff;
      byteIndex += 1;
    }
  }
  return byteIndex === MINI_APP_TOTP_SECRET_BYTES ? output : null;
}

/**
 * 使用密码学安全随机数生成器（CSPRNG）生成 20 字节（32 位 Base32）TOTP 密钥。
 * @returns 32 位大写 Base32 密钥字符串。
 */
export function generateMiniAppTotpSecret(): string {
  const randomBytes: Uint8Array = new Uint8Array(MINI_APP_TOTP_SECRET_BYTES);
  crypto.getRandomValues(randomBytes);
  return encodeTotpBase32(randomBytes);
}

/**
 * 按 RFC 4226 / RFC 6238 计算指定计数器步长下的 6 位 HMAC-SHA1 TOTP 动态验证码。
 * @param secret 32 位 Base32 密钥字符串。
 * @param counter 64 位非负时间步计数器。
 * @returns 6 位零填充十进制验证码字符串；密钥或计数器非法时返回空字符串。
 */
export function computeMiniAppTotpCode(secret: string, counter: number): string {
  const keyBytes: Uint8Array | null = decodeTotpBase32(secret);
  if (keyBytes === null || !Number.isFinite(counter) || counter < 0) {
    return "";
  }
  const counterBytes: Uint8Array = new Uint8Array(8);
  const wholeCounter: bigint = BigInt(Math.floor(counter));
  const view: DataView = new DataView(counterBytes.buffer);
  view.setBigUint64(0, wholeCounter, false);
  const digest: Uint8Array = new Bun.CryptoHasher("sha1", keyBytes)
    .update(counterBytes)
    .digest();
  const offset: number = (digest[19] ?? 0) & 0x0f;
  const b0: number = (digest[offset] ?? 0) & 0x7f;
  const b1: number = (digest[offset + 1] ?? 0) & 0xff;
  const b2: number = (digest[offset + 2] ?? 0) & 0xff;
  const b3: number = (digest[offset + 3] ?? 0) & 0xff;
  const binaryCode: number = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
  const modulus: number = 10 ** MINI_APP_TOTP_DIGITS;
  const otp: number = binaryCode % modulus;
  return String(otp).padStart(MINI_APP_TOTP_DIGITS, "0");
}

/**
 * 计算给定毫秒时间戳对应的当前 6 位 TOTP 验证码。
 * @param secret 32 位 Base32 密钥字符串。
 * @param nowMs 当前毫秒时间戳（缺省取 `Date.now()`）。
 * @returns 6 位十进制验证码字符串。
 */
export function generateMiniAppTotpCodeAt(
  secret: string,
  nowMs: number = Date.now()
): string {
  const counter: number = Math.floor(
    nowMs / 1000 / MINI_APP_TOTP_STEP_SECONDS
  );
  return computeMiniAppTotpCode(secret, counter);
}

/**
 * 以常量时间校验用户输入的 6 位 TOTP 验证码是否等于当前时间步的验证码（相邻时间步的验证码不予接受）。
 * 密钥或时间戳非法时期望码为空串，比对必然失败。
 * @param inputCode 用户输入的 6 位数字验证码。
 * @param secret 32 位 Base32 密钥字符串。
 * @param nowMs 当前毫秒时间戳（缺省取 `Date.now()`）。
 * @returns 验证通过返回 `true`，否则返回 `false`。
 */
export function verifyMiniAppTotpCode(
  inputCode: string,
  secret: string,
  nowMs: number = Date.now()
): boolean {
  const normalizedCode: string = inputCode.trim();
  if (!MINI_APP_TOTP_CODE_PATTERN.test(normalizedCode)) {
    return false;
  }
  return timingSafeStringEqual(
    normalizedCode,
    generateMiniAppTotpCodeAt(secret, nowMs)
  );
}

/**
 * 构建兼容 Google Authenticator 的 `otpauth://totp/` 标准 URI。
 * @param secret 32 位 Base32 密钥字符串。
 * @param superAdminUserId 超级管理员 Telegram 用户 ID。
 * @returns 标准 `otpauth://totp/...` URI 字符串。
 */
export function buildMiniAppTotpUri(
  secret: string,
  superAdminUserId: number
): string {
  const accountLabel: string = `${MINI_APP_TOTP_ISSUER}:${MINI_APP_TOTP_ACCOUNT_PREFIX}${superAdminUserId}`;
  const encodedLabel: string = encodeURIComponent(accountLabel);
  const encodedIssuer: string = encodeURIComponent(MINI_APP_TOTP_ISSUER);
  return `otpauth://totp/${encodedLabel}?secret=${encodeURIComponent(secret)}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${MINI_APP_TOTP_DIGITS}&period=${MINI_APP_TOTP_STEP_SECONDS}`;
}

/**
 * 将 32 位 Base32 密钥脱敏为首尾各保留 4 位的展示字符串。
 * @param secret 32 位 Base32 密钥字符串。
 * @returns 脱敏后的密钥摘要（如 `ABCD••••WXYZ`）。
 */
export function maskMiniAppTotpSecret(secret: string): string {
  const normalized: string = secret.trim().toUpperCase();
  if (normalized.length <= 8) return "••••••••";
  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}
