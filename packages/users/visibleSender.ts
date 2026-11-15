import type { Chat, Message, User } from "grammy/types";
import type { CachedUser } from "../types/chatState";

/**
 * 提取消息在群内实际展示的会话身份：
 * - 优先返回 `sender_chat`（频道马甲或匿名管理员，匿名管理员的 `sender_chat.id` 等于 `message.chat.id`）；
 * - 纯频道帖（`chat.type === "channel"`）返回帖子自身的 `chat`；
 * - 普通真实用户发言或无会话发送者时返回 `undefined`。
 * Telegram 不暴露频道马甲或匿名管理员背后的真实用户 ID，破坏性管理命令由调用方单独拦截。
 * @param message 待提取展示发送者会话的 Telegram 消息。
 * @returns 展示用的频道或群组 Chat 对象；普通用户发言或无会话发送者时返回 undefined。
 */
export function visibleSenderChat(message: Message): Chat | undefined {
  return message.sender_chat ?? (message.chat.type === "channel" ? message.chat : undefined);
}

/**
 * 提取消息在群内展示的发送者 ID：优先取 `visibleSenderChat(message)?.id`，其次取 `message.from?.id`。
 * 不分配临时对象，适合每条群消息的高频路径；两者均缺失时返回 `undefined`。
 * @param message 待提取发送者 ID 的 Telegram 消息。
 * @returns 群内展示的发送者 ID（频道会话 ID 优先，其次为真实用户 ID），均缺失时返回 undefined。
 */
export function visibleSenderId(message: Message): number | undefined {
  return visibleSenderChat(message)?.id ?? message.from?.id;
}

/**
 * 构造频道或匿名管理员会话形态的 `CachedUser` 身份对象。
 * 与 `userIdentity` 共同作为完整 `CachedUser` 形态的唯一构造入口（供消息发送者解析与命令发起人解析共用）。
 * @param senderChat 展示为发送者的频道或群组 Chat 对象。
 * @returns 标记 isChannel 为 true 的 CachedUser 身份对象。
 */
export function channelIdentity(senderChat: Chat): CachedUser {
  return {
    id: senderChat.id,
    username: "username" in senderChat ? senderChat.username : undefined,
    title: "title" in senderChat ? senderChat.title : undefined,
    isChannel: true,
  };
}

/**
 * 构造真实用户形态的 `CachedUser` 身份对象（与 `channelIdentity` 配对作为唯一构造入口）。
 * @param fromUser Telegram 消息或交互中的真实用户对象。
 * @returns 真实用户形态的 CachedUser 身份对象。
 */
export function userIdentity(fromUser: User): CachedUser {
  return {
    id: fromUser.id,
    username: fromUser.username,
    first_name: fromUser.first_name,
    last_name: fromUser.last_name,
  };
}
