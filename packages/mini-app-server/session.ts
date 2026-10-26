import { miniAppAuthSessions, miniAppPasswordGuardHolder } from "../cache/main/miniApp";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import { MINI_APP_PASSWORD_MAX_ATTEMPTS, MINI_APP_SESSION_TTL_MS } from "../consts/miniApp";
import type { MiniAppAuthSession, MiniAppPasswordGuardState } from "../types/miniApp";
import { accessErrorResponse } from "./libs/response";

/**
 * 清理已超过 45 分钟有效期的密码认证会话。
 * @param nowMs 当前毫秒时间戳。
 */
export function purgeExpiredAuthSessions(nowMs: number): void {
  for (const [token, session] of miniAppAuthSessions) {
    if (session.expiresAt <= nowMs) miniAppAuthSessions.delete(token);
  }
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
    error: `密码连续输错已达 ${MINI_APP_PASSWORD_MAX_ATTEMPTS} 次，当前超级管理员 ID (#${SUPER_ADMIN_USER_ID}) 已被锁定，30 分钟内无法访问（剩余约 ${remainingMinutes} 分钟）。`,
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
    createdAt: nowMs,
    expiresAt: nowMs + MINI_APP_SESSION_TTL_MS,
  };
  miniAppAuthSessions.set(token, session);
  return session;
}
