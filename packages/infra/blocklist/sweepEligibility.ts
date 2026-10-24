/**
 * 黑名单补扫的群受管状态与 claim 槽位资格纯判定，参见 docs/cn/04-invariants.md。
 */

import type { BlocklistSweepRecord } from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";

/**
 * 判断群是否已启用 `/init` 且已确证机器人具备管理员身份。
 *
 * @param chatState 群状态快照；未命中群状态缓存时为 `undefined`。
 * @returns 已启用 `/init` 且机器人具备管理员身份时返回 `true`，否则返回 `false`。
 */
export function isManagedAdminChat(chatState: ChatState | undefined): boolean {
  return chatState?.isInitEnabled === true &&
    chatState.botPermissions?.isAdministrator === true;
}

/**
 * 判断补扫槽位是否空闲（未完成本轮、无在途任务且未被权限闩锁阻塞）。
 *
 * @param progress 群的黑名单补扫进度记录。
 * @returns 补扫槽位空闲可认领时返回 `true`，否则返回 `false`。
 */
export function isSweepSlotFree(progress: BlocklistSweepRecord): boolean {
  return progress.sweptAt === null &&
    progress.removalId === null &&
    !progress.permissionBlocked;
}

/**
 * 判断群在指定时刻是否可建立新的补扫 claim（无记录或槽位空闲且已到退避截止时刻）。
 *
 * @param progress 群的黑名单补扫进度记录；尚未建立记录时为 `undefined`。
 * @param now 当前毫秒时间戳。
 * @returns 可建立新的补扫 claim 时返回 `true`，否则返回 `false`。
 */
export function canClaimSweep(
  progress: BlocklistSweepRecord | undefined,
  now: number
): boolean {
  return progress === undefined ||
    (isSweepSlotFree(progress) && now >= progress.nextRetryAt);
}
