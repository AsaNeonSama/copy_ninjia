import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { chatMessageIndexes } from "../../cache/workers/aiChat/memory";
import { truncateInline } from "../../libs/text";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";

/** 热区消息的 message_id 索引与单跳回复快照（状态见 cache/workers/aiChat/memory.ts 的 chatMessageIndexes）。 */

/**
 * 消息进入热区时登记 message_id 索引。
 *
 * @param chatId 群聊 ID
 * @param entry 进入热区的缓冲消息条目
 */
export function indexBufferedMessage(chatId: number, entry: BufferedMessage): void {
  let index: Map<number, BufferedMessage> | undefined = chatMessageIndexes.get(chatId);
  if (!index) {
    index = new Map<number, BufferedMessage>();
    chatMessageIndexes.set(chatId, index);
  }
  index.set(entry.messageId, entry);
}

/**
 * 消息移出热区时删除仍指向该条目的索引槽位；整群索引为空时移除外层键。
 *
 * @param chatId 群聊 ID
 * @param entry 移出热区的缓冲消息条目
 */
export function unindexBufferedMessage(chatId: number, entry: BufferedMessage): void {
  const index: Map<number, BufferedMessage> | undefined = chatMessageIndexes.get(chatId);
  if (!index) return;
  if (index.get(entry.messageId) !== entry) return;
  index.delete(entry.messageId);
  if (index.size === 0) chatMessageIndexes.delete(chatId);
}

/**
 * 按 message_id 查找仍在热区的消息。
 *
 * @param chatId 群聊 ID
 * @param messageId 目标消息的 message_id
 * @returns 热区中的缓冲消息条目；不在热区时返回 undefined
 */
export function lookupBufferedMessage(chatId: number, messageId: number): BufferedMessage | undefined {
  return chatMessageIndexes.get(chatId)?.get(messageId);
}

/**
 * 将缓存条目复制为单跳回复快照。
 *
 * @param messageId 被引用消息的 message_id
 * @param target 热区中的被引用缓冲消息条目
 * @returns 复制并截断正文后的单跳回复引用快照
 */
export function replyReferenceForBufferedEntry(
  messageId: number,
  target: BufferedMessage
): BufferedReplyReference {
  return {
    messageId,
    id: target.id,
    firstName: target.firstName,
    lastName: target.lastName,
    username: target.username,
    text: truncateInline(target.text, REPLY_REFERENCE_MAX_CHARS),
    quote: undefined,
    forwardedFrom: target.forwardedFrom,
  };
}

/**
 * 按 message_id 查找热区消息并复制为单跳回复快照；不在热区时返回 undefined。
 *
 * @param chatId 群聊 ID
 * @param messageId 被引用消息的 message_id
 * @returns 热区消息对应的单跳回复引用快照；不在热区时返回 undefined
 */
export function replyReferenceForBufferedMessage(
  chatId: number,
  messageId: number
): BufferedReplyReference | undefined {
  const target: BufferedMessage | undefined = lookupBufferedMessage(chatId, messageId);
  return target ? replyReferenceForBufferedEntry(messageId, target) : undefined;
}
