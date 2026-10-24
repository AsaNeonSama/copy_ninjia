import type { Chat, Message } from "grammy/types";
import type { TelegramIdentityMetadata } from "../types/identityPolicy";

/**
 * 消息当前展示身份的名字：频道马甲取频道标题，否则取发言用户的 first_name。
 * 三个读值函数是展示身份映射的唯一实现；高频路径直接读需要的那一项，不构造元数据对象。
 * @param message 当前 Telegram 消息。
 * @param senderChat 消息的可见频道会话（由 visibleSenderChat 解析），普通用户发言时为 undefined。
 * @returns 展示身份的名字或频道标题，缺失时返回空字符串。
 */
export function identityFirstName(message: Message, senderChat: Chat | undefined): string {
  if (senderChat !== undefined) return "title" in senderChat ? senderChat.title ?? "" : "";
  return message.from?.first_name ?? "";
}

/**
 * 消息当前展示身份的姓：频道马甲没有姓，为空串。
 * @param message 当前 Telegram 消息。
 * @param senderChat 消息的可见频道会话，普通用户发言时为 undefined。
 * @returns 展示身份的姓氏，频道身份或缺失时返回空字符串。
 */
export function identityLastName(message: Message, senderChat: Chat | undefined): string {
  return senderChat === undefined ? message.from?.last_name ?? "" : "";
}

/**
 * 消息当前展示身份的 username：频道马甲取频道 username，否则取发言用户的 username。
 * @param message 当前 Telegram 消息。
 * @param senderChat 消息的可见频道会话，普通用户发言时为 undefined。
 * @returns 展示身份的公开用户名（不带 `@`），缺失时返回空字符串。
 */
export function identityUsername(message: Message, senderChat: Chat | undefined): string {
  if (senderChat !== undefined) return "username" in senderChat ? senderChat.username ?? "" : "";
  return message.from?.username ?? "";
}

/**
 * 把消息当前展示的用户或频道身份映射为持久化名单使用的固定字段。
 * @param message 当前 Telegram 消息。
 * @param senderChat 消息的可见频道会话，普通用户发言时为 undefined。
 * @returns 包含 firstName、lastName、username 的只读身份元数据。
 */
export function messageIdentityMetadata(
  message: Message,
  senderChat: Chat | undefined
): Readonly<TelegramIdentityMetadata> {
  return {
    firstName: identityFirstName(message, senderChat),
    lastName: identityLastName(message, senderChat),
    username: identityUsername(message, senderChat),
  };
}
