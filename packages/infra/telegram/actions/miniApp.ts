import type {
  ChatFullInfo,
  KeyboardButton,
  PreparedKeyboardButton,
} from "grammy/types";
import { telegramSignal } from "../../../libs/telegramSignal";
import { telegramApi } from "../client";
import { bot } from "../mainClient";
import { runBooleanTelegramAction, runTelegramAction } from "./core";

/** Mini App 专属 Telegram Bot API 调用接口（支持测试注入替身）。 */
export interface MiniAppTelegramApi {
  /** 设置私聊左下角菜单按钮。 */
  readonly setChatMenuButton: typeof bot.api.setChatMenuButton;
  /** 预存供 `Telegram.WebApp.requestChat` 调用的键盘按钮。 */
  readonly savePreparedKeyboardButton: typeof bot.api.savePreparedKeyboardButton;
}

/** `configureSuperAdminMenuButton` 的入参。 */
export interface ConfigureSuperAdminMenuButtonOptions {
  /** 超级管理员的 Telegram 用户 ID（即私聊 `chat_id`）。 */
  readonly superAdminUserId: number;
  /** 菜单按钮上显示的文字。 */
  readonly buttonText: string;
  /** Mini App 的 HTTPS 入口 URL。 */
  readonly webAppUrl: string;
  /** 可选的 Telegram API 替身。 */
  readonly api?: Pick<MiniAppTelegramApi, "setChatMenuButton">;
  /** 可选的取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 为超级管理员与 Bot 的私聊配置左下角 `MenuButtonWebApp` 入口按钮。
 * @param options 超级管理员 ID、按钮文案与 Mini App URL。
 * @returns 设置成功时返回 true，失败时记录 API 错误日志并返回 false。
 */
export function configureSuperAdminMenuButton({
  superAdminUserId,
  buttonText,
  webAppUrl,
  api = bot.api,
  signal,
}: ConfigureSuperAdminMenuButtonOptions): Promise<boolean> {
  return runBooleanTelegramAction(
    `set Mini App menu button for super admin ${superAdminUserId}`,
    (requestSignal?: AbortSignal): Promise<true> =>
      api.setChatMenuButton(
        {
          chat_id: superAdminUserId,
          menu_button: {
            type: "web_app",
            text: buttonText,
            web_app: { url: webAppUrl },
          },
        },
        telegramSignal(requestSignal)
      ),
    signal
  );
}

/** `saveMiniAppPreparedKeyboardButton` 的入参。 */
export interface SaveMiniAppPreparedKeyboardButtonOptions {
  /** 允许使用该预存按钮的目标用户 ID（固定为超级管理员 ID）。 */
  readonly userId: number;
  /** 请求用户或请求频道/群的按钮定义。 */
  readonly button: KeyboardButton.RequestUsersButton | KeyboardButton.RequestChatButton;
  /** 可选的 Telegram API 替身。 */
  readonly api?: Pick<MiniAppTelegramApi, "savePreparedKeyboardButton">;
  /** 可选的取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 调用 Bot API `savePreparedKeyboardButton` 预存用户或频道选择按钮，返回 `prepared_button_id` 供前端 `Telegram.WebApp.requestChat` 拉起原生选择器。
 * @param options 目标用户 ID 与请求按钮配置。
 * @returns 成功时返回 `PreparedKeyboardButton.id`，失败时返回 undefined。
 */
export function saveMiniAppPreparedKeyboardButton({
  userId,
  button,
  api = bot.api,
  signal,
}: SaveMiniAppPreparedKeyboardButtonOptions): Promise<string | undefined> {
  return runTelegramAction<PreparedKeyboardButton, string | undefined>({
    action: `save prepared keyboard button for user ${userId}`,
    execute: (requestSignal?: AbortSignal): Promise<PreparedKeyboardButton> =>
      api.savePreparedKeyboardButton(userId, button, telegramSignal(requestSignal)),
    map: (result: PreparedKeyboardButton): string => result.id,
    fallback: undefined,
    signal,
  });
}

/**
 * 按 ID 查询 Telegram 会话（用户私聊、频道或群）的当前公开资料；查询失败时静默返回 undefined（不记录错误日志，供名单新增时尽力补齐展示名称）。
 * @param targetId 目标用户或频道/群 ID。
 * @param signal 可选的取消信号。
 * @returns 查询成功时返回 `ChatFullInfo`，不可达或失败时返回 undefined。
 */
export function probeTelegramChatInfoSilent(
  targetId: number,
  signal?: AbortSignal
): Promise<ChatFullInfo | undefined> {
  return runTelegramAction<ChatFullInfo, ChatFullInfo | undefined>({
    action: `probe chat info for identity ${targetId}`,
    execute: (requestSignal?: AbortSignal): Promise<ChatFullInfo> =>
      telegramApi.getChat(targetId, telegramSignal(requestSignal)),
    map: (result: ChatFullInfo): ChatFullInfo => result,
    fallback: undefined,
    signal,
    shouldLogError: (): boolean => false,
  });
}
