import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { NON_TEXT_PLACEHOLDER } from "../../consts/auto";
import { sanitizeInline, stripLeadingAtSigns, truncateInline } from "../../libs/text";
import { formatLocalTime } from "../../libs/time";
import type { BufferedMessage, BufferedReplyReference, PendingBotImage } from "../../types/aiChat/memory";
import type { AiRecordContext, AiReplyReference } from "../../types/aiChat/protocol";

/**
 * 清洗并截断入站回复引用，按固定字段顺序构造 BufferedReplyReference。
 *
 * @param reference 入站消息附带的原始回复引用
 * @returns 清洗并截断后的热区回复引用对象
 */
export function sanitizeReplyReference(reference: AiReplyReference): BufferedReplyReference {
  const sanitizedUsername: string = reference.username
    ? stripLeadingAtSigns(sanitizeInline(reference.username))
    : "";
  const sanitizedQuote: string = reference.quote
    ? truncateInline(sanitizeInline(reference.quote), REPLY_REFERENCE_MAX_CHARS)
    : "";
  const sanitizedForwardedFrom: string = reference.forwardedFrom
    ? sanitizeInline(reference.forwardedFrom)
    : "";
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

/**
 * 构造文字或媒体的热区缓存条目；清洗后无正文时返回 null。字段顺序与 normalizeHydratedBufferedMessage 一致。
 *
 * @param source 入站消息或自录消息的发送者与上下文元数据
 * @param text 待清洗的消息或媒体标签文本
 * @param now 当前毫秒时间戳
 * @returns 构造完成的热区缓冲条目；清洗后正文为空时返回 null
 */
export function buildBufferedMessage(
  source: AiRecordContext,
  text: string,
  now: number
): BufferedMessage | null {
  const sanitizedText: string = sanitizeInline(text);
  if (!sanitizedText) return null;
  const sanitizedUsername: string = source.username
    ? stripLeadingAtSigns(sanitizeInline(source.username))
    : "";
  const sanitizedForwardedFrom: string = source.forwardedFrom
    ? sanitizeInline(source.forwardedFrom)
    : "";
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

/**
 * 将快照反序列化出的条目按固定字段顺序归一化为与 buildBufferedMessage 同形的对象。
 *
 * @param message 从持久化快照反序列化出的缓冲消息条目
 * @returns 字段顺序与 `buildBufferedMessage` 一致的归一化缓冲消息条目
 */
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
