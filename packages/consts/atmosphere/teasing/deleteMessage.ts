import type { CommandTargetMessages } from "../../../types/commands";

/** `/delete_message` 解析目标失败时使用的临时提示。 */
export const DELETE_MESSAGE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget:
    "连要删谁的消息都不说，真是没用♡ 回复目标消息，或者在 /delete_message 后写 @username、用户/频道 id 啦，杂鱼♡",
  invalidUsername: (rawArgument: string): string =>
    `噗，${rawArgument} 既不是合法的 Telegram 用户名，也不是用户/频道 id，连目标都写不对呀，笨蛋♡`,
  unknownUsername: (rawUsername: string): string =>
    `@${rawUsername} 还没被本天才记住哦，乖乖回复 TA 的消息或直接给用户/频道 id 啦，杂鱼♡`,
  conflictingTarget: (rawArgument: string): string =>
    `回复了一个身份又写 ${rawArgument}，到底想删谁的消息呀？说话都说不明白的杂鱼♡`,
  selfTarget: "哈？想让本天才删自己的消息？杂鱼再做一百年梦也不可能啦♡",
};

/** `/delete_message stop` 解析目标失败时使用的临时提示。 */
export const DELETE_MESSAGE_STOP_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget:
    "连要放过谁都不说，真是没用的杂鱼♡ 回复目标消息，或者在 /delete_message stop 后写 @username、用户/频道 id 啦♡",
  invalidUsername: (rawArgument: string): string =>
    `噫，${rawArgument} 既不是合法的 Telegram 用户名，也不是用户/频道 id，这样可停不了哦，笨蛋♡`,
  unknownUsername: (rawUsername: string): string =>
    `@${rawUsername} 还没被本天才记住哦，回复 TA 的消息或直接给用户/频道 id 啦，杂鱼♡`,
  conflictingTarget: (rawArgument: string): string =>
    `回复了一个身份又写 ${rawArgument}，到底想放过谁呀？说清楚一点，杂鱼♡`,
  selfTarget: "哈？本天才的消息又没在删，杂鱼在停什么呢♡",
};
