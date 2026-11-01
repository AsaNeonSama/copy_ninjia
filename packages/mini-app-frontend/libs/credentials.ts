import {
  MINI_APP_SESSION_STORAGE_KEY,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../consts/miniApp";
import type { TelegramWindow } from "../types/miniApp";
import { asPayloadRecord } from "./record";

/**
 * 读取当前浏览器会话已解锁的 Mini App 45 分钟认证令牌（若内存未命中则从 Mini App 环境 Web Storage 恢复未过期凭据）。
 * @returns 64 位十六进制会话令牌；未解锁或已过期时返回空字符串
 */
export function readMiniAppSessionToken(): string {
  const tgWindow: TelegramWindow = globalThis;
  const nowMs: number = Date.now();
  if (
    typeof tgWindow.__copyNinjaSessionToken === "string" &&
    tgWindow.__copyNinjaSessionToken.length > 0
  ) {
    if (
      typeof tgWindow.__copyNinjaSessionExpiresAt === "number" &&
      tgWindow.__copyNinjaSessionExpiresAt <= nowMs
    ) {
      clearMiniAppSessionToken();
      return "";
    }
    return tgWindow.__copyNinjaSessionToken;
  }
  let raw: string | null;
  try {
    raw =
      tgWindow.localStorage?.getItem(MINI_APP_SESSION_STORAGE_KEY) ??
      tgWindow.sessionStorage?.getItem(MINI_APP_SESSION_STORAGE_KEY) ??
      null;
  } catch (_error: unknown) {
    raw = null;
  }
  if (raw === null || raw.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    const record: Record<string, unknown> = asPayloadRecord(parsed);
    const token: unknown = record.token;
    const expiresAt: unknown = record.expiresAt;
    const assetToken: unknown = record.assetToken;
    if (
      typeof token === "string" &&
      MINI_APP_SHA256_HEX_PATTERN.test(token) &&
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt > nowMs
    ) {
      tgWindow.__copyNinjaSessionToken = token;
      tgWindow.__copyNinjaSessionExpiresAt = expiresAt;
      if (
        typeof assetToken === "string" &&
        assetToken.length > 0 &&
        (tgWindow.__copyNinjaAssetToken === undefined ||
          tgWindow.__copyNinjaAssetToken.length === 0)
      ) {
        tgWindow.__copyNinjaAssetToken = assetToken;
      }
      return token;
    }
  } catch (_error: unknown) {
    // 忽略损坏的持久化 JSON
  }
  clearMiniAppSessionToken();
  return "";
}

/**
 * 读取当前浏览器会话已解锁的 Mini App 45 分钟认证令牌到期毫秒时间戳。
 * @returns 到期毫秒时间戳；未解锁或已过期时返回 `0`
 */
export function readMiniAppSessionExpiresAt(): number {
  const token: string = readMiniAppSessionToken();
  if (token.length === 0) return 0;
  const tgWindow: TelegramWindow = globalThis;
  return tgWindow.__copyNinjaSessionExpiresAt ?? 0;
}

/**
 * 保存当前浏览器会话已解锁的 Mini App 45 分钟认证令牌，并同步持久化至 Mini App 环境 Web Storage。
 * @param token 服务端签发的 64 位十六进制会话令牌
 * @param expiresAt 会话到期毫秒时间戳（缺省按当前时刻加 `MINI_APP_SESSION_TTL_MS` 计算）
 */
export function setMiniAppSessionToken(token: string, expiresAt?: number): void {
  const trimmed: string = token.trim();
  if (trimmed.length === 0) {
    clearMiniAppSessionToken();
    return;
  }
  const tgWindow: TelegramWindow = globalThis;
  const resolvedExpiresAt: number =
    typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0
      ? expiresAt
      : Date.now() + MINI_APP_SESSION_TTL_MS;
  tgWindow.__copyNinjaSessionToken = trimmed;
  tgWindow.__copyNinjaSessionExpiresAt = resolvedExpiresAt;
  const serialized: string = JSON.stringify({
    token: trimmed,
    expiresAt: resolvedExpiresAt,
    ...(typeof tgWindow.__copyNinjaAssetToken === "string" &&
    tgWindow.__copyNinjaAssetToken.length > 0
      ? { assetToken: tgWindow.__copyNinjaAssetToken }
      : {}),
  });
  try {
    tgWindow.localStorage?.setItem(MINI_APP_SESSION_STORAGE_KEY, serialized);
  } catch (_error: unknown) {
    // 忽略受限 WebView 禁用 localStorage 的异常
  }
  try {
    tgWindow.sessionStorage?.setItem(MINI_APP_SESSION_STORAGE_KEY, serialized);
  } catch (_error: unknown) {
    // 忽略受限 WebView 禁用 sessionStorage 的异常
  }
}

/**
 * 清除当前浏览器会话及 Mini App 环境持久化的认证令牌与受保护资源令牌（会话满 45 分钟过期或主动锁定时调用）。
 */
export function clearMiniAppSessionToken(): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.__copyNinjaSessionToken = undefined;
  tgWindow.__copyNinjaSessionExpiresAt = undefined;
  tgWindow.__copyNinjaAssetToken = undefined;
  try {
    tgWindow.localStorage?.removeItem(MINI_APP_SESSION_STORAGE_KEY);
  } catch (_error: unknown) {
    // 忽略受限 WebView 禁用 localStorage 的异常
  }
  try {
    tgWindow.sessionStorage?.removeItem(MINI_APP_SESSION_STORAGE_KEY);
  } catch (_error: unknown) {
    // 忽略受限 WebView 禁用 sessionStorage 的异常
  }
}

/**
 * 读取当前浏览器会话缓存的受保护静态/图库资源稳定访问令牌。
 * @returns 64 位十六进制资源令牌；未登录解锁时返回空字符串
 */
export function readMiniAppAssetToken(): string {
  const tgWindow: TelegramWindow = globalThis;
  return tgWindow.__copyNinjaAssetToken ?? "";
}

/**
 * 保存服务端在登录成功后（或预检恢复有效 45 分钟解锁会话时）下发的受保护静态/图库资源稳定访问令牌。
 * @param token 64 位十六进制资源令牌
 */
export function setMiniAppAssetToken(token: string): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.__copyNinjaAssetToken = token;
}

/**
 * 清除当前浏览器会话的受保护资源令牌（会话未解锁、锁定或测试重置时调用）。
 */
export function clearMiniAppAssetToken(): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.__copyNinjaAssetToken = undefined;
}
