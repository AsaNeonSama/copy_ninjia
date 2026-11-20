import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState } from "../types/chatState";
import type { TranslateState } from "../types/translate";
import { translateConfigReadiness } from "../config/readiness";
import { TRANSLATE_ARGUMENT_PATTERN, TRANSLATE_STOP_ARGUMENT_PATTERN, TRANSLATE_LANGUAGE_LABELS, TRANSLATE_LIST_JSON_INDENT, TRANSLATE_LIST_JSON_LANGUAGE } from "../consts/translate";

import { getChatState, persistChatState } from "../infra/chatStateStorage";
import { replyCommandNotice, sendCommandMessage } from "../infra/telegram";
import { explicitReplyTo } from "../libs/forumTopic";
import { isTelegramGroupChatId } from "../libs/telegramId";
import { isTranslateLanguage } from "../translate/language";
import { setTranslateState, stopTranslation, translateStateIn } from "../translate/state";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { refuseIfConfigBroken } from "./configGate";
import { runChatToggleCommand } from "./superAdminToggle";
import { resolveCommandTarget } from "./targetResolution";

/**
 * 检查翻译功能的配置前提；不可用时回执 translateConfigInvalid，返回 true。
 * @param chatId 触发命令所在群聊 ID。
 * @param messageId 触发命令的消息 ID；用于挂回复引用。
 * @returns 配置不可用且已发送拒绝回执时返回 true；可用时返回 false。
 */
function refuseUnavailableTranslation(chatId: number, messageId: number | undefined): Promise<boolean> {
  return refuseIfConfigBroken({
    readiness: translateConfigReadiness(),
    chatId,
    messageId,
    feature: "Translation",
    text: (file: string): string => chatAtmosphere().NOTICE_TEXTS.translateConfigInvalid(file),
  });
}

/**
 * 处理 `/translate` 自动翻译命令（会话变更均在落盘确认后回执成功）：
 * - `/translate <方向> [目标]`：对回复目标或 `@username` 启动指定语言方向的自动翻译；
 * - `/translate stop [目标]`：停止本群全部翻译目标，或停止指定目标（支持回复、`@username` 及用户/频道裸 ID）；
 * - `/translate list`：以 JSON 代码块列出支持的语言方向；
 * - `/translate enable|disable`：按 `isCanControllTranslatePermission` 授权开关本群自动翻译能力。
 * @param ctx grammY 命令上下文。
 */
export async function handleTranslateCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const argument: string = ctx.match.trim();
  if (!isTelegramGroupChatId(chatId)) return;
  // 子命令词不区分大小写，口径同 `/copy`、`/qa`、`/icon`、`/mood`；目标参数保留原文。
  const keyword: string = argument.toLowerCase();

  if (keyword === "list") {
    const text: string = JSON.stringify(TRANSLATE_LANGUAGE_LABELS, null, TRANSLATE_LIST_JSON_INDENT);
    await sendCommandMessage({
      chatId,
      text,
      entities: [{ type: "pre", offset: 0, length: text.length, language: TRANSLATE_LIST_JSON_LANGUAGE }],
      replyToMessageId: messageId,
    });
    return;
  }

  if (keyword === "enable" || keyword === "disable") {
    await runChatToggleCommand({
      ctx,
      texts: chatAtmosphere().TRANSLATE_TOGGLE_TEXTS,
      permission: "isCanControllTranslatePermission",
      feature: "translation",
      refuseEnable: refuseUnavailableTranslation,
      beforeDisable: (chatId: number): Promise<void> => stopTranslation(chatId),
    });
    return;
  }

  const stopMatch: RegExpExecArray | null = TRANSLATE_STOP_ARGUMENT_PATTERN.exec(argument);
  if (stopMatch !== null) {
    if (stopMatch[1] === undefined && explicitReplyTo(ctx.msg) === undefined && ctx.msg.external_reply === undefined) {
      await stopTranslation(chatId);
      await replyCommandNotice(ctx, chatAtmosphere().TRANSLATE_STOP_ALL_TEXT);
      return;
    }
    const target: CachedUser | undefined = await resolveCommandTarget({
      chatId, message: ctx.msg, botUserId: ctx.me.id, rawArgument: stopMatch[1] ?? "",
      messages: chatAtmosphere().TRANSLATE_TARGET_TEXTS, acceptUserId: true, acceptChatId: true,
    });
    if (target === undefined) return;
    const current: TranslateState | undefined = translateStateIn(getChatState(chatId), target.id);
    await stopTranslation(chatId, target.id);
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    const targetLabel: string = formatTargetLabel(target, atmosphere);
    await replyCommandNotice(
      ctx,
      current === undefined
        ? atmosphere.NOTICE_TEXTS.translateNotRunning(targetLabel)
        : atmosphere.NOTICE_TEXTS.translateStopped(targetLabel)
    );
    return;
  }

  const match: RegExpExecArray | null = TRANSLATE_ARGUMENT_PATTERN.exec(argument);
  const language: string | undefined = match?.[1]?.toLowerCase();
  if (language === undefined || !isTranslateLanguage(language)) {
    await replyCommandNotice(ctx, chatAtmosphere().TRANSLATE_USAGE_TEXT);
    return;
  }
  if (await refuseUnavailableTranslation(chatId, messageId)) return;
  if (getChatState(chatId).isTranslationEnabled !== true) {
    await replyCommandNotice(ctx, chatAtmosphere().TRANSLATE_DISABLED_TEXT);
    return;
  }

  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: match?.[2] ?? "",
    messages: chatAtmosphere().TRANSLATE_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const chatState: Readonly<ChatState> = getChatState(chatId);
  if (chatState.isTranslationEnabled !== true) {
    await replyCommandNotice(ctx, chatAtmosphere().TRANSLATE_DISABLED_TEXT);
    return;
  }
  const current: TranslateState | undefined = translateStateIn(chatState, target.id);
  if (current !== undefined) {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.translateAlreadyRunning(formatUserLabel(current.translatedUser, atmosphere), TRANSLATE_LANGUAGE_LABELS[current.language]));
    return;
  }

  if (!setTranslateState(chatId, { translatedUser: target, language })) {
    await replyCommandNotice(ctx, chatAtmosphere().TRANSLATE_CHAT_CAPACITY_TEXT);
    return;
  }
  await persistChatState(chatId, "translation started");
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.translateStarted(formatUserLabel(target, atmosphere), TRANSLATE_LANGUAGE_LABELS[language]));
}
