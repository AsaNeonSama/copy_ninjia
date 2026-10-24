/**
 * 机器人自身权限位在入群守卫线程侧的读写口。
 *
 * 主线程按变更推送 `botPermissionsChanged`，Worker 重建与进程启动时整表重放（见 packages/antiRaid/workerBridge/replay.ts）。
 * `undefined` 表示尚未确证，仅确证为 `false` 时短路对应管理动作。
 */

import { workerBotChatPermissions } from "../../cache/workers/antiRaid/botPermissions";
import type { BotActionPermissions } from "../../types/telegram";

/**
 * 应用主线程镜像的群权限变更；`permissions` 为 `undefined` 时移除该群条目。
 * @param chatId 群组 ID。
 * @param permissions 机器人在该群的管理权限位；移除条目时为 `undefined`。
 */
export function applyBotPermissionsChange(chatId: number, permissions: BotActionPermissions | undefined): void {
  if (permissions === undefined) {
    workerBotChatPermissions.delete(chatId);
    return;
  }
  workerBotChatPermissions.set(chatId, permissions);
}

/**
 * 读取机器人是否可在该群限制成员（禁言/封禁）。
 * @param chatId 群组 ID。
 * @returns 确证有权限返回 `true`，确证无权限返回 `false`，未观测到返回 `undefined`。
 */
export function botCanRestrictIn(chatId: number): boolean | undefined {
  return workerBotChatPermissions.get(chatId)?.canRestrictMembers;
}

/**
 * 读取机器人是否可在该群删除他人消息；返回值语义同 `botCanRestrictIn`。
 * @param chatId 群组 ID。
 * @returns 确证有权限返回 `true`，确证无权限返回 `false`，未观测到返回 `undefined`。
 */
export function botCanDeleteIn(chatId: number): boolean | undefined {
  return workerBotChatPermissions.get(chatId)?.canDeleteMessages;
}

/** Worker stop/测试隔离时清空整表；重建后由主线程重放。 */
export function resetWorkerBotPermissions(): void {
  workerBotChatPermissions.clear();
}
