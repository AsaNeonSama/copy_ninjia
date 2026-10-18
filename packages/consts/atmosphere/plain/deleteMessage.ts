import type { CommandTargetMessages } from "../../../types/commands";

/** `/delete_message` 解析目标失败时使用的临时提示。 */
export const DELETE_MESSAGE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息后发送 /delete_message，或使用 /delete_message <@username|用户/频道 id>。",
  invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户/频道 id。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息或直接提供 id。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能将机器人自身设为此命令的目标。",
};

/** `/delete_message stop` 解析目标失败时使用的临时提示。 */
export const DELETE_MESSAGE_STOP_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息后发送 /delete_message stop，或使用 /delete_message stop <@username|用户/频道 id>。",
  invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户/频道 id。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息或直接提供 id。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能将机器人自身设为此命令的目标。",
};
