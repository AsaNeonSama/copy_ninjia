import type { Chat, Message, User } from "grammy/types";
import type { CachedUser } from "../types/chatState";

/**
 * 提取消息在群内实际展示的发送者会话：`sender_chat`（频道身份或匿名管理员）优先；
 * 纯频道帖（`channel_post`）没有 `sender_chat`，帖子自身的 `chat` 即为该频道；
 * 两者都不是时返回 undefined（发送者为真实用户 `from`，或消息不带发送者信息）。
 * 匿名管理员以当前群组身份发言时，`sender_chat.id` 等于 `message.chat.id`；
 * 此处保留该会话身份，供 `/copy` 复制群头像并匹配后续匿名管理员消息进行复读。
 * Telegram 不暴露频道身份或匿名管理员背后的真实用户 ID，破坏性管理命令由调用方单独拦截。
 * `auto/message/facts.ts` 的转录身份、`users/senderIdentity.ts` 的缓存身份与
 * `commands/commandActor.ts` 的命令发起人共用这一判定。
 * @param message 待提取展示发送者会话的 Telegram 消息。
 * @returns 展示用的频道或群组 Chat 对象；普通用户发言或无会话发送者时返回 undefined。
 */
export function visibleSenderChat(message: Message): Chat | undefined {
  return message.sender_chat ?? (message.chat.type === "channel" ? message.chat : undefined);
}

/**
 * 消息在群里显示的发送者 id：visibleSenderChat 的会话 id 优先，否则取 from.id；
 * 两者都拿不到时返回 undefined，调用方不得据此伪造相等关系。只读属性、不分配对象，
 * 可放在每条群消息的路径上。
 * @param message 待提取发送者 ID 的 Telegram 消息。
 * @returns 群内展示的发送者 ID（频道会话 ID 优先，其次为真实用户 ID），均缺失时返回 undefined。
 */
export function visibleSenderId(message: Message): number | undefined {
  return visibleSenderChat(message)?.id ?? message.from?.id;
}

/**
 * 频道身份的唯一构造点（`sender_chat`、频道帖或命令的频道发起人）。
 *
 * 与下面的 userIdentity 一起，是 CachedUser 两种完整形态在全仓的唯一构造点：
 * users/senderIdentity.ts 的 resolveSenderIdentity（消息发送者）与
 * commands/commandActor.ts 的 resolveCommandActor（命令发起人）都构造同一对
 * 形状。判定归属仍在各自调用方，这里只负责形状。命令按 id 指定目标且缓存未命中时，resolveIdTarget 另给一份只带
 * id（及频道标记）的最小身份，不进消息观察路径。
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
 * 真实用户身份的唯一构造点；形状约束见上方 channelIdentity。
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
