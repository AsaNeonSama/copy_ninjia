import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { clearChatStateField, getChatState, getOrCreateChatState, persistChatState } from "../infra/chatStateStorage";
import { replyCommandNotice } from "../infra/telegram";
import { DURATION_UNIT_MS, QUIET_DEFAULT_MINUTES, QUIET_MAX_MINUTES, QUIET_MIN_MINUTES, QUIET_MINUTES_PATTERN } from "../consts/commands";
import { isQuietUntilActive } from "../libs/chatState";

/**
 * 处理 `/quiet` 指令：让机器人在本群进入临时静默期。
 * - **抑制与保留范围**：静默期内暂停 AI 随机插话、洗澡触发词回复与随机复读；回复/`@` 机器人的 AI 必回、
 *   各类命令、`/copy` 锁定目标复读及上下文记录照常运行。
 * - **时长参数**：接受十进制正整数分钟数（`QUIET_MINUTES_PATTERN`），缺省取 `QUIET_DEFAULT_MINUTES`，
 *   非法形态回复用法提示；超出 `[QUIET_MIN_MINUTES, QUIET_MAX_MINUTES]` 的整数夹紧至边界。
 * - **重复调用语义**：静默期内再次调用仅回执剩余分钟数，不续期也不重置计时；提前解除或重设时长须先执行 `/unquiet`。
 * @param ctx grammY 命令上下文。
 */
export async function handleQuietCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;

  const quietUntil: number = getChatState(chatId).quietUntil ?? 0;
  if (isQuietUntilActive(quietUntil)) {
    const remainingMinutes: number = Math.ceil((quietUntil - Date.now()) / DURATION_UNIT_MS.m);
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.quietAlreadyEnabled(remainingMinutes));
    return;
  }

  const arg: string = ctx.match.trim();
  let minutes: number = QUIET_DEFAULT_MINUTES;
  if (arg) {
    if (!QUIET_MINUTES_PATTERN.test(arg)) {
      await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.quietUsage(QUIET_MIN_MINUTES, QUIET_MAX_MINUTES, QUIET_DEFAULT_MINUTES));
      return;
    }
    minutes = Math.min(QUIET_MAX_MINUTES, Math.max(QUIET_MIN_MINUTES, Number(arg)));
  }

  const state: ChatState = getOrCreateChatState(chatId);
  state.quietUntil = Date.now() + minutes * DURATION_UNIT_MS.m;
  await persistChatState(chatId, "quiet set");

  await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.quietEnabled(minutes));
}

/**
 * 处理 /unquiet 指令：提前解除 /quiet 静默。本群没在静默中时只回执，不改任何状态。
 * @param ctx grammY 命令上下文。
 */
export async function handleUnquietCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;

  const state: Readonly<ChatState> = getChatState(chatId);
  if (!isQuietUntilActive(state.quietUntil)) {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.quietAlreadyDisabled);
    return;
  }

  // clearChatStateField 清除 quietUntil；它是最后一个字段时同步回收 Map 条目。
  clearChatStateField(chatId, "quietUntil");
  await persistChatState(chatId, "quiet cleared");

  await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.quietDisabled);
}
