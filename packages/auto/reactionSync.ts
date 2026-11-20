import type { Context } from "grammy";
import type { CopyableReaction } from "../types/telegram";
import { activeCopyTargetIdIn } from "../infra/storage/stateStore";
import { getChatState } from "../infra/chatStateStorage";
import { setMessageReactions } from "../infra/telegram";
import { logger } from "../infra/logger";
import type { MessageReactionUpdated } from "grammy/types";
import { TELEGRAM_DATE_UNIT_MS } from "../consts/telegram";
import { activeTranslateStateIn } from "../translate/message";

/**
 * 处理 `message_reaction` 更新，将本群 `/copy` 目标的表情回应（普通 emoji 与自定义 emoji）同步到同一条消息：
 * - 仅在发起 `/copy` 的群内生效（经 `activeCopyTargetIdIn` 判定）；若该目标同时处于生效的翻译会话中，则遵循翻译优先规则跳过回应同步。
 * - 目标移除自身回应时同步清空机器人回应；本条 update 等待 Telegram 请求结算后才返回，429 由主线程 `reaction` 类别独立退避。
 *
 * @param ctx grammY 上下文
 */
export async function handleReaction(ctx: Context): Promise<void> {
  const reaction: MessageReactionUpdated | undefined = ctx.messageReaction;
  if (!reaction) return;

  const copyTargetId: number | undefined = activeCopyTargetIdIn(reaction.chat.id);
  const reactorId: number | undefined = reaction.actor_chat ? reaction.actor_chat.id : reaction.user?.id;
  if (copyTargetId === undefined || reactorId !== copyTargetId) return;
  if (activeTranslateStateIn(getChatState(reaction.chat.id), reactorId) !== undefined) return;

  // grammY 的 ctx.reactions() 已把 old/new 的差量按类型分组（付费反应单独归类，
  // 不在可复制范围，见 CopyableReaction 类型注释）。机器人一条消息只设一个反应：
  // 优先跟随本次新增的那个，没有新增就取仍点着的第一个；全空表示目标清掉了
  // 可复制的反应，跟着清除。
  const { emoji, emojiAdded, emojiRemoved, customEmoji, customEmojiAdded, customEmojiRemoved }: ReturnType<typeof ctx.reactions> = ctx.reactions();
  let toApply: CopyableReaction[];
  if (emojiAdded.length > 0) {
    toApply = [{ type: "emoji", emoji: emojiAdded[0]! }];
  } else if (customEmojiAdded.length > 0) {
    toApply = [{ type: "custom_emoji", custom_emoji_id: customEmojiAdded[0]! }];
  } else if (emoji.length > 0) {
    toApply = [{ type: "emoji", emoji: emoji[0]! }];
  } else if (customEmoji.length > 0) {
    toApply = [{ type: "custom_emoji", custom_emoji_id: customEmoji[0]! }];
  } else if (emojiRemoved.length === 0 && customEmojiRemoved.length === 0) {
    // 这次变化不涉及任何可复制的反应：没有要设或要清的，不发 API 调用。
    return;
  } else {
    toApply = [];
  }

  const startedAtMs: number = Date.now();
  const applied: boolean = await setMessageReactions({
    chatId: reaction.chat.id,
    messageId: reaction.message_id,
    reactions: toApply,
  });
  if (!applied) return;

  const nowMs: number = Date.now();
  const deliveryMs: number = Math.max(0, startedAtMs - reaction.date * TELEGRAM_DATE_UNIT_MS);
  const queueMs: number = Math.max(0, nowMs - startedAtMs);
  logger.info("Reaction synced.", {
    chatId: reaction.chat.id,
    messageId: reaction.message_id,
    deliveryMs,
    queueMs,
  });
}
