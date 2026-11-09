import type { AdDetectPunishment } from "../types/config";
import type { AdPunishmentAction } from "../types/states/adPunishment";

/**
 * 处罚动作表：由 ad_detect_config.json 的处罚等级与发送者是否为频道身份决定。
 * - 等级 2 且封禁范围为 `global`：用户与频道身份都写入永久黑名单并在全部受管群封禁；
 * - 其余等级遇到频道身份：频道身份无法禁言或移出，只删除消息；
 * - 等级 1：在触发群禁言（时长或永久）；
 * - 等级 2：封禁范围为 `chat` 时只在触发群封禁，未开启封禁时只踢不封。
 * @param punishment 当前生效的处罚设置。
 * @param isChannel 发送者是否为频道或匿名管理员身份。
 * @returns 本次命中应执行的处罚动作。
 */
export function resolveAdPunishmentAction(
  punishment: AdDetectPunishment,
  isChannel: boolean
): AdPunishmentAction {
  if (punishment.level === 2 && punishment.blockScope === "global") return { kind: "blockGlobal" };
  if (isChannel) return { kind: "deleteOnly" };
  if (punishment.level === 1) return { kind: "mute", durationMs: punishment.muteDurationMs };
  return punishment.blockScope === "chat" ? { kind: "banChat" } : { kind: "kick" };
}
