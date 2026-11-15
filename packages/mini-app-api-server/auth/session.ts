import { miniAppAuthSessions, miniAppPasswordGuardHolder } from "../../cache/main/miniApp";
import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_REFRESH_THRESHOLD_MS,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../../consts/miniApp";
import { MINUTE_MS } from "../../consts/time";
import type { MiniAppAuthSession, MiniAppPasswordGuardState } from "../../types/miniApp/auth";
import { accessErrorResponse } from "../libs/response";

/**
 * 清理已超过 45 分钟有效期的二次认证会话。
 * @param nowMs 当前毫秒时间戳。
 */
function purgeExpiredAuthSessions(nowMs: number): void {
  if (miniAppAuthSessions.size === 0) {
    return;
  }
  miniAppAuthSessions.forEach(
    (session: Readonly<MiniAppAuthSession>, token: string): void => {
      if (session.expiresAt <= nowMs) {
        miniAppAuthSessions.delete(token);
      }
    }
  );
}

/**
 * 按当前会话令牌或轮换后 5 分钟宽限期内的 `previousToken` 查找未过期的二次认证会话。
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
 * 判断给定的会话令牌在当前时刻是否对应未过期的二次认证会话（含轮换后 5 分钟宽限期内的 `previousToken`）。
 * @param sessionToken 待核验的 64 位十六进制会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 会话存在且未过期时返回 `true`。
 */
export function hasActiveMiniAppAuthSession(
  sessionToken: string,
  nowMs: number = Date.now()
): boolean {
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) return false;
  purgeExpiredAuthSessions(nowMs);
  return findMiniAppAuthSession(sessionToken, nowMs) !== null;
}

/**
 * 核验已通过 `MINI_APP_SHA256_HEX_PATTERN` 格式校验的二次认证会话令牌，并在需要时轮换续期（支持轮换后 5 分钟宽限期内的 `previousToken`）。
 * 若会话未过期且距签发时刻（`createdAt`）超过 `MINI_APP_SESSION_REFRESH_THRESHOLD_MS`（5 分钟），则生成新令牌顺延 45 分钟有效期（`nowMs + MINI_APP_SESSION_TTL_MS`），同时把原令牌存入 `previousToken` 供并发在途请求过渡。
 * @param sessionToken 已通过格式校验的 64 位十六进制会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 有效（或已轮换续期）的会话记录；缺失或已过期时返回 `null`。
 */
export function resolveAndRefreshCheckedMiniAppAuthSession(
  sessionToken: string,
  nowMs: number = Date.now()
): Readonly<MiniAppAuthSession> | null {
  purgeExpiredAuthSessions(nowMs);
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
 * 校验候选二次认证会话令牌的十六进制格式与有效期（支持 5 分钟宽限期内的 `previousToken`），并在距签发超过 5 分钟时轮换续期。
 * @param sessionToken 请求携带的候选会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 有效（或已轮换续期）的会话记录；格式非法、缺失或已过期时返回 `null`。
 */
export function resolveAndRefreshMiniAppAuthSession(
  sessionToken: string,
  nowMs: number = Date.now()
): Readonly<MiniAppAuthSession> | null {
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) return null;
  return resolveAndRefreshCheckedMiniAppAuthSession(sessionToken, nowMs);
}

/**
 * 吊销请求携带的二次认证会话：按当前令牌或 5 分钟宽限期内的 `previousToken` 定位会话并整条删除，
 * 其当前令牌与上一轮令牌一并失效。令牌格式非法、已过期或不存在时无改动。
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
  const session: Readonly<MiniAppAuthSession> | null =
    findMiniAppAuthSession(sessionToken, nowMs);
  if (session === null) return false;
  miniAppAuthSessions.delete(session.token);
  return true;
}

/**
 * 在超级管理员启用、更换或删除 TOTP 验证器后，吊销除发起本次变更的当前会话以外的全部已登录会话，
 * 使旧认证方式或旧密钥时期签发的其余会话立即失效。
 * @param keepSessionToken 发起本次验证器变更的请求所携带的会话令牌（支持 5 分钟宽限期内的 `previousToken`）。
 * @param nowMs 当前毫秒时间戳。
 */
export function revokeOtherMiniAppAuthSessions(
  keepSessionToken: string,
  nowMs: number = Date.now()
): void {
  purgeExpiredAuthSessions(nowMs);
  const activeCallerSession: Readonly<MiniAppAuthSession> | null =
    MINI_APP_SHA256_HEX_PATTERN.test(keepSessionToken)
      ? findMiniAppAuthSession(keepSessionToken, nowMs)
      : null;
  const keepKey: string | undefined = activeCallerSession?.token;
  miniAppAuthSessions.forEach(
    (_session: Readonly<MiniAppAuthSession>, token: string): void => {
      if (token !== keepKey) {
        miniAppAuthSessions.delete(token);
      }
    }
  );
}

/**
 * 为已轮换续期的响应原地写入最新的 `X-Mini-App-Session` 与 `X-Mini-App-Session-Expires-At` 响应头。
 * @param response 业务响应对象。
 * @param session 轮换后的新会话记录。
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
 * 查询超级管理员 ID 当前处于 30 分钟登录锁定期的剩余分钟数；未锁定或锁定期已过时清理过期状态并返回 `null`。
 * @param nowMs 当前毫秒时间戳。
 * @returns 剩余锁定分钟数（至少为 `1`），未锁定时返回 `null`。
 */
export function getSuperAdminPasswordLockoutRemainingMinutes(
  nowMs: number = Date.now()
): number | null {
  const guard: Readonly<MiniAppPasswordGuardState> | null = miniAppPasswordGuardHolder.current;
  if (guard?.userId !== SUPER_ADMIN_USER_ID || guard.lockedUntil <= 0) return null;
  if (guard.lockedUntil <= nowMs) {
    miniAppPasswordGuardHolder.current = null;
    return null;
  }
  return Math.max(1, Math.ceil((guard.lockedUntil - nowMs) / MINUTE_MS));
}

/**
 * 检查超级管理员 ID 当前是否因登录凭据（密码或 TOTP 动态码）连续输错满 3 次而处于 30 分钟锁定期。
 * @param request HTTP 请求对象。
 * @param nowMs 当前毫秒时间戳。
 * @returns 处于锁定期时返回 403 `Response`，未锁定或已过锁定期时返回 `null`。
 */
export function checkSuperAdminPasswordLockout(
  request: Request,
  nowMs: number = Date.now()
): Response | null {
  const remainingMinutes: number | null =
    getSuperAdminPasswordLockoutRemainingMinutes(nowMs);
  if (remainingMinutes === null) return null;
  return accessErrorResponse(request, {
    status: 403,
    code: "PASSWORD_LOCKED",
    reason: "password_locked",
    error: "PASSWORD_LOCKED",
    remainingMinutes,
  });
}

/**
 * 签发一条新的 45 分钟二次认证会话令牌并存入主线程缓存。
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
