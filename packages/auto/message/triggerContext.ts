import type { Message } from "grammy/types";
import { isReplyToSelf, resolveForwardOrigin, resolveMentionFacts, resolveReplyReference } from "./facts";
import { explicitReplyTo, forumTopicThreadId } from "../../libs/forumTopic";
import type { AiBotInfo, AiDirectTriggerReason } from "../../types/aiChat/protocol";
import type { MentionFacts, MessageTriggerContext } from "../../types/auto";

/** 构造群消息 AI 直接/随机触发上下文的输入参数。 */
export interface CreateMessageTriggerContextParams {
  /** Telegram 入站消息 */
  message: Message;
  /** 本机器人身份信息 */
  bot: AiBotInfo;
  /** 本条消息统一的「现在」；见 types/auto.ts 的 MessageTriggerContext.now。 */
  now: number;
  /** 当前群是否处于安静模式 */
  isQuiet: boolean;
  /** 门控前的随机触发概率，由 auto/message/index.ts 算出。 */
  aiReplyProbability: number;
}

/**
 * 一次计算文本和媒体 handler 共用的直接/随机触发事实。
 *
 * @param params 入站消息、机器人身份、当前时间戳、安静期标记与基础随机回复概率。
 * @returns 完整消息触发上下文。
 */
export function createMessageTriggerContext({
  message,
  bot,
  now,
  isQuiet,
  aiReplyProbability,
}: CreateMessageTriggerContextParams): MessageTriggerContext {
  const repliedTo: Message | undefined = explicitReplyTo(message);
  const isReplyToBot: boolean = !!repliedTo && repliedTo.from?.id === bot.id;
  // 两个提及事实一次遍历解析（见 facts.ts 的 resolveMentionFacts）。
  const mentionFacts: Readonly<MentionFacts> = resolveMentionFacts(message, bot.id, bot.username);
  const directTriggerReason: AiDirectTriggerReason | undefined = isReplyToBot
    ? "reply"
    : mentionFacts.isMentioned
    ? "mention"
    : undefined;

  const repliesToSelf: boolean = isReplyToSelf(message, repliedTo);
  const effectiveProbability: number =
    directTriggerReason === undefined && !isQuiet && !mentionFacts.hasOtherMention && !repliesToSelf
      ? aiReplyProbability
      : 0;

  return {
    message,
    now,
    aiReplyProbability: effectiveProbability,
    repliedTo,
    replyReference: resolveReplyReference(message, bot.id, repliedTo),
    forwardedFrom: resolveForwardOrigin(message),
    directTriggerReason,
    messageThreadId: forumTopicThreadId(message),
  };
}
