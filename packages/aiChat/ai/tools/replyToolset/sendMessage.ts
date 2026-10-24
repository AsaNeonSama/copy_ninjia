import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../../consts/aiChat/tools";
import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import type {
  ReplyActionPause,
  ReplyToolContext,
  ReplyToolExecution,
  RoundMessageState,
} from "../../../../types/aiChat/replies";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import { cleanReply, isEmojiOnly } from "../../utils/replyText";
import { typingDelayMs } from "../../utils/timing";
import { parseBooleanField, parseStringField } from "../../utils/toolArgs";
import { modelAuthoredTextPolicyResult } from "./modelAuthoredText";
import { acceptRoundText, reserveCorrectionText, sendDirectMessage } from "./messageState";
import { pauseThenSettle } from "./pacing";
import {
  applyQuickTypoCorrection,
  decideMessageTypo,
} from "./typoHandling";
import type { TypoDecision } from "../../../../types/aiChat/typo";

/**
 * 解析并清洗 send_message 的 text 入参；清洗后为空返回 null。
 * @param argumentsJson 模型传入的工具参数 JSON 字符串。
 * @returns 清洗后的非空消息文本；缺失或清洗后为空时返回 null。
 */
function parseCleanMessageText(argumentsJson: string): string | null {
  const raw: string | null = parseStringField(argumentsJson, "text");
  return raw === null ? null : cleanReply(raw);
}

/**
 * 校验并预占正文与错字额度，返回接纳回执与执行函数；执行函数先发送正文，再按需补发正确单字。
 * @param ctx 当前回复轮次的工具共享上下文。
 * @param state 本轮消息去重与错字状态。
 * @param getActionsUsed 读取本轮已占用动作额度的回调。
 * @returns 接收参数 JSON 并返回发消息工具执行计划的执行器函数。
 */
export function createSendMessageExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState,
  getActionsUsed: () => number
): (argumentsJson: string) => ReplyToolExecution {
  return (argumentsJson: string): ReplyToolExecution => {
    if (!ctx.isActive()) {
      return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    }
    const text: string | null = parseCleanMessageText(argumentsJson);
    if (!text) return toolError("Invalid or empty text");
    if (isEmojiOnly(text)) {
      return toolError(
        "Emoji-only messages are not allowed: send a sticker (send_sticker) or react to the trigger message (add_reaction) instead"
      );
    }
    const policyResult: string | null = modelAuthoredTextPolicyResult(text, state, "message");
    if (policyResult !== null) return policyResult;

    const typo: TypoDecision = decideMessageTypo({
      argumentsJson,
      text,
      roundHasTypo: ctx.roundHasTypo,
      typoAlreadyUsed: state.typoUsedThisRound,
      remainingActions: HARD_MAX_ACTIONS_PER_REPLY - getActionsUsed(),
    });
    if (typo.shouldUseTypo) state.typoUsedThisRound = true;
    acceptRoundText(state, text);
    if (typo.shouldUseTypo && typo.correctionText) reserveCorrectionText(state, typo.correctionText);
    const correctTypo: boolean = typo.shouldUseTypo && typo.mode === "quick" &&
      typo.correctionText !== null;
    const replyToTrigger: boolean = parseBooleanField(argumentsJson, "reply_to_trigger");
    const replyToMessageId: number | undefined = replyToTrigger ? ctx.replyToMessageId : undefined;
    return {
      result: JSON.stringify({
        success: true,
        queued: true,
        actions_used: correctTypo ? 2 : 1,
        typo_rejected: typo.rejectedReason ?? undefined,
      }),
      run: async (chatAction: ChatActionControl, pause: ReplyActionPause): Promise<string> => {
        if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
        const blocked: string | null = await pauseThenSettle({
          isActive: ctx.isActive,
          chatAction,
          pause,
          phase: "typing",
          delayMs: typingDelayMs(typo.textToSend),
        });
        if (blocked !== null) return blocked;

        const sentMessageId: number | undefined = await sendDirectMessage({
          ctx,
          text: typo.textToSend,
          replyToMessageId,
        });
        if (sentMessageId === undefined) return toolError("Failed to send message");
        let actionsUsedByTool: number = 1;

        if (
          correctTypo && typo.correctionText
        ) {
          const correctionSent: boolean = await applyQuickTypoCorrection({
            ctx,
            chatAction,
            pause,
            correctionText: typo.correctionText,
          });
          if (correctionSent) actionsUsedByTool++;
          return JSON.stringify({
            success: true,
            message_id: sentMessageId,
            actions_used: actionsUsedByTool,
            typo: { mode: "quick", correction: correctionSent ? "sent" : "failed" },
          });
        }

        return JSON.stringify({
          success: true,
          message_id: sentMessageId,
          actions_used: actionsUsedByTool,
          typo_rejected: typo.rejectedReason ?? undefined,
        });
      },
    };
  };
}
