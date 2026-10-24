import { abuseMarkedUsers } from "../cache/main/aiChat";
import { ABUSE_MARK_DURATION_MS, ABUSE_MARK_MAX_USERS } from "../consts/aiChat/rateLimit";

/**
 * 标记指定用户在 ABUSE_MARK_DURATION_MS 内不再进入 AI 闲聊。
 * 每个条目拥有独立的单次到期定时器（不做轮扫）；重复标记时重置定时器并移到 FifoMap 最新端，
 * 满 ABUSE_MARK_MAX_USERS 时先清理最早插入项的定时器并淘汰。
 * @param userId 被标记为滥用的 Telegram 用户 ID。
 */
export function markAbuseUser(userId: number): void {
  const existingTimer: ReturnType<typeof setTimeout> | undefined = abuseMarkedUsers.get(userId);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
    abuseMarkedUsers.delete(userId);
  } else if (abuseMarkedUsers.size >= ABUSE_MARK_MAX_USERS) {
    const oldestUserId: number | undefined = abuseMarkedUsers.oldestKey();
    if (oldestUserId !== undefined) {
      clearTimeout(abuseMarkedUsers.get(oldestUserId));
      abuseMarkedUsers.delete(oldestUserId);
    }
  }
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    if (abuseMarkedUsers.get(userId) === timer) {
      abuseMarkedUsers.delete(userId);
    }
  }, ABUSE_MARK_DURATION_MS);
  timer.unref();
  abuseMarkedUsers.set(userId, timer);
}

/**
 * 判定指定用户当前是否处于 abuse_mark 冷却期。
 * @param userId 待检查的 Telegram 用户 ID。
 * @returns 处于冷却期时返回 `true`，否则返回 `false`。
 */
export function isAbuseMarkedUser(userId: number): boolean {
  return abuseMarkedUsers.has(userId);
}

/** 取消并清空全部 abuse_mark 定时器与标记记录（用于停机清理）。 */
export function clearAbuseMarkedUsers(): void {
  abuseMarkedUsers.forEach((timer: ReturnType<typeof setTimeout>): void => {
    clearTimeout(timer);
  });
  abuseMarkedUsers.clear();
}
