import { InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import { getBotMiniAppConfig, SUPER_ADMIN_USER_ID } from "../config/bot";
import {
  MINI_APP_BUTTON_TEXT,
  MINI_APP_LAUNCH_PROMPT_TEXT,
  MINI_APP_UNCONFIGURED_NOTICE_TEXT,
} from "../consts/miniApp";
import { replyCommandNotice, sendCommandMessage } from "../infra/telegram";
import { handleMiniAppSharedMessage } from "../miniApp/picker";
import type { BotMiniAppConfig } from "../types/config";

export { handleMiniAppSharedMessage };

/**
 * 超级管理员私聊专属 `/app` 命令：发送带 `web_app` 内联按钮的启动卡片，非私聊或非超级管理员静默忽略。
 *
 * @param ctx grammY 命令上下文
 */
export async function handleAppCommand(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type !== "private") return;
  if (ctx.chat.id !== SUPER_ADMIN_USER_ID || ctx.from?.id !== SUPER_ADMIN_USER_ID) return;

  const miniAppConfig: Readonly<BotMiniAppConfig> | undefined = getBotMiniAppConfig();
  if (miniAppConfig === undefined) {
    await replyCommandNotice(ctx, MINI_APP_UNCONFIGURED_NOTICE_TEXT);
    return;
  }

  const keyboard: InlineKeyboard = new InlineKeyboard().webApp(
    MINI_APP_BUTTON_TEXT,
    miniAppConfig.url
  );
  await sendCommandMessage({
    chatId: ctx.chat.id,
    text: MINI_APP_LAUNCH_PROMPT_TEXT,
    replyToMessageId: ctx.msgId,
    keyboard,
  });
}
