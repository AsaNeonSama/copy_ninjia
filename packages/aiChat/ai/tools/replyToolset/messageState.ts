import { sendMessageWithResult } from "../../../../infra/telegram";
import type {
  ReplyToolContext,
  RoundMessageState,
} from "../../../../types/aiChat/replies";
import type { TelegramSendResult } from "../../../../types/telegram";

/**
 * 创建单轮回复的文本去重与错别字预约可变状态。
 * @returns 初始化为空的单轮回复文本状态。
 */
export function createRoundMessageState(): RoundMessageState {
  return {
    typoUsedThisRound: false,
    acceptedCanonicalTexts: new Set<string>(),
    reservedCorrectionText: null,
  };
}

/**
 * 比较用的文本归一化；保留字词、大小写和标点，只合并空白与 Unicode 等价编码。
 * @param text 待归一化的消息文本。
 * @returns NFC 归一化并折叠空白后的文本。
 */
function canonicalReplyText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * 登记本轮已接纳的正文或媒体附言；按归一化形态入集合。
 * @param state 本轮消息去重与错字状态。
 * @param text 已接纳的消息或图注文本。
 */
export function acceptRoundText(state: RoundMessageState, text: string): void {
  state.acceptedCanonicalTexts.add(canonicalReplyText(text));
}

/**
 * 登记执行侧接管的错字纠正字；按归一化形态保存。
 * @param state 本轮消息去重与错字状态。
 * @param text 执行侧预约补发的纠正字文本。
 */
export function reserveCorrectionText(state: RoundMessageState, text: string): void {
  state.reservedCorrectionText = canonicalReplyText(text);
}

/**
 * 同轮已接纳或发送的正文、媒体附言与执行侧接管的纠正字共用判重边界。
 * @param state 本轮消息去重与错字状态。
 * @param text 待判重的候选文本。
 * @returns 与本轮已接纳文本或预约纠正字重复时返回 true，否则返回 false。
 */
export function isDuplicateOfAcceptedText(state: RoundMessageState, text: string): boolean {
  const canonical: string = canonicalReplyText(text);
  return state.reservedCorrectionText === canonical || state.acceptedCanonicalTexts.has(canonical);
}

/** sendDirectMessage 的入参。 */
export interface SendDirectMessageParams {
  /** 当前回复轮次的工具共享上下文。 */
  ctx: ReplyToolContext;
  /** 要发送的消息文本。 */
  text: string;
  /** 可选的回复目标消息 ID。 */
  replyToMessageId?: number;
}

/**
 * 发送纯文本消息并登记自录；本轮已作废或发送失败时返回 undefined。
 * @param params 工具上下文、消息文本与可选回复目标消息 ID。
 * @returns 发送成功的消息 ID；轮次已作废或发送失败时返回 undefined。
 */
export async function sendDirectMessage({
  ctx,
  text,
  replyToMessageId,
}: SendDirectMessageParams): Promise<number | undefined> {
  if (!ctx.isActive()) return undefined;
  const sent: TelegramSendResult | undefined = await sendMessageWithResult({
    chatId: ctx.chatId,
    text,
    replyToMessageId,
    signal: ctx.signal,
    messageThreadId: ctx.messageThreadId,
  });
  if (sent !== undefined) {
    ctx.onMessageSent(text, sent.messageId, sent.repliedToMessageId);
  }
  return sent?.messageId;
}
