import type { Bot } from "grammy";
import { getBotMiniAppConfig, SUPER_ADMIN_USER_ID } from "../config/bot";
import { MINI_APP_BUTTON_TEXT } from "../consts/miniApp";
import { chatAtmosphere } from "../infra/atmosphere";
import { logger } from "../infra/logger";
import { configureSuperAdminMenuButton } from "../infra/telegram/actions/miniApp";
import type { BotMiniAppConfig } from "../types/config";

/**
 * 向 Telegram 注册所有群聊作用域的命令菜单（文案取自 infra/atmosphere.ts），
 * 注册成功后清除默认作用域；若已配置 `mini_app` 则同步为超级管理员私聊设置 `web_app` 菜单按钮。
 * 注册失败记录错误日志并保留已有默认作用域，不阻断启动。
 * @param bot 待注册命令菜单的 grammY Bot 实例。
 */
export async function registerCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(chatAtmosphere().BOT_COMMANDS, { scope: { type: "all_group_chats" } });
    await bot.api.deleteMyCommands();
    const miniAppConfig: Readonly<BotMiniAppConfig> | undefined = getBotMiniAppConfig();
    if (miniAppConfig !== undefined && typeof bot.api.setChatMenuButton === "function") {
      await configureSuperAdminMenuButton({
        superAdminUserId: SUPER_ADMIN_USER_ID,
        buttonText: MINI_APP_BUTTON_TEXT,
        webAppUrl: miniAppConfig.url,
        api: bot.api,
      });
    }
  } catch (error: unknown) {
    logger.error("Failed to register bot commands menu:", error);
  }
}
