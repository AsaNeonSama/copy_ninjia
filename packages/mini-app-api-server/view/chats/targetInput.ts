/**
 * Mini App 群目标管理的目标输入解析与在群核验（追着删、追着翻共用）。
 */

import type { ChatFullInfo } from "grammy/types";
import { telegramApiState } from "../../../cache/perThread/telegramApi";
import { USERNAME_ARG_PATTERN } from "../../../consts/commands";
import { readPresentChatUser } from "../../../infra/telegram/actions/membership";
import { probeTelegramChatInfoSilent } from "../../../infra/telegram/actions/miniApp";
import { bot } from "../../../infra/telegram/mainClient";
import { parseChatIdArgument, parseUserIdArgument } from "../../../libs/telegramId";
import type { CachedUser } from "../../../types/chatState";
import type { ChatMemberPresence } from "../../../types/telegram";
import {
  resolveIdTarget,
  resolveUsernameTarget,
  updateCachedIdentity,
} from "../../../users/senderIdentity";
import { channelIdentity, userIdentity } from "../../../users/visibleSender";
import { currentBotUserId } from "../identities/metadata";

/** 目标输入解析结果。 */
export type ResolvedTargetInput =
  | { readonly ok: true; readonly user: CachedUser }
  | { readonly ok: false; readonly message: string };

/**
 * 将前端传入的目标参数（`@username`、`username`、正整数用户 ID 或负数频道 ID）解析为 `CachedUser`，并执行自指与当前群自身身份拦截。
 * @param chatId 当前操作的群 ID。
 * @param rawTarget 前端提交的原始目标字符串。
 * @returns 解析成功的目标身份或失败提示键。
 */
export function resolveTargetInput(chatId: number, rawTarget: string | undefined): ResolvedTargetInput {
  const trimmed: string = (rawTarget ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "TARGET_REQUIRED" };
  }

  const numericId: number | undefined =
    parseUserIdArgument(trimmed) ?? parseChatIdArgument(trimmed);
  let targetUser: CachedUser;
  if (numericId !== undefined) {
    targetUser = resolveIdTarget(numericId);
  } else {
    const candidate: string = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    const match: RegExpExecArray | null = USERNAME_ARG_PATTERN.exec(candidate);
    if (match === null) {
      return { ok: false, message: "TARGET_INVALID" };
    }
    const found: CachedUser | undefined = resolveUsernameTarget(match[1]!);
    if (found === undefined) {
      return { ok: false, message: "TARGET_USERNAME_NOT_FOUND" };
    }
    targetUser = found;
  }

  const botUserId: number | undefined = currentBotUserId();
  if (botUserId !== undefined && targetUser.id === botUserId) {
    return { ok: false, message: "TARGET_SELF_FORBIDDEN" };
  }
  if (targetUser.id === chatId) {
    return { ok: false, message: "TARGET_CURRENT_CHAT_FORBIDDEN" };
  }
  return { ok: true, user: targetUser };
}

/**
 * 当目标为正整数用户 ID 且 Telegram API 客户端已就绪时，探测该用户当前是否在目标群内，并将现查到的资料同步写入 Bot 主线程发送者缓存。
 * @param chatId 目标群 ID。
 * @param targetUser 初步解析出的目标身份。
 * @returns 确认不在群时返回失败结果；在群或离线未挂载 API 时返回目标身份（在群时补齐最新用户资料）。
 */
export async function verifyTargetUserInChat(
  chatId: number,
  targetUser: CachedUser
): Promise<ResolvedTargetInput> {
  if (telegramApiState.current === null && !bot.isInited()) {
    return { ok: true, user: targetUser };
  }
  if (targetUser.id <= 0 || targetUser.isChannel === true) {
    if (targetUser.title === undefined && targetUser.username === undefined) {
      const chatInfo: ChatFullInfo | undefined =
        await probeTelegramChatInfoSilent(targetUser.id);
      if (chatInfo !== undefined) {
        const liveChannel: CachedUser = channelIdentity(chatInfo);
        updateCachedIdentity(liveChannel);
        return { ok: true, user: liveChannel };
      }
    }
    return { ok: true, user: targetUser };
  }
  const presence: ChatMemberPresence = await readPresentChatUser({
    chatId,
    userId: targetUser.id,
  });
  if (presence.kind === "absent") {
    return { ok: false, message: "TARGET_NOT_IN_CHAT" };
  }
  if (presence.kind === "present") {
    const liveUser: CachedUser = userIdentity(presence.user);
    updateCachedIdentity(liveUser);
    return { ok: true, user: liveUser };
  }
  return { ok: true, user: targetUser };
}
