import { AI_REACTION_EMOJI_SET } from "../../../../consts/aiChat/reactions";
import { MAX_REACTIONS_PER_REPLY } from "../../../../consts/aiChat/tools";
import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import { setMessageReaction } from "../../../../infra/telegram";
import type { ReplyToolContext, ReplyToolExecution } from "../../../../types/aiChat/replies";
import { parseStringField } from "../../utils/toolArgs";

/**
 * 创建单轮回复的 add_reaction 工具执行器。
 * @param ctx 当前回复轮次的工具共享上下文。
 * @returns 接收参数 JSON 并返回表情反应工具执行计划的执行器函数。
 */
export function createAddReactionExecutor(
  ctx: ReplyToolContext
): (argumentsJson: string) => ReplyToolExecution {
  let reactionCount: number = 0;
  return (argumentsJson: string): ReplyToolExecution => {
    if (!ctx.isActive()) {
      return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    }
    const emoji: string | null = parseStringField(argumentsJson, "emoji");
    if (emoji === null || !AI_REACTION_EMOJI_SET.has(emoji)) {
      return toolError("Invalid reaction emoji: pick one from the list");
    }
    if (reactionCount >= MAX_REACTIONS_PER_REPLY) {
      return toolError(
        `Reaction limit reached: at most ${MAX_REACTIONS_PER_REPLY} reaction per reply`
      );
    }
    reactionCount++;
    return {
      result: JSON.stringify({ success: true, queued: true, actions_used: 1 }),
      run: async (): Promise<string> => {
        if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
        const sent: boolean = await setMessageReaction({
          chatId: ctx.chatId,
          messageId: ctx.replyToMessageId,
          emoji,
          signal: ctx.signal,
        });
        if (!sent) return toolError("Failed to set reaction");
        return JSON.stringify({ success: true });
      },
    };
  };
}
