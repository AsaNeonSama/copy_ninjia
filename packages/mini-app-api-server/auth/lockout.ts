import { miniAppPasswordGuardHolder } from "../../cache/main/miniApp";
import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import { MINUTE_MS } from "../../consts/time";
import type { MiniAppPasswordGuardState } from "../../types/miniApp/auth";
import { accessErrorResponse } from "../libs/response";

/**
 * 查询超级管理员 ID 当前处于 30 分钟登录锁定期的剩余分钟数；未锁定或锁定期已过时清理过期状态并返回 `null`。
 * @param nowMs 当前毫秒时间戳。
 * @returns 剩余锁定分钟数（至少为 `1`），未锁定时返回 `null`。
 */
export function getSuperAdminPasswordLockoutRemainingMinutes(
  nowMs: number = Date.now()
): number | null {
  const guard: Readonly<MiniAppPasswordGuardState> | null =
    miniAppPasswordGuardHolder.current;
  if (guard?.userId !== SUPER_ADMIN_USER_ID || guard.lockedUntil <= 0) {
    return null;
  }
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
