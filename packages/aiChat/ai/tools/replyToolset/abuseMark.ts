import { atmosphereState, botInfoState, superAdminUserIdState } from "../../../../cache/workers/aiChat/identity";
import { ATMOSPHERE_TEXTS } from "../../../../consts/atmosphere";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../../../consts/bot";
import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import type { Atmosphere } from "../../../../types/atmosphere";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type {
  ReplyActionPause,
  ReplyToolContext,
  ReplyToolExecution,
} from "../../../../types/aiChat/replies";
import { typingDelayMs } from "../../utils/timing";
import { parseSafeIntegerField } from "../../utils/toolArgs";
import { toolError } from "../../utils/toolResult";
import { sendDirectMessage } from "./messageState";
import { pauseThenSettle } from "./pacing";

/**
 * 校验 abuse_mark 的 user_id 入参（只接受本轮非零触发者，排除机器人自身与 superAdmin），
 * 接纳时同步触发 ctx.onAbuseMark 并在动作链上以当前通知风格发送长期保留的提示消息。
 * @param ctx 当前回复轮次的工具共享上下文。
 * @returns 接收参数 JSON 并返回工具执行计划的执行器函数。
 */
export function createAbuseMarkExecutor(
  ctx: ReplyToolContext
): (argumentsJson: string) => ReplyToolExecution {
  return (argumentsJson: string): ReplyToolExecution => {
    if (!ctx.isActive()) {
      return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    }
    const userId: number | null = parseSafeIntegerField(argumentsJson, "user_id");
    if (userId === null) {
      return toolError("Invalid user_id: must be an integer");
    }
    if (ctx.triggerSenderId === 0 || userId !== ctx.triggerSenderId || userId === botInfoState.current?.id) {
      return toolError("abuse_mark can only target the current trigger sender");
    }
    if (userId === superAdminUserIdState.current) {
      return toolError("abuse_mark is not allowed for the super admin");
    }

    ctx.onAbuseMark(userId);
    const atmosphere: Atmosphere = atmosphereState.current ?? BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE];
    const text: string = ATMOSPHERE_TEXTS[atmosphere].ABUSE_MARK_NOTICE_TEXT;

    return {
      result: JSON.stringify({
        success: true,
        queued: true,
        actions_used: 1,
      }),
      run: async (chatAction: ChatActionControl, pause: ReplyActionPause): Promise<string> => {
        if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
        const blocked: string | null = await pauseThenSettle({
          isActive: ctx.isActive,
          chatAction,
          pause,
          phase: "typing",
          delayMs: typingDelayMs(text),
        });
        if (blocked !== null) return blocked;

        // 用户明确授权的长期保留例外：abuse_mark 提示作为会话性 AI 回复留在群内并记入滚动记忆，不挂 30 秒延迟删除。
        const sentMessageId: number | undefined = await sendDirectMessage({
          ctx,
          text,
          replyToMessageId: ctx.replyToMessageId,
        });
        if (sentMessageId === undefined) return toolError("Failed to send abuse_mark notice");
        return JSON.stringify({
          success: true,
          message_id: sentMessageId,
          actions_used: 1,
        });
      },
    };
  };
}
