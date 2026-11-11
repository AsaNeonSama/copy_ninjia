/**
 * 黑名单成员同步查询、增删与跨群处置的目标群清单，参见 docs/cn/04-invariants.md；
 * 逐群封禁与解封见 ./crossChatBan.ts。
 */

import { formatLocalTime } from "../../libs/time";
import { getChatStateCache } from "../chatStateStorage";
import { isManagedAdminChat } from "./sweepEligibility";
import { logger } from "../logger";
import { forgetUserBlocklistRemovals } from "./outbox";
import {
  cachedBlocklistEntry,
  confirmIdentityPolicyPersisted,
  prefetchIdentityPolicies,
  queueBlocklistDeletion,
  queueIdentityPolicyWrite,
} from "../identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../consts/paths";
import { clearTemporaryAdBypassActivityOrThrow } from
  "../identityPolicy/temporaryAdBypass";
import type { TelegramIdentityMetadata } from "../../types/identityPolicy";

/**
 * 生成跨群处置的目标群 ID 列表：isAdminHere 为真时发起群排在最前，随后追加其余已启用 `/init` 且机器人为管理员的受管群。
 *
 * @param chatId 发起本次操作的当前群 ID。
 * @param isAdminHere 机器人在当前发起群是否已具备受管管理员身份。
 * @returns 待执行跨群处置的目标受管群 ID 列表。
 */
export function managedAdminChatIds(chatId: number, isAdminHere: boolean): number[] {
  const targetChatIds: number[] = isAdminHere ? [chatId] : [];
  for (const [adminChatId, chatState] of getChatStateCache()) {
    if (adminChatId !== chatId && isManagedAdminChat(chatState)) targetChatIds.push(adminChatId);
  }
  return targetChatIds;
}

/**
 * 同步判断指定用户或频道身份是否在黑名单缓存中（未命中按不在名单处理）。
 *
 * @param userId 待检查的用户或频道身份 ID。
 * @returns 命中黑名单缓存时返回 `true`，未命中时返回 `false`。
 */
export function isUserBlocked(userId: number): boolean {
  return cachedBlocklistEntry(userId) !== undefined;
}

/**
 * 启动阶段校验配置的超级管理员不在黑名单中，违反时抛出致命错误。
 *
 * @param superAdminUserId 配置的超级管理员用户 ID。
 */
export async function assertSuperAdminNotBlocked(
  superAdminUserId: number
): Promise<void> {
  if (!await prefetchIdentityPolicies([superAdminUserId])) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}: blocklist_entries could not be read; ` +
      "refusing to start without confirming the super admin is absent from it."
    );
  }
  if (cachedBlocklistEntry(superAdminUserId) === undefined) return;
  throw new Error(
    `${IDENTITY_DATABASE_PATH}: blocklist_entries must not contain the configured ` +
    `super admin identity ${superAdminUserId}; expected the two sets to stay disjoint.`
  );
}

/**
 * 将指定身份加入黑名单并清理其临时广告免检进度，参见 docs/cn/04-invariants.md；已存在时返回 false。
 *
 * @param userId 待拉黑的用户或频道身份 ID。
 * @param meta 被拉黑身份的 Telegram 展示元数据。
 * @returns 本次新增拉黑并入队持久化时返回 `true`；已在黑名单中时返回 `false`。
 */
export function blockUser(
  userId: number,
  meta: Readonly<TelegramIdentityMetadata>
): boolean {
  if (isUserBlocked(userId)) return false;
  const blockedAt: string = formatLocalTime(Date.now());
  clearTemporaryAdBypassActivityOrThrow(userId);
  queueIdentityPolicyWrite("blocklist", userId, { blockedAt, meta });
  return true;
}

/**
 * 等待指定身份当前未确认的黑名单变更落盘（retryUnacknowledged 为真时先补投未确认变更）。
 *
 * @param userId 待确认落盘的用户或频道身份 ID。
 * @param retryUnacknowledged 为 `true` 时先向 Disk I/O Worker 补投尚未成功投递的变更。
 * @returns 落盘确认成功时返回 `true`，落盘失败并记录错误日志后返回 `false`。
 */
export async function confirmBlocklistPersisted(
  userId: number,
  retryUnacknowledged: boolean
): Promise<boolean> {
  try {
    await confirmIdentityPolicyPersisted("blocklist", userId, retryUnacknowledged);
    return true;
  } catch (error: unknown) {
    logger.error("Blocklist entry was not persisted to disk:", error);
    return false;
  }
}

/**
 * 从黑名单移除指定身份并同步裁剪待踢 outbox 中的关联任务；原本不在名单中时返回 false。
 *
 * @param userId 待解除拉黑的用户或频道身份 ID。
 * @returns 原本在黑名单中且已入队删除时返回 `true`，原本不在名单中时返回 `false`。
 */
export function unblockUser(userId: number): boolean {
  if (cachedBlocklistEntry(userId) === undefined) return false;
  queueBlocklistDeletion(userId, (): void => forgetUserBlocklistRemovals(userId));
  return true;
}
