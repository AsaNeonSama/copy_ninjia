import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { NON_TEXT_PLACEHOLDER } from "../../consts/auto";
import { sanitizeInline, stripLeadingAtSigns, truncateInline } from "../../libs/text";
import { formatLocalTime } from "../../libs/time";
import type { BufferedMessage, BufferedReplyReference, PendingBotImage } from "../../types/aiChat/memory";
import type { AiRecordContext, AiReplyReference } from "../../types/aiChat/protocol";

/** 清洗并截断入站回复引用，按固定字段顺序构造 BufferedReplyReference。 */
export function sanitizeReplyReference(reference: AiReplyReference): BufferedReplyReference {
  const sanitizedUsername: string = stripLeadingAtSigns(sanitizeInline(reference.username ?? ""));
  const sanitizedQuote: string = truncateInline(sanitizeInline(reference.quote ?? ""), REPLY_REFERENCE_MAX_CHARS);
  const sanitizedForwardedFrom: string = sanitizeInline(reference.forwardedFrom ?? "");
  return {
    messageId: reference.messageId,
    id: reference.id,
    firstName: sanitizeInline(reference.firstName),
    lastName: sanitizeInline(reference.lastName),
    username: sanitizedUsername ? sanitizedUsername : undefined,
    text: truncateInline(sanitizeInline(reference.text), REPLY_REFERENCE_MAX_CHARS) || NON_TEXT_PLACEHOLDER,
    quote: sanitizedQuote ? sanitizedQuote : undefined,
    forwardedFrom: sanitizedForwardedFrom ? sanitizedForwardedFrom : undefined,
  };
}

/** 构造文字或媒体的热区缓存条目；清洗后无正文时返回 null。字段顺序与 normalizeHydratedBufferedMessage 一致。 */
export function buildBufferedMessage(
  source: AiRecordContext,
  text: string,
  now: number
): BufferedMessage | null {
  const sanitizedText: string = sanitizeInline(text);
  if (!sanitizedText) return null;
  const sanitizedUsername: string = stripLeadingAtSigns(sanitizeInline(source.username ?? ""));
  const sanitizedForwardedFrom: string = sanitizeInline(source.forwardedFrom ?? "");
  return {
    messageId: source.messageId,
    id: source.senderId,
    firstName: sanitizeInline(source.firstName),
    lastName: sanitizeInline(source.lastName),
    username: sanitizedUsername ? sanitizedUsername : undefined,
    text: sanitizedText,
    replyTo: source.replyTo ? sanitizeReplyReference(source.replyTo) : undefined,
    forwardedFrom: sanitizedForwardedFrom ? sanitizedForwardedFrom : undefined,
    at: formatLocalTime(now),
    pendingImage: undefined,
  };
}

/** 将快照反序列化出的条目按固定字段顺序归一化为与 buildBufferedMessage 同形的对象。 */
export function normalizeHydratedBufferedMessage(message: BufferedMessage): BufferedMessage {
  const replyTo: BufferedReplyReference | undefined = message.replyTo;
  const pendingImage: PendingBotImage | undefined = message.pendingImage;
  return {
    messageId: message.messageId,
    id: message.id,
    firstName: message.firstName,
    lastName: message.lastName,
    username: message.username,
    text: message.text,
    replyTo: replyTo === undefined ? undefined : {
      messageId: replyTo.messageId,
      id: replyTo.id,
      firstName: replyTo.firstName,
      lastName: replyTo.lastName,
      username: replyTo.username,
      text: replyTo.text,
      quote: replyTo.quote,
      forwardedFrom: replyTo.forwardedFrom,
    },
    forwardedFrom: message.forwardedFrom,
    at: message.at,
    pendingImage: pendingImage === undefined ? undefined : {
      origin: pendingImage.origin,
      caption: pendingImage.caption,
    },
  };
}
