/** owner: main。Bot-to-Bot 发言限流状态（packages/infra/botMessageGate.ts）。 */

import type { BotMessageActivity } from "../../types/botMessage";

/**
 * 收到其他机器人的消息时按发送方 bot ID 填充或续期，到期定时器回调或命中已到期记录时删除。
 * 容量上限为 BOT_MESSAGE_ACTIVITY_MAX_ENTRIES，满额时拒绝登记新身份且不淘汰现有记录；进程重启后从空表开始。
 */
export const botMessageActivity: Map<number, BotMessageActivity> = new Map();
