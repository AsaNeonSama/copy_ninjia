import type { Bot } from "grammy";
import { chatAtmosphere } from "../infra/atmosphere";
import { logger } from "../infra/logger";

/**
 * 向 Telegram 注册所有群聊作用域的命令菜单（文案取自 infra/atmosphere.ts），
 * 注册成功后清除默认作用域；注册失败记录错误日志并保留已有默认作用域，不阻断启动。
 * 私聊不注册菜单，私聊命令准入由 infra/updateGate.ts 控制。
 */
export async function registerCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(chatAtmosphere().BOT_COMMANDS, { scope: { type: "all_group_chats" } });
    await bot.api.deleteMyCommands();
  } catch (error: unknown) {
    logger.error("Failed to register bot commands menu:", error);
  }
}
