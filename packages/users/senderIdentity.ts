import type { CachedUser } from "../types/chatState";
import type { Message, User, Chat } from "grammy/types";
import { identityById, senderUsernameCache, userCache } from "../cache/main/senderIdentity";
import { USER_CACHE_MAX } from "../consts/senderIdentity";
import { explicitReplyTo } from "../libs/forumTopic";
import { channelIdentity, userIdentity, visibleSenderChat } from "./visibleSender";

/**
 * 消息发送者身份解析与双向缓存维护。
 * - 自动消息链路通过 `cacheSender` 刷新 `@username` 缓存。
 * - 命令链路通过 `resolveReplyTarget`、`resolveUsernameTarget`、`resolveIdTarget` 定位目标身份。
 * 缓存结构定义见 `cache/main/senderIdentity.ts`。
 */

/**
 * 解析消息发送者的 `CachedUser` 身份：
 * - 若消息带有可见频道或群组会话身份（`sender_chat` 或 `channel_post` 的 `chat`），返回频道身份；
 * - 否则若存在真实用户 `from`，返回用户身份。
 * 供 `@username` 缓存刷新、被回复消息目标解析及中文动作命令发起人提取共用。
 * @param message 待解析发送者身份的 Telegram 消息。
 * @returns 解析出的用户或频道身份；消息无可用发送者信息时返回 undefined。
 */
export function resolveSenderIdentity(message: Message): CachedUser | undefined {
  const fromUser: User | undefined = message.from;
  const senderChat: Chat | undefined = visibleSenderChat(message);

  if (senderChat) {
    return channelIdentity(senderChat);
  } else if (fromUser) {
    return userIdentity(fromUser);
  }

  return undefined;
}

/**
 * 删除正向用户名映射，并在反向索引仍指向该用户名时同步删除两张按 ID 索引的表。
 * `senderUsernameCache` 与 `identityById` 键集恒等，必须在同一分支内一并摘除。
 * @param username 待摘除的小写用户名键（不带 `@`）。
 */
function deleteAlias(username: string): void {
  const cached: CachedUser | undefined = userCache.get(username);
  userCache.delete(username);
  if (cached && senderUsernameCache.get(cached.id) === username) {
    senderUsernameCache.delete(cached.id);
    identityById.delete(cached.id);
  }
}

/**
 * 原子维护 `username <-> id` 双向索引及按 ID 直查表 `identityById`。
 * 消息观察与启动预热均须经此函数写入，集中处理改名、移除用户名、用户名换绑与容量淘汰。
 * `identityById` 与 `senderUsernameCache` 始终成对更新，保持键集恒等。
 * @param identity 待写入或更新的用户或频道缓存身份。
 */
export function updateCachedIdentity(identity: CachedUser): void {
  const username: string | undefined = identity.username
    ? identity.username.toLowerCase()
    : undefined;
  const previousUsername: string | undefined = senderUsernameCache.get(identity.id);

  // 同一发送者改名或移除 username：先撤销归属于该发送者的旧别名。
  if (previousUsername !== undefined && previousUsername !== username) {
    if (userCache.get(previousUsername)?.id === identity.id) {
      userCache.delete(previousUsername);
    }
    senderUsernameCache.delete(identity.id);
    identityById.delete(identity.id);
  }

  if (username === undefined) return;

  // 同一 username 被另一发送者接管：清理旧发送者的按 ID 索引。
  const previousIdentity: CachedUser | undefined = userCache.get(username);
  if (previousIdentity && previousIdentity.id !== identity.id &&
    senderUsernameCache.get(previousIdentity.id) === username) {
    senderUsernameCache.delete(previousIdentity.id);
    identityById.delete(previousIdentity.id);
  }

  // 仅新增正向键才占用容量；超限前经 deleteAlias 淘汰最旧键并同步清理按 ID 索引。
  if (!previousIdentity && userCache.size >= USER_CACHE_MAX) {
    const oldestUsername: string | undefined = userCache.oldestKey();
    if (oldestUsername !== undefined) deleteAlias(oldestUsername);
  }

  userCache.set(username, identity);
  senderUsernameCache.set(identity.id, username);
  identityById.set(identity.id, identity);
}

/**
 * 记录或刷新消息发送者的缓存条目，供 `@username` 命令查找。
 * 无公开 `username` 的发送者不入缓存，仍可经 `resolveReplyTarget` 或裸 ID 定位。
 * @param message 待提取并缓存发送者资料的 Telegram 消息。
 * @returns 解析出的发送者 ID（频道会话 ID 优先，其次为真实用户 ID）；无可用发送者信息时返回 undefined。
 */
export function cacheSender(message: Message): number | undefined {
  const fromUser: User | undefined = message.from;
  const senderChat: Chat | undefined = visibleSenderChat(message);
  if (senderChat === undefined && fromUser === undefined) return undefined;
  const identityId: number = senderChat?.id ?? fromUser!.id;
  const username: string | undefined = senderChat !== undefined
    ? ("username" in senderChat ? senderChat.username : undefined)
    : fromUser!.username;
  // 按 ID 直查缓存身份（见 cache/main/senderIdentity.ts 的 identityById）。
  const cached: CachedUser | undefined = identityById.get(identityId);
  if (username === undefined && cached === undefined) {
    return identityId;
  }
  // 逐字段比对现值，资料未变时不分配临时对象；比对字段与 resolveSenderIdentity 的两种形态保持一致。
  if (senderChat !== undefined) {
    const title: string | undefined = "title" in senderChat
      ? senderChat.title
      : undefined;
    if (
      cached?.id === identityId &&
      cached.username === username &&
      cached.first_name === undefined &&
      cached.last_name === undefined &&
      cached.title === title &&
      cached.isChannel === true
    ) {
      return identityId;
    }
  } else if (
    cached?.id === identityId &&
    cached.username === username &&
    cached.first_name === fromUser!.first_name &&
    cached.last_name === fromUser!.last_name &&
    cached.title === undefined &&
    cached.isChannel === undefined
  ) {
    return identityId;
  }

  // 仅当资料变化或首次缓存时才经 resolveSenderIdentity 构造对象并写入。
  const identity: CachedUser | undefined = resolveSenderIdentity(message);
  if (identity !== undefined) updateCachedIdentity(identity);
  return identityId;
}

/**
 * 从命令显式回复的消息中解析目标发送者身份。
 * 仅识别显式回复，忽略论坛话题自动挂载的话题创建消息（见 libs/forumTopic.ts 的 explicitReplyTo）。
 * @param message 触发命令的 Telegram 消息。
 * @returns 被显式回复消息的发送者身份；未显式回复或无法识别发送者时返回 undefined。
 */
export function resolveReplyTarget(message: Message): CachedUser | undefined {
  const repliedMessage: Message | undefined = explicitReplyTo(message);
  if (!repliedMessage) return undefined;
  return resolveSenderIdentity(repliedMessage);
}

/**
 * 按不带 `@` 的用户名（大小写不敏感）从双向缓存查找目标身份，供 commands/targetResolution.ts 的 resolveCommandTarget 调用。
 * @param username 待查找的用户名（不带 `@` 前缀）。
 * @returns 双向索引一致时返回缓存身份，未命中或索引不一致时返回 undefined。
 */
export function resolveUsernameTarget(username: string): CachedUser | undefined {
  const normalizedUsername: string = username.toLowerCase();
  const identity: CachedUser | undefined = userCache.get(normalizedUsername);
  if (!identity) return undefined;

  // 正反向索引不一致时清除失效的正向记录并视为未命中。
  if (senderUsernameCache.get(identity.id) !== normalizedUsername) {
    userCache.delete(normalizedUsername);
    return undefined;
  }

  return identity;
}

/**
 * 按裸 ID 解析命令目标身份（供 `/block`、`/gag`、`/ungag`、`/delete_message`、`/permission`、`/white` 调用）。
 * - 裸 ID 本身即为权威目标：双向缓存命中且一致时返回带名称的缓存身份，未命中时返回仅含 `id` 的最小身份（负数 ID 同时标记 `isChannel: true`）。
 * - 负数 ID 仅来自频道身份（`sender_chat`），后续封禁/解封与回执标签据此区分频道与用户。
 * @see ../../docs/cn/04-invariants.md
 * @param targetId 目标用户（正整数）或频道（负整数）的 Telegram ID。
 * @returns 缓存命中且双向一致时返回完整缓存身份，否则返回仅含 id（及负数 isChannel）的最小身份。
 */
export function resolveIdTarget(targetId: number): CachedUser {
  const minimalIdentity: CachedUser = targetId < 0 ? { id: targetId, isChannel: true } : { id: targetId };
  const normalizedUsername: string | undefined = senderUsernameCache.get(targetId);
  if (normalizedUsername === undefined) return minimalIdentity;
  const identity: CachedUser | undefined = userCache.get(normalizedUsername);
  return identity?.id === targetId ? identity : minimalIdentity;
}
