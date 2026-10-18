import type { Chat, Message } from "grammy/types";
import { isUserBlocked } from "../infra/blocklist/membership";
import {
  registerBlockedMemberRemover,
  trackBlockedRemoval,
} from "../infra/blocklist/outbox";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import { botCanDeleteMessagesIn } from "../infra/botAdmin";
import { logger } from "../infra/logger";
import { deleteMessageWithOutcome } from "../infra/telegram/actions";
import {
  blockedSenderChatDeleteDeniedChats,
  recentBlockedJoinCounts,
} from "../cache/main/antiRaid/blocklistGuard";
import { verificationKey } from "../libs/verificationKey";
import { JOIN_WINDOW_MS } from "../consts/antiRaid/lockdown";
import { visibleSenderChat } from "../users/visibleSender";
import type { AntiRaidWorkerMessage } from "../types/antiRaid/protocol";
import type { RemoveBlockedMembersParams } from "../types/blocklist";
import type { DeleteMessageOutcome } from "../types/telegram";

/**
 * 黑名单入群守卫主线程侧：黑名单判定、频道身份消息删除与封禁批次登记（见 docs/cn/04-invariants.md）。
 */

/** 向 Worker 持久化投递处置消息的函数签名。 */
export type DurableAntiRaidPost = (messages: readonly AntiRaidWorkerMessage[]) => Promise<number>;

/**
 * 拦截并删除已拉黑频道身份发出的群消息。返回 true 表示消息已由黑名单门禁接管，
 * 调用方不得继续向后续流水线分发；未命中时同步返回 false。
 */
export function deleteBlockedSenderChatMessage(message: Message): boolean | Promise<boolean> {
  const senderChat: Chat | undefined = visibleSenderChat(message);
  const chatId: number = message.chat.id;
  if (
    senderChat === undefined ||
    senderChat.id === chatId ||
    !isUserBlocked(senderChat.id)
  ) {
    return false;
  }

  if (botCanDeleteMessagesIn(chatId) === false) {
    if (!blockedSenderChatDeleteDeniedChats.has(chatId)) {
      blockedSenderChatDeleteDeniedChats.add(chatId);
      logger.error(
        `Blocked sender chat message ${message.message_id} in chat ${chatId} could not be deleted: ` +
        "the bot is known to lack can_delete_messages; further messages there are not logged."
      );
    }
    return true;
  }
  blockedSenderChatDeleteDeniedChats.delete(chatId);

  return deleteMessageWithOutcome(chatId, message.message_id).then(
    (outcome: DeleteMessageOutcome): boolean => {
      if (outcome === "forbidden" || outcome === "failed") {
        logger.error(
          `Blocked sender chat message ${message.message_id} from ${senderChat.id} in chat ${chatId} ` +
          `could not be deleted (${outcome}).`
        );
      }
      return true;
    }
  );
}

export interface ClaimBlockedJoinerParams {
  chatId: number;
  userId: number;
  /** 待投递给 Worker 的消息列表；命中黑名单时追加 removeBlockedMembers。 */
  messages: AntiRaidWorkerMessage[];
  /**
   * 被本次处置取代的 join 消息；若处置批次在对账期间被取消，经 replacedJoins 补回。
   */
  replacedJoin?: AntiRaidWorkerMessage;
  /** removalId -> 被取代的 join 消息映射。 */
  replacedJoins: Map<number, AntiRaidWorkerMessage>;
  /** 入群服务消息 id，交由 Worker 删除。 */
  announcementMessageId?: number;
  /** 入群时刻，供 Worker 补记反刷群计数。 */
  now?: number;
  /** 本群入群守卫是否启用；决定本次入群是否计入反刷群滑动窗口。 */
  joinGuardEnabled: boolean;
}

/** 从队首淘汰超出 JOIN_WINDOW_MS 的入群计数去重项。 */
function pruneRecentBlockedJoins(now: number): void {
  for (;;) {
    const oldestKey: string | undefined = recentBlockedJoinCounts.oldestKey();
    if (oldestKey === undefined) return;
    const countedAt: number | undefined = recentBlockedJoinCounts.get(oldestKey);
    if (countedAt !== undefined && now - countedAt < JOIN_WINDOW_MS) return;
    recentBlockedJoinCounts.delete(oldestKey);
  }
}

/** 判定本次黑名单成员入群是否需要计入反刷群窗口（跨投递路径按 JOIN_WINDOW_MS 去重）。 */
function owesBlockedJoinCount(key: string, now: number): boolean {
  pruneRecentBlockedJoins(now);
  const countedAt: number | undefined = recentBlockedJoinCounts.get(key);
  return countedAt === undefined || now - countedAt >= JOIN_WINDOW_MS;
}

/** 在处置批次成功登记进 outbox 后记录本次入群已完成反刷群计数。 */
function commitBlockedJoinCount(key: string, now: number): void {
  recentBlockedJoinCounts.delete(key);
  recentBlockedJoinCounts.set(key, now);
}

/**
 * 拦截黑名单成员入群：登记 removeBlockedMembers 批次并追加至待投消息列表；
 * 登记失败时记日志并标记补扫（requestBlocklistResweep）。
 * @returns 命中黑名单并已接管处置时返回 true。
 */
export function claimBlockedJoiner({
  chatId,
  userId,
  messages,
  replacedJoin,
  replacedJoins,
  announcementMessageId,
  now = Date.now(),
  joinGuardEnabled,
}: ClaimBlockedJoinerParams): boolean {
  if (!isUserBlocked(userId)) return false;
  const dedupKey: string = verificationKey(chatId, userId);
  const owesJoinCount: boolean = joinGuardEnabled && owesBlockedJoinCount(dedupKey, now);
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({
      chatId,
      userIds: [userId],
      probeMembership: false,
      joinedAt: owesJoinCount ? now : undefined,
      announcementMessageId,
    });
  } catch (error: unknown) {
    logger.error(`Failed to queue removal of blocklisted user ${userId} in chat ${chatId}:`, error);
    requestBlocklistResweep(chatId);
    return true;
  }
  if (owesJoinCount) commitBlockedJoinCount(dedupKey, now);
  messages.push({ type: "removeBlockedMembers", ...params });
  if (replacedJoin !== undefined) replacedJoins.set(params.removalId, replacedJoin);
  logger.log(`Blocklisted user ${userId} rejoined chat ${chatId}; queued removal.`);
  return true;
}

/**
 * 向 infra/blocklist 注册黑名单成员移除执行器。
 */
export function registerBlocklistRemoval(postDurably: DurableAntiRaidPost): void {
  registerBlockedMemberRemover(
    (removals: readonly RemoveBlockedMembersParams[]): Promise<number> =>
      postDurably(removals.map(
        (params: RemoveBlockedMembersParams): AntiRaidWorkerMessage => ({
          type: "removeBlockedMembers",
          ...params,
        })
      ))
  );
}
