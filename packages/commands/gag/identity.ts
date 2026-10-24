import type { Message, MessageEntity } from "grammy/types";
import {
  GAG_PRIVATE_CHANNEL_ENTRY_MESSAGE_ID,
  GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX,
  GAG_PROFILE_CHAT_SEPARATOR,
  GAG_PUBLIC_PROFILE_LINK_PREFIX,
  GAG_PUBLIC_PROFILE_QUERY,
  GAG_USER_PROFILE_LINK_PREFIX,
} from "../../consts/gag";
import { USERNAME_ARG_PATTERN } from "../../consts/commands";
import { parseChatIdArgument, parseUserIdArgument } from "../../libs/telegramId";
import type { CachedUser } from "../../types/chatState";
import type { GagSession } from "../../types/gag";

/**
 * 把 Bot API 的负频道 ID 转成 `t.me/c` 使用的不带 `-100` 命名空间前缀的 ID。
 * @param targetId 负数的频道或超级群 ID。
 * @returns 去掉 `-100` 或 `-` 前缀后的数字 ID 字符串。
 */
function privateChannelProfileId(targetId: number): string {
  const absoluteId: string = String(targetId).slice(1);
  return absoluteId.startsWith("100") ? absoluteId.slice(3) : absoluteId;
}

/**
 * 构造目标主页：公开身份优先使用 username；无 username 的用户使用官方 ID
 * profile link，频道则使用其 `t.me/c` 对话主页。
 * @param target 目标缓存身份。
 * @returns 目标的 Telegram 主页链接。
 */
export function createGagTargetProfileUrl(target: CachedUser): string {
  if (target.username !== undefined) {
    return `${GAG_PUBLIC_PROFILE_LINK_PREFIX}${target.username}` +
      GAG_PUBLIC_PROFILE_QUERY;
  }
  if (target.id > 0) {
    return `${GAG_USER_PROFILE_LINK_PREFIX}${target.id}`;
  }
  return GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX +
    privateChannelProfileId(target.id) +
    `/${GAG_PRIVATE_CHANNEL_ENTRY_MESSAGE_ID}`;
}

/**
 * 生成 inline 结果前缀所挂的隐藏 marker：主页绑定发言身份，fragment 绑定目标群。
 * URL 对最终用户可见，fragment 不是秘密或鉴权 token；落群时必须分别核对
 * Telegram 给出的 sender 与 chat，不能只信链接载荷。
 * @param session gag 会话。
 * @returns 绑定目标主页与群 ID 的隐藏 marker URL。
 */
export function createGagInlineMarkerUrl(session: GagSession): string {
  return session.targetProfileUrl + GAG_PROFILE_CHAT_SEPARATOR +
    String(session.chatId);
}

/**
 * 检查 URL 是否具有本模块签发的 Telegram 主页加超级群 ID fragment 形态。
 * @param url 待校验的链接字符串。
 * @returns 符合本模块签发的 marker URL 形态时返回 true。
 */
export function isGagInlineMarkerUrl(url: string): boolean {
  const separatorIndex: number = url.lastIndexOf(GAG_PROFILE_CHAT_SEPARATOR);
  if (separatorIndex <= 0) return false;
  const rawChatId: string = url.slice(
    separatorIndex + GAG_PROFILE_CHAT_SEPARATOR.length
  );
  if (parseChatIdArgument(rawChatId) === undefined) return false;
  const profileUrl: string = url.slice(0, separatorIndex);
  if (profileUrl.startsWith(GAG_USER_PROFILE_LINK_PREFIX)) {
    const rawUserId: string = profileUrl.slice(
      GAG_USER_PROFILE_LINK_PREFIX.length
    );
    return parseUserIdArgument(rawUserId) !== undefined;
  }
  if (profileUrl.startsWith(GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX)) {
    const privateChannelScope: string = profileUrl.slice(
      GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX.length
    );
    const scopeSeparatorIndex: number = privateChannelScope.indexOf("/");
    if (scopeSeparatorIndex <= 0) return false;
    const rawChannelId: string = privateChannelScope.slice(
      0,
      scopeSeparatorIndex
    );
    const rawMessageId: string = privateChannelScope.slice(
      scopeSeparatorIndex + 1
    );
    return parseUserIdArgument(rawChannelId) !== undefined &&
      rawMessageId === String(GAG_PRIVATE_CHANNEL_ENTRY_MESSAGE_ID);
  }
  if (!profileUrl.startsWith(GAG_PUBLIC_PROFILE_LINK_PREFIX)) return false;
  const username: string = profileUrl.slice(
    GAG_PUBLIC_PROFILE_LINK_PREFIX.length
  );
  if (!username.endsWith(GAG_PUBLIC_PROFILE_QUERY)) return false;
  return USERNAME_ARG_PATTERN.test(
    username.slice(0, -GAG_PUBLIC_PROFILE_QUERY.length)
  );
}

/**
 * 当前 bot 消息是否带有用户或频道 gag 隐藏主页标记。
 * @param message 入站消息对象。
 * @param botId 当前机器人用户 ID。
 * @returns 消息由本机器人 inline 发出且句首含合法 gag 隐藏主页标记时返回 true。
 */
export function hasGagInlineMarker(message: Message, botId: number): boolean {
  if (message.via_bot?.id !== botId) return false;
  return message.entities?.some((entity: MessageEntity): boolean =>
    entity.type === "text_link" &&
    entity.offset === 0 &&
    isGagInlineMarkerUrl(entity.url)
  ) === true;
}
