import { miniAppAuthSessions, miniAppPasswordGuardHolder } from "../../cache/main/miniApp";
import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_REFRESH_THRESHOLD_MS,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../../consts/miniApp";
import type { MiniAppAuthSession, MiniAppPasswordGuardState } from "../../types/miniApp";
import { accessErrorResponse } from "../libs/response";

/**
 * 清理已超过 45 分钟有效期的密码认证会话。
 * @param nowMs 当前毫秒时间戳。
 */
export function purgeExpiredAuthSessions(nowMs: number): void {
  for (const [token, session] of miniAppAuthSessions) {
    if (session.expiresAt <= nowMs) {
      miniAppAuthSessions.delete(token);
    }
  }
}

/**
 * 按当前会话令牌或尚在 5 分钟并发宽限期内的上一轮旧令牌查找有效密码认证会话。
 * @param token 待核验的 64 位十六进制会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 仍在有效期内的会话记录；未命中或已过期时返回 `null`。
 */
function findMiniAppAuthSession(
  token: string,
  nowMs: number
): Readonly<MiniAppAuthSession> | null {
  const direct: Readonly<MiniAppAuthSession> | undefined =
    miniAppAuthSessions.get(token);
  if (direct !== undefined) {
    return direct.expiresAt > nowMs ? direct : null;
  }
  for (const session of miniAppAuthSessions.values()) {
    if (
      session.previousToken === token &&
      session.expiresAt > nowMs &&
      nowMs - session.createdAt <= MINI_APP_SESSION_REFRESH_THRESHOLD_MS
    ) {
      return session;
    }
  }
  return null;
}

/**
 * 判断给定的会话令牌在当前时刻是否对应一条仍在有效期内的密码认证会话（含刷新后 5 分钟宽限期内的上一轮令牌）。
 * @param sessionToken 待核验的 64 位十六进制会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 会话存在且未过期时返回 `true`。
 */
export function hasActiveMiniAppAuthSession(
  sessionToken: string,
  nowMs: number = Date.now()
): boolean {
  purgeExpiredAuthSessions(nowMs);
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) return false;
  return findMiniAppAuthSession(sessionToken, nowMs) !== null;
}

/**
 * 核验请求携带的密码认证会话令牌（支持刷新后 5 分钟宽限期内的上一轮令牌 `previousToken`）；
 * 若会话仍在有效期内且距签发时刻（`createdAt`）已超过 5 分钟（`MINI_APP_SESSION_REFRESH_THRESHOLD_MS`），
 * 则删除旧键、签发新令牌插到最新端并将有效期顺延 45 分钟（`nowMs + MINI_APP_SESSION_TTL_MS`），同时将原令牌保存在 `previousToken` 中以兼容并发在途请求。
 * @param sessionToken 请求携带的 64 位十六进制会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 有效（或已刷新续期）的会话记录；缺失或已过期时返回 `null`。
 */
export function resolveAndRefreshMiniAppAuthSession(
  sessionToken: string,
  nowMs: number = Date.now()
): Readonly<MiniAppAuthSession> | null {
  purgeExpiredAuthSessions(nowMs);
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) return null;
  const session: Readonly<MiniAppAuthSession> | null =
    findMiniAppAuthSession(sessionToken, nowMs);
  if (session === null) return null;
  if (nowMs - session.createdAt <= MINI_APP_SESSION_REFRESH_THRESHOLD_MS) {
    return session;
  }
  const tokenBytes: Uint8Array = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const newToken: string = tokenBytes.toHex();
  const refreshed: Readonly<MiniAppAuthSession> = {
    token: newToken,
    previousToken: session.token,
    createdAt: nowMs,
    expiresAt: nowMs + MINI_APP_SESSION_TTL_MS,
  };
  miniAppAuthSessions.delete(session.token);
  miniAppAuthSessions.set(newToken, refreshed);
  return refreshed;
}

/**
 * 为已触发会话令牌刷新的响应原地写入最新的 `X-Mini-App-Session` 与 `X-Mini-App-Session-Expires-At` 响应头。
 * @param response 业务响应对象。
 * @param session 刷新后的新会话记录。
 * @returns 写入最新会话凭据响应头后的同一 `Response`。
 */
export function attachRefreshedSessionHeaders(
  response: Response,
  session: Readonly<MiniAppAuthSession>
): Response {
  response.headers.set(MINI_APP_SESSION_HEADER, session.token);
  response.headers.set(
    MINI_APP_SESSION_EXPIRES_AT_HEADER,
    String(session.expiresAt)
  );
  return response;
}

/**
 * 检查超级管理员 ID 当前是否因密码连续输错达到 3 次而处于 30 分钟禁止访问锁定期。
 * @param request HTTP 请求对象。
 * @param nowMs 当前毫秒时间戳。
 * @returns 处于锁定期时返回 403 `Response`，未锁定或已过锁定期时返回 `null`。
 */
export function checkSuperAdminPasswordLockout(
  request: Request,
  nowMs: number = Date.now()
): Response | null {
  const guard: Readonly<MiniAppPasswordGuardState> | null = miniAppPasswordGuardHolder.current;
  if (guard?.userId !== SUPER_ADMIN_USER_ID || guard.lockedUntil <= 0) return null;
  if (guard.lockedUntil <= nowMs) {
    miniAppPasswordGuardHolder.current = null;
    return null;
  }
  const remainingMinutes: number = Math.max(1, Math.ceil((guard.lockedUntil - nowMs) / 60_000));
  return accessErrorResponse(request, {
    status: 403,
    code: "PASSWORD_LOCKED",
    reason: "password_locked",
    error: "PASSWORD_LOCKED",
    remainingMinutes,
  });
}

/**
 * 签发一条新的 45 分钟密码认证会话令牌并存入主线程缓存。
 * @param nowMs 当前毫秒时间戳。
 * @returns 新签发的会话对象。
 */
export function issueMiniAppAuthSession(
  nowMs: number = Date.now()
): Readonly<MiniAppAuthSession> {
  purgeExpiredAuthSessions(nowMs);
  const tokenBytes: Uint8Array = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token: string = tokenBytes.toHex();
  const session: Readonly<MiniAppAuthSession> = {
    token,
    previousToken: undefined,
    createdAt: nowMs,
    expiresAt: nowMs + MINI_APP_SESSION_TTL_MS,
  };
  miniAppAuthSessions.set(token, session);
  return session;
}
