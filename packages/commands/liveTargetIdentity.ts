import type { ChatFullInfo, User } from "grammy/types";
import { runTelegramAction } from "../infra/telegram/actions/core";
import { readChatMemberUser } from "../infra/telegram/actions/membership";
import { telegramApi } from "../infra/telegram/client";
import { telegramSignal } from "../libs/telegramSignal";
import { channelIdentity, userIdentity } from "../users/visibleSender";
import type { CachedUser } from "../types/chatState";

/**
 * 按 id 现查命令目标此刻的身份，供 commands/targetResolution.ts 核对 @username 目标的
 * 当前用户名。用户经命令所在群的 getChatMember（离群或从未入群同样返回身份，见
 * infra/telegram/actions/membership.ts 的 readChatMemberUser），频道与群身份经 getChat。
 * 失败记 API 错误日志；update 被取消时向上抛出。
 * @returns 当前身份；查询失败为 undefined。
 */
export async function readLiveTargetIdentity(chatId: number, target: CachedUser): Promise<CachedUser | undefined> {
  if (target.isChannel === true) {
    return runTelegramAction<ChatFullInfo, CachedUser | undefined>({
      action: `read chat ${target.id} to verify a @username target`,
      execute: (signal?: AbortSignal): Promise<ChatFullInfo> => telegramApi.getChat(target.id, telegramSignal(signal)),
      map: channelIdentity,
      fallback: undefined,
    });
  }
  const user: User | undefined = await readChatMemberUser({ chatId, userId: target.id });
  return user === undefined ? undefined : userIdentity(user);
}
