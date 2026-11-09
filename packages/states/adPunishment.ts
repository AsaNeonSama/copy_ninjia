import type { AdDetectPunishment } from "../types/config";
import type { AdPunishmentAction } from "../types/states/adPunishment";

/**
 * 处罚动作表：由 ad_detect.json 的处罚设置与发送者是否为频道身份决定。
 * - 移出且封禁范围为 `global`：用户与频道身份都写入永久黑名单并在全部受管群封禁；
 * - 其余设置遇到频道身份：频道身份无法禁言或移出，只删除消息；
 * - 禁言：在触发群禁言（时长或永久）；
 * - 移出：封禁范围为 `chat` 时只在触发群封禁，未开启封禁时只踢不封。
 * @param punishment 当前生效的处罚设置。
 * @param isChannel 发送者是否为频道或匿名管理员身份。
 * @returns 本次命中应执行的处罚动作。
 */
export function resolveAdPunishmentAction(
  punishment: AdDetectPunishment,
  isChannel: boolean
): AdPunishmentAction {
  if (punishment.kind === "kick" && punishment.blockScope === "global") return { kind: "blockGlobal" };
  if (isChannel) return { kind: "deleteOnly" };
  if (punishment.kind === "mute") return { kind: "mute", durationMs: punishment.durationMs };
  return punishment.blockScope === "chat" ? { kind: "banChat" } : { kind: "kick" };
}
