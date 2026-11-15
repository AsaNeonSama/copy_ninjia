import type { AtmosphereTexts } from "../types/atmosphere";
import type { CachedUser } from "../types/chatState";
import { joinPersonName, sanitizeDisplayName } from "../libs/text";

/**
 * 生成回复文本中的可读用户或频道标签：优先返回 `@username`，无公开用户名时退化为清洗后的 `title` 或 `first_name`。
 * @param user 要生成标签的用户或频道。
 * @param atmosphere 本进程的氛围文案。
 * @returns 格式化后的用户或频道显示标签。
 */
export function formatUserLabel(user: CachedUser, atmosphere: AtmosphereTexts): string {
  if (user.username) return `@${user.username}`;
  // title 与 first_name 由用户自定义，拼入机器人回复前须经 sanitizeDisplayName 清洗。
  if (user.isChannel) return sanitizeDisplayName(user.title ?? "") || atmosphere.NOTICE_TEXTS.unknownChannel;
  return sanitizeDisplayName(user.first_name ?? "") || atmosphere.NOTICE_TEXTS.unknownUser;
}

/**
 * 生成命令回执中的发起人标签；消息缺失可用发送者身份时返回氛围文案的「未知发起人」兜底称呼。
 * @param actor 已解析的发起人；消息不带可用发送者身份时为 undefined。
 * @param atmosphere 本进程的氛围文案。
 * @returns 发起人显示标签或未知发起人兜底文案。
 */
export function formatActorLabel(actor: CachedUser | undefined, atmosphere: AtmosphereTexts): string {
  return actor === undefined ? atmosphere.NOTICE_TEXTS.unknownActor : formatUserLabel(actor, atmosphere);
}

/**
 * 生成接受裸 ID 的管理命令回执目标标签：
 * - 带有 `username`、`first_name` 或 `title` 任一字段时复用 `formatUserLabel`；
 * - 仅含裸 ID 的最小身份时按 `isChannel` 格式化为带频道或用户 ID 的称呼。
 * @param user 目标用户或频道身份；接受仅含 id（及可选 isChannel）的最小身份。
 * @param atmosphere 本进程的氛围文案。
 * @returns 优先带用户名或名称、无名称字段时带 ID 的目标显示标签。
 */
export function formatTargetLabel(user: CachedUser, atmosphere: AtmosphereTexts): string {
  if (user.username !== undefined || user.first_name !== undefined || user.title !== undefined) {
    return formatUserLabel(user, atmosphere);
  }
  return user.isChannel === true
    ? atmosphere.NOTICE_TEXTS.channelIdLabel(user.id)
    : atmosphere.NOTICE_TEXTS.userIdLabel(user.id);
}

/**
 * 「first_name last_name」形式的展示名，供中文动作命令这类需要念出名称的场景使用
 * （见 commands/cjkAction.ts）；频道或匿名管理员身份没有姓名字段，使用 title。
 * 名称经清洗后若为空，依次退化为 `@username` 与 `atmosphere.NOTICE_TEXTS.unknownUser`。
 * @param user 要生成展示名的用户或频道身份。
 * @param atmosphere 本进程的氛围文案。
 * @returns 清洗后的完整展示名，或用户名/未知用户兜底称呼。
 */
export function formatFullName(user: CachedUser, atmosphere: AtmosphereTexts): string {
  const rawName: string = user.isChannel
    ? user.title ?? ""
    : joinPersonName(user.first_name, user.last_name);
  const displayName: string = sanitizeDisplayName(rawName);
  if (displayName.length > 0) return displayName;
  return user.username ? `@${user.username}` : atmosphere.NOTICE_TEXTS.unknownUser;
}

/**
 * 展示名要挂的个人主页链接。只有公开 username 能拼出稳定的 t.me 地址；
 * username 字符集由 Telegram 限定为字母数字下划线，直接拼接。
 * @param user 要生成个人主页链接的用户/频道。
 * @returns 公开主页 URL；没有公开 username 时为 undefined（调用方应退化为纯文本）。
 */
export function formatProfileUrl(user: CachedUser): string | undefined {
  return user.username ? `https://t.me/${user.username}` : undefined;
}
