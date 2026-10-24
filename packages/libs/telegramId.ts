import { CHAT_ID_ARG_PATTERN, USER_ID_ARG_PATTERN } from "../consts/commands";

/**
 * Telegram 群与频道 ID 的共享领域判定。私聊用户 ID 为正数，群、超级群与
 * 频道 ID 为负数；持久化的群级状态不得把两者混用。
 * @param value 待判定的未知值。
 * @returns 为负安全整数时返回 true，否则返回 false。
 */
export function isTelegramGroupChatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value < 0;
}

/**
 * 把字符串解析成 Telegram 用户 id（规范十进制正安全整数）；不合法时返回 undefined。
 *
 * 在 USER_ID_ARG_PATTERN 之外再要求转换结果是安全整数，超出安全整数的十进制串返回
 * undefined。
 *
 * 命令参数（commands/targetResolution.ts）、callback_data（antiRaid/updateIngress.ts
 * 的入群验证按钮、commands/wed.ts 的 `/wed` 按钮）与 gag 的 inline 查询、隐藏
 * 校验链接共用这一道判定，只接受规范十进制写法。往返比对另见 libs/verificationKey.ts。
 * @param argument 待解析的用户 ID 字符串参数。
 * @returns 解析出的正安全整数用户 ID；形态非法或溢出时返回 undefined。
 */
export function parseUserIdArgument(argument: string): number | undefined {
  if (!USER_ID_ARG_PATTERN.test(argument)) return undefined;
  const userId: number = Number(argument);
  return Number.isSafeInteger(userId) ? userId : undefined;
}

/**
 * 把字符串解析成 Telegram 会话 id（频道/群的规范十进制负安全整数）；不合法时返回
 * undefined。安全整数判定同 parseUserIdArgument，方向为负。解析结果由
 * commands/send.ts 用来开持久代发会话。
 * @param argument 待解析的群或频道 ID 字符串参数。
 * @returns 解析出的负安全整数会话 ID；形态非法或溢出时返回 undefined。
 */
export function parseChatIdArgument(argument: string): number | undefined {
  if (!CHAT_ID_ARG_PATTERN.test(argument)) return undefined;
  const chatId: number = Number(argument);
  return Number.isSafeInteger(chatId) ? chatId : undefined;
}
