import {
  MINI_APP_SESSION_STORAGE_KEY,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../consts/miniApp";
import type { MiniAppPersistedSessionKey, TelegramWindow } from "../types/miniApp/host";
import { importMiniAppAesGcmKey, isValidMiniAppHexKey } from "./crypto";
import { clearPendingMiniAppAuthHandshake } from "./handshakeCrypto";
import { asPayloadRecord } from "./record";
import {
  clearPersistedMiniAppSessionKey,
  loadPersistedMiniAppSessionKey,
  persistMiniAppSessionKey,
} from "./sessionKeyStorage";

/** 从 `sessionStorage` 恢复出的会话令牌与到期时间元数据（绝不含明文密钥）。 */
interface StoredSessionMetadata {
  readonly token: string;
  readonly expiresAt: number;
}

/** 单调递增的会话变更世代号，防止过期异步 IndexedDB 水合结果覆盖较新的登录或登出态。 */
let sessionGeneration: number = 0;

/** 仅保存在模块私有闭包中的当前活跃 64 位十六进制会话令牌（绝不挂到 `globalThis`）。 */
let activeSessionToken: string = "";

/** 仅保存在模块私有闭包中的当前会话过期毫秒时间戳。 */
let activeSessionExpiresAt: number = 0;

/** 仅保存在模块私有闭包中的不可导出 `AES-GCM` `CryptoKey` 实例（已兑现缓存）。 */
let activeSessionCryptoKeyResolved: CryptoKey | null = null;

/** 仅保存在模块私有闭包中的不可导出 `AES-GCM` `CryptoKey` 导入/恢复异步句柄。 */
let activeSessionCryptoKeyPromise: Promise<CryptoKey | null> | null = null;

/** 单飞合并中的跨刷新会水合任务句柄。 */
let activeHydrationPromise: Promise<void> | null = null;

/**
 * 从 `sessionStorage` 读取并校验 `{ token, expiresAt }` 元数据；
 * 若发现已过期、格式非法或包含旧版明文 `sessionKey` 字段，立即视作无效并返回 `null`。
 * @param nowMs 当前毫秒时间戳。
 * @returns 合法且未过期的会话元数据；缺失或非法时返回 `null`。
 */
function readStoredSessionMetadata(
  nowMs: number
): Readonly<StoredSessionMetadata> | null {
  const tgWindow: TelegramWindow = globalThis;
  let raw: string | null;
  try {
    raw = tgWindow.sessionStorage?.getItem(MINI_APP_SESSION_STORAGE_KEY) ?? null;
  } catch (_error: unknown) {
    raw = null;
  }
  if (raw === null || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const record: Record<string, unknown> = asPayloadRecord(parsed);
    const token: unknown = record.token;
    const expiresAt: unknown = record.expiresAt;
    if (
      record.sessionKey === undefined &&
      typeof token === "string" &&
      MINI_APP_SHA256_HEX_PATTERN.test(token) &&
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt > nowMs
    ) {
      return { token, expiresAt };
    }
  } catch (_error: unknown) {
    // 忽略损坏的持久化 JSON
  }
  return null;
}

/**
 * 将当前活跃会话的 `{ token, expiresAt }` 元数据写入 `sessionStorage`（不写入 `localStorage` 且绝不落盘明文密钥）。
 * @param token 已校验的 64 位十六进制会话令牌。
 * @param expiresAt 到期毫秒时间戳。
 */
function writeSessionMetadataToStorage(token: string, expiresAt: number): void {
  const tgWindow: TelegramWindow = globalThis;
  try {
    tgWindow.localStorage?.removeItem(MINI_APP_SESSION_STORAGE_KEY);
  } catch (_error: unknown) {
    // 忽略受限 WebView 禁用 localStorage 的异常
  }
  try {
    tgWindow.sessionStorage?.setItem(
      MINI_APP_SESSION_STORAGE_KEY,
      JSON.stringify({ token, expiresAt })
    );
  } catch (_error: unknown) {
    // 忽略受限 WebView 禁用 sessionStorage 的异常
  }
}

/**
 * 规范化会话到期时刻：缺省、非有限值或非正数时取当前时刻加 `MINI_APP_SESSION_TTL_MS`。
 * @param expiresAt 调用方给出的到期毫秒时间戳。
 * @returns 可直接写入闭包与元数据的到期毫秒时间戳。
 */
function resolveSessionExpiresAt(expiresAt: number | undefined): number {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0
    ? expiresAt
    : Date.now() + MINI_APP_SESSION_TTL_MS;
}

/**
 * 开启新一代会话凭据：推进世代号并作废在途水合，写入令牌与到期时刻，清空待用登录握手并回写 `sessionStorage` 元数据；
 * 密钥句柄由调用方在同一同步段内随后写入。
 * @param token 已校验的 64 位十六进制会话令牌。
 * @param expiresAt 已规范化的到期毫秒时间戳。
 * @returns 本次开启的会话世代号。
 */
function beginSessionGeneration(token: string, expiresAt: number): number {
  sessionGeneration += 1;
  activeHydrationPromise = null;
  activeSessionToken = token;
  activeSessionExpiresAt = expiresAt;
  clearPendingMiniAppAuthHandshake();
  writeSessionMetadataToStorage(token, expiresAt);
  return sessionGeneration;
}

/**
 * 在页面启动或首屏预检前从 `sessionStorage` + IndexedDB 异步恢复未过期的会话令牌与不可导出 `CryptoKey` 句柄：
 * - `sessionStorage` 元数据只表示本浏览器会话仍持有未过期登录（并提供到期时刻），令牌与密钥一律取自 IndexedDB 的同代配对记录；
 * - 轮换后新令牌已写入 `sessionStorage`、新密钥尚未落盘时，恢复为已落盘的上一代配对并回写元数据，由服务端在宽限期内重新附带的轮换密文追上最新一代；
 * - `sessionStorage` 缺少有效元数据或 IndexedDB 缺少有效配对记录时，立即清除残留本地凭据并保持未解锁态。
 */
export async function hydrateMiniAppSessionFromStorage(): Promise<void> {
  const nowMs: number = Date.now();
  if (
    activeSessionToken.length > 0 &&
    activeSessionExpiresAt > nowMs &&
    activeSessionCryptoKeyPromise !== null
  ) {
    return;
  }
  if (activeHydrationPromise !== null) {
    return activeHydrationPromise;
  }

  const startGeneration: number = sessionGeneration;
  const runHydration: Promise<void> = (async (): Promise<void> => {
    const metadata: Readonly<StoredSessionMetadata> | null =
      readStoredSessionMetadata(Date.now());
    if (metadata === null) {
      if (sessionGeneration === startGeneration) {
        clearMiniAppSessionToken();
      }
      return;
    }
    const persisted: Readonly<MiniAppPersistedSessionKey> | null =
      await loadPersistedMiniAppSessionKey();
    if (sessionGeneration !== startGeneration) {
      return;
    }
    if (persisted === null || metadata.expiresAt <= Date.now()) {
      clearMiniAppSessionToken();
      return;
    }
    activeSessionToken = persisted.token;
    activeSessionExpiresAt = metadata.expiresAt;
    activeSessionCryptoKeyResolved = persisted.cryptoKey;
    activeSessionCryptoKeyPromise = Promise.resolve(persisted.cryptoKey);
    if (persisted.token !== metadata.token) {
      writeSessionMetadataToStorage(persisted.token, metadata.expiresAt);
    }
  })();

  activeHydrationPromise = runHydration;
  try {
    await runHydration;
  } finally {
    if (activeHydrationPromise === runHydration) {
      activeHydrationPromise = null;
    }
  }
}

/**
 * 读取当前浏览器会话在私有闭包中已解锁的 Mini App 45 分钟认证令牌。
 *
 * @returns 64 位十六进制会话令牌；未解锁或已过期时清除本地凭据并返回空字符串
 */
export function readMiniAppSessionToken(): string {
  if (activeSessionToken.length === 0) {
    return "";
  }
  if (activeSessionExpiresAt <= Date.now()) {
    clearMiniAppSessionToken();
    return "";
  }
  return activeSessionToken;
}

/**
 * 获取当前会话对应的不可导出 Web Crypto `AES-GCM` `CryptoKey`（仅存在模块私有闭包与 IndexedDB 中）；
 * 若内存未初始化则先尝试从 `sessionStorage` + IndexedDB 异步恢复，无有效会话或密钥时返回 `null`。
 *
 * @returns 已导入或已恢复的不可导出 `CryptoKey`；无有效会话时返回 `null`
 */
export async function getMiniAppSessionCryptoKey(): Promise<CryptoKey | null> {
  if (activeSessionToken.length === 0) {
    await hydrateMiniAppSessionFromStorage();
  }
  if (readMiniAppSessionToken().length === 0 || activeSessionCryptoKeyPromise === null) {
    return null;
  }
  if (activeSessionCryptoKeyResolved !== null) {
    return activeSessionCryptoKeyResolved;
  }
  const expectedGeneration: number = sessionGeneration;
  const key: CryptoKey | null = await activeSessionCryptoKeyPromise;
  if (
    key === null ||
    expectedGeneration !== sessionGeneration ||
    readMiniAppSessionToken().length === 0
  ) {
    return null;
  }
  return key;
}

/**
 * 判断当前是否已持有活跃的不可导出 `CryptoKey`（同步检查内存导入/水合句柄是否就绪）。
 * @returns 已持有有效 `CryptoKey` 句柄时返回 `true`。
 */
export function hasMiniAppSessionCryptoKey(): boolean {
  return (
    readMiniAppSessionToken().length > 0 &&
    (activeSessionCryptoKeyResolved !== null || activeSessionCryptoKeyPromise !== null)
  );
}

/**
 * 读取当前浏览器会话已解锁的 Mini App 45 分钟认证令牌到期毫秒时间戳。
 *
 * @returns 到期毫秒时间戳；未解锁或已过期时返回 `0`
 */
export function readMiniAppSessionExpiresAt(): number {
  if (readMiniAppSessionToken().length === 0) {
    return 0;
  }
  return activeSessionExpiresAt;
}

/**
 * 保存当前浏览器会话已解锁的 Mini App 45 分钟认证令牌，并将新签发/轮换的 256-bit 会话密钥
 * 立即导入为不可导出 Web Crypto `AES-GCM` `CryptoKey` 存入模块私有闭包与 IndexedDB；
 * 仅将 `{ token, expiresAt }` 写入 `sessionStorage`，绝不在任何存储介质或全局对象保留明文密钥。
 *
 * @param token 服务端签发的 64 位十六进制会话令牌
 * @param expiresAt 会话到期毫秒时间戳（缺省按当前时刻加 `MINI_APP_SESSION_TTL_MS` 计算）
 * @param sessionKey 登录或轮换下发的 64 位十六进制会话密钥；缺省时仅当 `token` 与当前活跃会话一致才沿用当前 `CryptoKey`
 */
export function setMiniAppSessionToken(
  token: string,
  expiresAt?: number,
  sessionKey?: string
): void {
  const trimmedToken: string = token.trim();
  if (!MINI_APP_SHA256_HEX_PATTERN.test(trimmedToken)) {
    clearMiniAppSessionToken();
    return;
  }
  const resolvedExpiresAt: number = resolveSessionExpiresAt(expiresAt);

  if (sessionKey !== undefined) {
    const normalizedKey: string = sessionKey.trim().toLowerCase();
    if (!isValidMiniAppHexKey(normalizedKey)) {
      clearMiniAppSessionToken();
      return;
    }
    const generation: number = beginSessionGeneration(trimmedToken, resolvedExpiresAt);
    activeSessionCryptoKeyResolved = null;
    activeSessionCryptoKeyPromise = importMiniAppAesGcmKey(normalizedKey)
      .then((cryptoKey: CryptoKey): CryptoKey | null => {
        if (generation !== sessionGeneration) {
          return null;
        }
        activeSessionCryptoKeyResolved = cryptoKey;
        void persistMiniAppSessionKey(trimmedToken, cryptoKey);
        return cryptoKey;
      })
      .catch((_error: unknown): null => {
        if (generation === sessionGeneration) {
          clearMiniAppSessionToken();
        }
        return null;
      });
    return;
  }

  if (
    trimmedToken !== activeSessionToken ||
    (activeSessionCryptoKeyResolved === null && activeSessionCryptoKeyPromise === null)
  ) {
    clearMiniAppSessionToken();
    return;
  }
  activeSessionExpiresAt = resolvedExpiresAt;
  clearPendingMiniAppAuthHandshake();
  writeSessionMetadataToStorage(trimmedToken, resolvedExpiresAt);
}

/**
 * 将已持有的内存 `CryptoKey` 句柄按预检确认后的同一活跃令牌与新到期时刻重新写入闭包与持久化存储（不含任何明文密钥）。
 * @param token 服务端预检确认有效的 64 位十六进制会话令牌。
 * @param expiresAt 服务端同步换算后的本机到期毫秒时间戳。
 * @param cryptoKey 本机原先持有的不可导出 `AES-GCM` `CryptoKey`。
 */
export function restoreMiniAppSessionCryptoKey(
  token: string,
  expiresAt: number,
  cryptoKey: CryptoKey
): void {
  const trimmedToken: string = token.trim();
  if (!MINI_APP_SHA256_HEX_PATTERN.test(trimmedToken)) {
    clearMiniAppSessionToken();
    return;
  }
  beginSessionGeneration(trimmedToken, resolveSessionExpiresAt(expiresAt));
  activeSessionCryptoKeyResolved = cryptoKey;
  activeSessionCryptoKeyPromise = Promise.resolve(cryptoKey);
  void persistMiniAppSessionKey(trimmedToken, cryptoKey);
}

/**
 * 清除模块私有闭包、`sessionStorage`（及任何历史 `localStorage` 残留）和 IndexedDB 中保存的认证令牌、到期时间与 `CryptoKey` 句柄。
 */
export function clearMiniAppSessionToken(): void {
  sessionGeneration += 1;
  activeHydrationPromise = null;
  activeSessionToken = "";
  activeSessionExpiresAt = 0;
  activeSessionCryptoKeyResolved = null;
  activeSessionCryptoKeyPromise = null;
  clearPendingMiniAppAuthHandshake();
  const tgWindow: TelegramWindow = globalThis;
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
  void clearPersistedMiniAppSessionKey();
}
