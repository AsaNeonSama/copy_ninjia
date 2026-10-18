import { logger } from "../../../../infra/logger";
import { sleep } from "../../../../libs/sleep";
import {
  TYPO_MIN_REMAINING_ACTIONS,
  TYPO_QUICK_CORRECTION_MAX_MS,
  TYPO_QUICK_CORRECTION_MIN_MS,
  TYPO_QUICK_CORRECTION_TYPING_MS,
} from "../../../../consts/aiChat/tools";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type {
  ReplyActionPause,
  ReplyToolContext,
} from "../../../../types/aiChat/replies";
import type {
  CharacterTypo,
  TypoDecision,
} from "../../../../types/aiChat/typo";
import { containsRenderableCommand } from "../../../../libs/renderableCommand";
import { isEmojiOnly } from "../../utils/replyText";
import {
  buildCharacterTypo,
  pickTypoCorrectionMode,
} from "../../utils/typo";
import { randomDelayMs } from "../../utils/timing";
import { parseStringField } from "../../utils/toolArgs";
import { sendDirectMessage } from "./messageState";
import { pauseThenSettle } from "./pacing";

export interface DecideMessageTypoParams {
  argumentsJson: string;
  text: string;
  roundHasTypo: boolean;
  typoAlreadyUsed: boolean;
  remainingActions: number;
}

/**
 * 校验错字候选在当前轮次是否可用；返回首个拒绝原因，全部通过时返回 null。
 * 错字版本须单独校验是否包含可渲染斜杠命令；命中时仅跳过本次手滑，原样发送正文。
 */
function typoRejection(
  typoAlreadyUsed: boolean,
  typoText: string | null,
  remainingActions: number
): string | null {
  if (typoAlreadyUsed) {
    return "already used the one allowed typo this round; this message will send as-is";
  }
  if (typoText === null) {
    return "typo_original_char/typo_replacement_char were rejected: each must be exactly one character, differ from each other, not be emoji, and typo_original_char must actually appear in text";
  }
  if (isEmojiOnly(typoText)) {
    return "typo candidate was rejected: the resulting message would be emoji-only";
  }
  if (containsRenderableCommand(typoText)) {
    return "typo candidate was rejected: the resulting message would contain a slash command Telegram renders as tappable";
  }
  if (remainingActions < TYPO_MIN_REMAINING_ACTIONS) {
    return "typo candidate was rejected: not enough remaining action budget this round";
  }
  return null;
}

/** 解析模型提交的两枚单字并决定本条消息是否采用本轮唯一一次手滑。 */
export function decideMessageTypo({
  argumentsJson,
  text,
  roundHasTypo,
  typoAlreadyUsed,
  remainingActions,
}: DecideMessageTypoParams): TypoDecision {
  const rawOriginalChar: string | null = parseStringField(argumentsJson, "typo_original_char");
  const rawReplacementChar: string | null = parseStringField(argumentsJson, "typo_replacement_char");
  const originalChar: string | null = rawOriginalChar ? rawOriginalChar.trim() : null;
  const replacementChar: string | null = rawReplacementChar ? rawReplacementChar.trim() : null;
  const characterTypo: CharacterTypo | null = originalChar && replacementChar
    ? buildCharacterTypo(text, originalChar, replacementChar)
    : null;
  const typoText: string | null = characterTypo?.typoText ?? null;
  const rejection: string | null = roundHasTypo
    ? typoRejection(typoAlreadyUsed, typoText, remainingActions)
    : null;
  const typoToSend: string | null = roundHasTypo && rejection === null ? typoText : null;
  const shouldUseTypo: boolean = typoToSend !== null;
  const typoAttempted: boolean = roundHasTypo &&
    !!originalChar &&
    !!replacementChar &&
    originalChar !== replacementChar;
  const rejectedReason: string | null = typoAttempted ? rejection : null;

  return {
    shouldUseTypo,
    textToSend: typoToSend ?? text,
    correctionText: characterTypo?.expected ?? null,
    mode: shouldUseTypo ? pickTypoCorrectionMode() : null,
    rejectedReason,
  };
}

export interface ApplyQuickTypoCorrectionParams {
  ctx: ReplyToolContext;
  /** 本步动作的心跳句柄与拟人停顿，与错字消息同一步。 */
  chatAction: ChatActionControl;
  pause: ReplyActionPause;
  correctionText: string;
}

/** 错字消息发出后经过静默与打字停顿补发正确单字，返回补字是否送达。 */
export async function applyQuickTypoCorrection({
  ctx,
  chatAction,
  pause,
  correctionText,
}: ApplyQuickTypoCorrectionParams): Promise<boolean> {
  try {
    await sleep(
      randomDelayMs(TYPO_QUICK_CORRECTION_MIN_MS, TYPO_QUICK_CORRECTION_MAX_MS),
      ctx.signal
    );
    const blocked: string | null = await pauseThenSettle({
      isActive: ctx.isActive,
      chatAction,
      pause,
      phase: "typing",
      delayMs: TYPO_QUICK_CORRECTION_TYPING_MS,
    });
    if (blocked !== null) return false;
    const correctionMessageId: number | undefined = await sendDirectMessage({
      ctx,
      text: correctionText,
    });
    if (correctionMessageId === undefined) return false;
    return true;
  } catch (error: unknown) {
    if (ctx.signal?.aborted === true) return false;
    logger.error("Error while applying quick typo correction:", error);
    return false;
  }
}
