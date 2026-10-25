import {
  MINI_APP_ASSET_TOKEN_SECRET_SEED,
  MINI_APP_AUTH_CLOCK_SKEW_SECONDS,
  MINI_APP_AUTH_MAX_AGE_SECONDS,
  MINI_APP_POSITIVE_INTEGER_PATTERN,
  MINI_APP_SHA256_HEX_PATTERN,
  MINI_APP_WEB_APP_DATA_SECRET_SEED,
} from "../consts/miniApp";
import { isPlainRecord } from "./record";
import type { MiniAppAuthResult, MiniAppInitDataUser } from "../types/miniApp";

/** `verifyMiniAppInitData` 的验签与权限校验选项。 */
export interface VerifyMiniAppInitDataOptions {
  /** Telegram WebApp 传入的原始 `initData` 查询字符串。 */
  readonly initData: string | null | undefined;
  /** 当前 Bot 的 API Token，用于派生 `WebAppData` HMAC 密钥。 */
  readonly botToken: string;
  /** 唯一允许访问 Mini App 的超级管理员 Telegram 用户 ID。 */
  readonly superAdminUserId: number;
  /** 当前毫秒时间戳（缺省取 `Date.now()`）。 */
  readonly nowMs?: number;
  /** `auth_date` 最大有效秒数（缺省取 `MINI_APP_AUTH_MAX_AGE_SECONDS`）。 */
  readonly maxAgeSeconds?: number;
}

/**
 * 解析并校验 `initData` 中的 `user` JSON 字段。
 * @param rawUser `initData` 中解码出的 `user` 字符串。
 * @returns 结构合法时返回用户身份摘要，否则返回 null。
 */
function parseInitDataUser(rawUser: string): Readonly<MiniAppInitDataUser> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch (_error: unknown) {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  if (
    typeof parsed.id !== "number" ||
    !Number.isSafeInteger(parsed.id) ||
    parsed.id <= 0 ||
    typeof parsed.first_name !== "string"
  ) {
    return null;
  }
  if (parsed.last_name !== undefined && typeof parsed.last_name !== "string") {
    return null;
  }
  if (parsed.username !== undefined && typeof parsed.username !== "string") {
    return null;
  }
  return {
    id: parsed.id,
    firstName: parsed.first_name,
    ...(parsed.last_name === undefined ? {} : { lastName: parsed.last_name }),
    ...(parsed.username === undefined ? {} : { username: parsed.username }),
  };
}

/**
 * 按 Telegram Mini Apps 官方规范校验 `initData` 的 HMAC-SHA256 签名、`auth_date` 时效与超级管理员身份。
 * @param options 验签与身份核验参数。
 * @returns 验签与超级管理员核验结果。
 */
export function verifyMiniAppInitData({
  initData,
  botToken,
  superAdminUserId,
  nowMs = Date.now(),
  maxAgeSeconds = MINI_APP_AUTH_MAX_AGE_SECONDS,
}: VerifyMiniAppInitDataOptions): MiniAppAuthResult {
  if (typeof initData !== "string" || initData.trim().length === 0) {
    return { ok: false, reason: "missing_init_data" };
  }
  const params: URLSearchParams = new URLSearchParams(initData);
  const seenKeys: Set<string> = new Set<string>();
  const dataCheckLines: string[] = [];
  let hashHex: string | undefined;
  let authDateRaw: string | undefined;
  let userRaw: string | undefined;
  let chatTypeRaw: string | undefined;

  for (const [key, value] of params) {
    if (key.length === 0 || seenKeys.has(key)) {
      return { ok: false, reason: "malformed_init_data" };
    }
    seenKeys.add(key);
    if (key === "hash") {
      hashHex = value;
      continue;
    }
    if (key === "auth_date") authDateRaw = value;
    if (key === "user") userRaw = value;
    if (key === "chat_type") chatTypeRaw = value;
    dataCheckLines.push(`${key}=${value}`);
  }

  if (hashHex === undefined || !MINI_APP_SHA256_HEX_PATTERN.test(hashHex)) {
    return { ok: false, reason: "malformed_init_data" };
  }
  if (authDateRaw === undefined || !MINI_APP_POSITIVE_INTEGER_PATTERN.test(authDateRaw)) {
    return { ok: false, reason: "malformed_init_data" };
  }
  const authDate: number = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    return { ok: false, reason: "malformed_init_data" };
  }

  dataCheckLines.sort();
  const dataCheckString: string = dataCheckLines.join("\n");
  const secretKey: Uint8Array = new Bun.CryptoHasher(
    "sha256",
    MINI_APP_WEB_APP_DATA_SECRET_SEED
  )
    .update(botToken, "utf8")
    .digest();
  const expectedDigest: Uint8Array = new Bun.CryptoHasher("sha256", secretKey)
    .update(dataCheckString, "utf8")
    .digest();
  const actualDigest: Uint8Array = Uint8Array.fromHex(hashHex.toLowerCase());
  if (
    actualDigest.byteLength !== expectedDigest.byteLength ||
    !crypto.timingSafeEqual(actualDigest, expectedDigest)
  ) {
    return { ok: false, reason: "invalid_signature" };
  }

  const nowSeconds: number = Math.floor(nowMs / 1000);
  if (
    authDate > nowSeconds + MINI_APP_AUTH_CLOCK_SKEW_SECONDS ||
    nowSeconds - authDate > maxAgeSeconds
  ) {
    return { ok: false, reason: "expired_auth_date" };
  }

  if (userRaw === undefined) {
    return { ok: false, reason: "missing_user" };
  }
  const user: Readonly<MiniAppInitDataUser> | null = parseInitDataUser(userRaw);
  if (user === null) {
    return { ok: false, reason: "malformed_init_data" };
  }
  if (user.id !== superAdminUserId) {
    return { ok: false, reason: "forbidden_user" };
  }
  if (
    chatTypeRaw !== undefined &&
    chatTypeRaw !== "private" &&
    chatTypeRaw !== "sender"
  ) {
    return { ok: false, reason: "forbidden_user" };
  }
  return {
    ok: true,
    authDate,
    user,
  };
}

/**
 * 以常量时间比对输入访问密码与配置密码的 SHA-256 摘要，防止时序侧信道泄露密码长度或前缀。
 * @param inputPassword 用户输入的待验证密码。
 * @param expectedPassword `bot.json` 中配置的权威访问密码。
 * @returns 两者完全一致且非空时返回 `true`，否则返回 `false`。
 */
export function verifyMiniAppPassword(
  inputPassword: string,
  expectedPassword: string
): boolean {
  const normalizedInput: string = inputPassword.trim();
  const normalizedExpected: string = expectedPassword.trim();
  if (normalizedInput.length === 0 || normalizedExpected.length === 0) {
    return false;
  }
  const inputDigest: Uint8Array = new Bun.CryptoHasher("sha256")
    .update(normalizedInput, "utf8")
    .digest();
  const expectedDigest: Uint8Array = new Bun.CryptoHasher("sha256")
    .update(normalizedExpected, "utf8")
    .digest();
  return crypto.timingSafeEqual(inputDigest, expectedDigest);
}

/**
 * 基于 `BOT_TOKEN` 与 `SUPER_ADMIN_USER_ID` 确定性派生受保护静态/图库资源的稳定访问令牌（64 位小写十六进制）。
 * @param botToken 当前 Bot 的 API Token。
 * @param superAdminUserId 超级管理员 Telegram 用户 ID。
 * @returns 64 位十六进制 HMAC-SHA256 资源令牌。
 */
export function deriveMiniAppAssetToken(
  botToken: string,
  superAdminUserId: number
): string {
  return new Bun.CryptoHasher("sha256", MINI_APP_ASSET_TOKEN_SECRET_SEED)
    .update(`${botToken}:${superAdminUserId}`, "utf8")
    .digest("hex");
}

/**
 * 以常量时间校验 URL 查询参数中的受保护静态/图库资源令牌是否合法。
 * @param token 请求携带的 `token` 查询参数。
 * @param botToken 当前 Bot 的 API Token。
 * @param superAdminUserId 超级管理员 Telegram 用户 ID。
 * @returns 令牌合法且匹配时返回 `true`，否则返回 `false`。
 */
export function verifyMiniAppAssetToken(
  token: string | null | undefined,
  botToken: string,
  superAdminUserId: number
): boolean {
  if (typeof token !== "string" || !MINI_APP_SHA256_HEX_PATTERN.test(token)) {
    return false;
  }
  const expectedDigest: Uint8Array = new Bun.CryptoHasher(
    "sha256",
    MINI_APP_ASSET_TOKEN_SECRET_SEED
  )
    .update(`${botToken}:${superAdminUserId}`, "utf8")
    .digest();
  const actualDigest: Uint8Array = Uint8Array.fromHex(token.toLowerCase());
  return (
    actualDigest.byteLength === expectedDigest.byteLength &&
    crypto.timingSafeEqual(actualDigest, expectedDigest)
  );
}
