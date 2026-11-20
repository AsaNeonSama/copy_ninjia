import {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppInFlightHandshakeIds,
} from "../../cache/main/miniApp";
import {
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_MAX,
  MINI_APP_SESSION_MAX_LIFETIME_MS,
  MINI_APP_SESSION_REFRESH_MAX_MS,
  MINI_APP_SESSION_REFRESH_MIN_MS,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../../consts/miniApp/auth";
import {
  MINI_APP_SESSION_KEY_BYTES,
  MINI_APP_SESSION_KEY_HEADER,
  MINI_APP_SESSION_LINEAGE_ID_BYTES,
} from "../../consts/miniAppCrypto";
import { logger } from "../../infra/logger";
import type { MiniAppAuthSession } from "../../types/miniApp/auth";
import {
  generateMiniAppRandomHex,
  importMiniAppAesGcmKey,
} from "../libs/crypto";
import {
  clearAllMiniAppGalleryDownloadTickets,
  revokeMiniAppGalleryDownloadTicketsForSession,
} from "./downloadTicket";
import {
  findLiveMiniAppSessionByLineage,
  findMiniAppAuthSessionMatch,
  purgeExpiredAuthSessions,
} from "./sessionLookup";
import type { MatchedMiniAppAuthSession } from "./sessionLookup";

/**
 * 在 `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]`（5 秒～5 分钟）闭区间内均匀随机采样本代临时密钥的轮换冷却毫秒数（采用无取模偏差的拒绝采样）。
 * @returns 随机采样得到的毫秒延迟。
 */
export function sampleMiniAppSessionRefreshDelayMs(): number {
  const span: number =
    MINI_APP_SESSION_REFRESH_MAX_MS - MINI_APP_SESSION_REFRESH_MIN_MS + 1;
  const range: number = 0x1_0000_0000;
  const limit: number = range - (range % span);
  const randomWord: Uint32Array<ArrayBuffer> = new Uint32Array(1);
  let value: number = limit;
  while (value >= limit) {
    crypto.getRandomValues(randomWord);
    value = randomWord[0]!;
  }
  return MINI_APP_SESSION_REFRESH_MIN_MS + (value % span);
}

/**
 * 清除会话记录上仅用于首次登录响应序列化的明文临时密钥缓冲字段。
 * @param sessionToken 待清除缓冲密钥的当前会话令牌。
 */
export function clearPendingMiniAppSessionKey(sessionToken: string): void {
  const existing: Readonly<MiniAppAuthSession> | undefined =
    miniAppAuthSessions.get(sessionToken);
  if (existing?.pendingSessionKey === undefined) {
    return;
  }
  miniAppAuthSessions.set(sessionToken, {
    ...existing,
    pendingSessionKey: undefined,
  });
}

/**
 * 清空全部已登录会话、临时密钥、下载票据及尚未消费的临时 X25519 登录握手记录（登录连续失败锁定或服务停止时调用）。
 */
export function clearAllMiniAppAuthSessions(): void {
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppInFlightHandshakeIds.clear();
  clearAllMiniAppGalleryDownloadTickets();
}

/**
 * 吊销请求携带的二次认证会话及其 256-bit 临时密钥（按内部谱系同步吊销关联下载票据）：按当前令牌或宽限期内的 `previousToken` 定位会话并整条删除。
 * @param sessionToken 待吊销的 64 位十六进制会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 找到并删除了会话时返回 `true`。
 */
export function revokeMiniAppAuthSession(
  sessionToken: string,
  nowMs: number = Date.now()
): boolean {
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) return false;
  purgeExpiredAuthSessions(nowMs);
  const match: Readonly<MatchedMiniAppAuthSession> | null =
    findMiniAppAuthSessionMatch(sessionToken, nowMs);
  if (match === null) return false;
  miniAppAuthSessions.delete(match.session.token);
  revokeMiniAppGalleryDownloadTicketsForSession(match.session.lineageId);
  return true;
}

/**
 * 按内部谱系标识吊销对应的二次认证会话及其 256-bit 临时密钥（同步吊销关联下载票据）。
 * @param lineageId 待吊销的会话内部谱系标识。
 * @param nowMs 当前毫秒时间戳。
 * @returns 找到并删除了会话时返回 `true`。
 */
export function revokeMiniAppAuthSessionByLineage(
  lineageId: string,
  nowMs: number = Date.now()
): boolean {
  if (lineageId.length === 0) return false;
  purgeExpiredAuthSessions(nowMs);
  const liveSession: Readonly<MiniAppAuthSession> | undefined =
    findLiveMiniAppSessionByLineage(lineageId, nowMs);
  if (liveSession === undefined) {
    revokeMiniAppGalleryDownloadTicketsForSession(lineageId);
    return false;
  }
  miniAppAuthSessions.delete(liveSession.token);
  revokeMiniAppGalleryDownloadTicketsForSession(lineageId);
  return true;
}

/**
 * 在超级管理员启用、更换或删除 TOTP 验证器后，按内部谱系标识保留发起本次变更的当前会话，吊销其余全部已登录会话及其密钥（含关联下载票据），并清空待用的临时 X25519 登录握手记录。
 * @param keepLineageId 发起本次验证器变更的已提交会话内部谱系标识（空串或未命中时吊销全部会话）。
 * @param nowMs 当前毫秒时间戳。
 */
export function revokeOtherMiniAppAuthSessions(
  keepLineageId: string,
  nowMs: number = Date.now()
): void {
  miniAppAuthHandshakes.clear();
  purgeExpiredAuthSessions(nowMs);
  miniAppAuthSessions.forEach(
    (session: Readonly<MiniAppAuthSession>, token: string): void => {
      if (keepLineageId.length === 0 || session.lineageId !== keepLineageId) {
        miniAppAuthSessions.delete(token);
        revokeMiniAppGalleryDownloadTicketsForSession(session.lineageId);
      }
    }
  );
}

/**
 * 为已轮换续期的响应原地写入最新的 `X-Mini-App-Session`、`X-Mini-App-Session-Expires-At` 及可选加密封装的新会话密钥头 `X-Mini-App-Session-Key`。
 * @param response 业务响应对象。
 * @param session 轮换后的新会话记录。
 * @param sealedSessionKey 由本次请求旧会话密钥 AES-256-GCM 封装的新密钥密文串（`<ivBase64>.<cipherBase64>`）。
 * @returns 写入最新会话凭据响应头后的同一 `Response`。
 */
export function attachRefreshedSessionHeaders(
  response: Response,
  session: Readonly<MiniAppAuthSession>,
  sealedSessionKey?: string
): Response {
  response.headers.set(MINI_APP_SESSION_HEADER, session.token);
  response.headers.set(
    MINI_APP_SESSION_EXPIRES_AT_HEADER,
    String(session.expiresAt)
  );
  if (sealedSessionKey !== undefined) {
    response.headers.set(MINI_APP_SESSION_KEY_HEADER, sealedSessionKey);
  }
  return response;
}

/**
 * 签发一条新的 45 分钟二次认证会话与 256-bit 临时密钥并存入主线程缓存：先清理过期项；未过期会话已满 `MINI_APP_SESSION_MAX`（5）时，
 * 先淘汰表中最早端（签发或最近一次轮换距今最久）的会话并吊销其下载票据，再写入新会话。
 * @param nowMs 当前毫秒时间戳。
 * @returns 新签发的会话对象。
 */
export function issueMiniAppAuthSession(
  nowMs: number = Date.now()
): Readonly<MiniAppAuthSession> {
  purgeExpiredAuthSessions(nowMs);
  if (miniAppAuthSessions.size >= MINI_APP_SESSION_MAX) {
    const oldestToken: string | undefined = miniAppAuthSessions.oldestKey();
    if (oldestToken !== undefined) {
      const oldestSession: Readonly<MiniAppAuthSession> | undefined =
        miniAppAuthSessions.get(oldestToken);
      miniAppAuthSessions.delete(oldestToken);
      if (oldestSession !== undefined) {
        revokeMiniAppGalleryDownloadTicketsForSession(oldestSession.lineageId);
      }
      logger.operation("[MiniApp] auth.sessionEvicted", { reason: "sessionLimit" });
    }
  }
  const token: string = generateMiniAppRandomHex(MINI_APP_SESSION_KEY_BYTES);
  const sessionKey: string = generateMiniAppRandomHex(MINI_APP_SESSION_KEY_BYTES);
  const absoluteExpiresAt: number = nowMs + MINI_APP_SESSION_MAX_LIFETIME_MS;
  const session: Readonly<MiniAppAuthSession> = {
    lineageId: generateMiniAppRandomHex(MINI_APP_SESSION_LINEAGE_ID_BYTES),
    token,
    previousToken: undefined,
    pendingSessionKey: sessionKey,
    sealedSessionKey: undefined,
    sealedSessionKeyPromise: undefined,
    cryptoKey: importMiniAppAesGcmKey(sessionKey),
    seenRequestIvs: new Set<string>(),
    previousCryptoKey: undefined,
    previousSeenRequestIvs: undefined,
    issuedAt: nowMs,
    createdAt: nowMs,
    nextRefreshAt: nowMs + sampleMiniAppSessionRefreshDelayMs(),
    expiresAt: Math.min(nowMs + MINI_APP_SESSION_TTL_MS, absoluteExpiresAt),
    absoluteExpiresAt,
  };
  miniAppAuthSessions.set(token, session);
  return session;
}
