import { telegramApi } from "../../infra/telegram";
import { logger } from "../../infra/logger";
import { ADMIN_CACHE_TTL_MS } from "../../consts/antiRaid/cache";
import {
  bufferAdminChangeDuringFetch,
  cacheAdminIds,
  chatAdmins,
  adminFetches,
  pendingAdminChangesDuringFetch,
  takePendingAdminChanges,
} from "../../cache/workers/antiRaid/admins";
import type { ChatAdminCache } from "../../types/antiRaid/internal";
import type { ChatMemberAdministrator, ChatMemberOwner } from "grammy/types";
import { trackAntiRaidTask } from "./taskTracker";
import { isRecordedWithin } from "../../libs/clockWindow";
import { getOrCreateKeyedTask } from "../../libs/keyedTask";

/**
 * 各群非匿名管理员缓存：按需全量拉取、TTL 缓存，并在拉取在途期间重放增量变更。
 * 匿名管理员与机器人不进入缓存。
 */

/** 未过期的某群非匿名管理员 ID 集合；缺失或过期时返回 undefined。 */
export function freshAdminIds(chatId: number, now: number = Date.now()): Set<number> | undefined {
  const cached: ChatAdminCache | undefined = chatAdmins.get(chatId);
  if (!cached || !isRecordedWithin(cached.fetchedAt, now, ADMIN_CACHE_TTL_MS)) return undefined;
  return cached.adminIds;
}

/** 全量拉取某群非匿名管理员并写入缓存（同群并发请求去重复用）。 */
export function fetchAdminIds(chatId: number): Promise<Set<number>> {
  const inFlight: Promise<Set<number>> = getOrCreateKeyedTask(adminFetches, chatId, (): Promise<Set<number>> =>
    telegramApi
      .getChatAdministrators(chatId)
      .then((admins: (ChatMemberOwner | ChatMemberAdministrator)[]): Set<number> => {
        const adminIds: Set<number> = new Set();
        for (const admin of admins) {
          if (admin.is_anonymous !== true && admin.user.is_bot !== true) adminIds.add(admin.user.id);
        }
        // 槽位已被移除或替换时只把结果交给等待者，不写回缓存。
        if (adminFetches.get(chatId) !== inFlight) return adminIds;
        const pending: Map<number, boolean> | undefined = takePendingAdminChanges(chatId);
        if (pending) {
          for (const [userId, isInviterExempt] of pending) {
            if (isInviterExempt) adminIds.add(userId);
            else adminIds.delete(userId);
          }
        }
        cacheAdminIds(chatId, adminIds);
        return adminIds;
      })
      .catch((error: unknown): never => {
        if (adminFetches.get(chatId) === inFlight) pendingAdminChangesDuringFetch.delete(chatId);
        throw error;
      })
  );
  return trackAntiRaidTask({ task: inFlight });
}

/**
 * 核查目标此刻是否为本群管理员：优先读有效缓存，未命中再拉取全量列表。
 *
 * @param context 失败日志使用的英文处置名。
 * @returns true=确认是管理员；false=确认不是；undefined=查询失败。
 */
export async function isChatAdmin(
  chatId: number,
  userId: number,
  context: string
): Promise<boolean | undefined> {
  const cached: Set<number> | undefined = freshAdminIds(chatId);
  if (cached !== undefined) return cached.has(userId);
  try {
    return (await fetchAdminIds(chatId)).has(userId);
  } catch (error: unknown) {
    logger.error(`Failed to check admin exemption for ${context} ${userId} in chat ${chatId}:`, error);
    return undefined;
  }
}

/** 应用一条非匿名管理员邀请豁免资格变更；拉取在途时同步记入增量缓冲。 */
export function applyAdminChange(chatId: number, userId: number, isInviterExempt: boolean): void {
  bufferAdminChangeDuringFetch(chatId, userId, isInviterExempt);
  const cached: ChatAdminCache | undefined = chatAdmins.get(chatId);
  if (!cached) return;
  if (isInviterExempt) {
    cached.adminIds.add(userId);
  } else {
    cached.adminIds.delete(userId);
  }
}
