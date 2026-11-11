import type { ChatFullInfo } from "grammy/types";
import { aiChatBotInfo } from "../../../cache/main/aiChat";
import { BIDI_CONTROL_PATTERN } from "../../../consts/text";
import { WHITELIST_PERMISSION_KEYS } from "../../../consts/whitelist";
import { chatAtmosphere } from "../../../infra/atmosphere";
import { identityMetadataFromCachedUser } from "../../../infra/identityStorage";
import { getChatStateCache } from "../../../infra/chatStateStorage";
import { probeTelegramChatInfoSilent } from "../../../infra/telegram/actions/miniApp";
import { bot } from "../../../infra/telegram/mainClient";
import { stripLeadingAtSigns } from "../../../libs/text";
import {
  resolveIdTarget,
  resolveUsernameTarget,
  updateCachedIdentity,
} from "../../../users/senderIdentity";
import type { CachedUser } from "../../../types/chatState";
import type {
  TelegramIdentityMetadata,
  WhitelistPermissionKey,
} from "../../../types/identityPolicy";
import type { MiniAppPermissionDescriptor } from "../../../types/miniApp";

/** 新增或移除白名单/黑名单身份的入参。 */
export interface SetIdentityMembershipParams {
  /** 目标用户（正整数）或频道/群会话（负整数）ID。 */
  readonly id: number;
  /** `true` 表示加入名单，`false` 表示移出名单。 */
  readonly enabled: boolean;
  /** 可选的已知展示资料（如来自 `users_shared` / `chat_shared` 的名称与用户名）。 */
  readonly meta?: Readonly<Partial<TelegramIdentityMetadata>>;
}

/** 修改白名单单项权限的入参。 */
export interface SetMiniAppWhitelistPermissionParams {
  /** 目标白名单身份 ID。 */
  readonly id: number;
  /** 权限键名。 */
  readonly key: WhitelistPermissionKey;
  /** 目标布尔值。 */
  readonly value: boolean;
}

/**
 * 构建十八项白名单权限键及其中文说明列表。
 * @returns 权限键与说明的只读数组。
 */
export function buildPermissionDescriptors(): readonly Readonly<MiniAppPermissionDescriptor>[] {
  const helpMap: Readonly<Record<WhitelistPermissionKey, string>> =
    chatAtmosphere().WHITELIST_PERMISSION_HELP;
  return WHITELIST_PERMISSION_KEYS.map(
    (key: WhitelistPermissionKey): Readonly<MiniAppPermissionDescriptor> => ({
      key,
      description: helpMap[key],
    })
  );
}

/**
 * 根据持久化的 `TelegramIdentityMetadata` 合成人类可读展示名。
 * @param id 身份 ID。
 * @param meta 持久化的展示元数据。
 * @returns 非空展示名称。
 */
export function formatIdentityDisplayName(
  id: number,
  meta: Readonly<TelegramIdentityMetadata>
): string {
  const fullName: string = `${meta.firstName} ${meta.lastName}`
    .replace(BIDI_CONTROL_PATTERN, "")
    .trim();
  if (fullName.length > 0) return fullName;
  const cleanUsername: string = meta.username
    .replace(BIDI_CONTROL_PATTERN, "")
    .trim();
  if (cleanUsername.length > 0) return `@${cleanUsername}`;
  return id < 0 ? `频道 ${id}` : `用户 ${id}`;
}

/**
 * 当身份元数据包含非空 `@username` 时，同步刷新 Bot 主线程发送者缓存（`userCache`、`senderUsernameCache`、`identityById`）。
 * 对象属性顺序与 `packages/users/visibleSender.ts` 的 `channelIdentity` / `userIdentity` 保持严格一致。
 * @param id 用户（正整数）或频道（负整数）身份 ID。
 * @param meta 规范化后的 Telegram 身份展示元数据。
 */
export function cacheIdentityMetadataInBot(
  id: number,
  meta: Readonly<TelegramIdentityMetadata>
): void {
  const cleanUsername: string = stripLeadingAtSigns(meta.username.trim());
  if (cleanUsername.length === 0) return;
  const firstName: string = meta.firstName.trim();
  const lastName: string = meta.lastName.trim();
  const cached: CachedUser =
    id < 0
      ? {
        id,
        username: cleanUsername,
        title: firstName.length > 0 ? firstName : undefined,
        isChannel: true,
      }
      : {
        id,
        username: cleanUsername,
        first_name: firstName.length > 0 ? firstName : undefined,
        last_name: lastName.length > 0 ? lastName : undefined,
      };
  updateCachedIdentity(cached);
}

/**
 * 在 API 服务器与 Bot 主线程发送者缓存之间双向对齐身份展示元数据：
 * 若 Bot 发送者缓存已持有该身份更新后的昵称或用户名，则优先合并最新资料；
 * 若名单元数据带有尚未被其他身份占用的非空 `@username`，则按需回填至 Bot 发送者缓存。
 * @param id 用户或频道身份 ID。
 * @param meta 持久化条目中的身份元数据。
 * @returns 对齐后的只读 `TelegramIdentityMetadata`。
 */
export function syncIdentityMetadataWithBotCache(
  id: number,
  meta: Readonly<TelegramIdentityMetadata>
): Readonly<TelegramIdentityMetadata> {
  const cachedUser: CachedUser = resolveIdTarget(id);
  const fromCached: TelegramIdentityMetadata =
    identityMetadataFromCachedUser(cachedUser);
  const hasCachedName: boolean = fromCached.firstName.length > 0;
  const cleanMetaUsername: string = stripLeadingAtSigns(meta.username.trim());
  const aliasOwner: CachedUser | undefined =
    fromCached.username.length === 0 && cleanMetaUsername.length > 0
      ? resolveUsernameTarget(cleanMetaUsername)
      : undefined;
  const canUseMetaUsername: boolean =
    aliasOwner === undefined || aliasOwner.id === id;
  const effective: Readonly<TelegramIdentityMetadata> = {
    firstName: hasCachedName ? fromCached.firstName : meta.firstName.trim(),
    lastName: hasCachedName ? fromCached.lastName : meta.lastName.trim(),
    username:
      fromCached.username.length > 0
        ? fromCached.username
        : canUseMetaUsername
          ? cleanMetaUsername
          : "",
  };
  if (
    effective.username.length > 0 &&
    (fromCached.username.length === 0 ||
      (fromCached.firstName.length === 0 && effective.firstName.length > 0))
  ) {
    cacheIdentityMetadataInBot(id, effective);
  }
  return effective;
}

/**
 * 为待写入白名单或黑名单的目标身份补齐 `TelegramIdentityMetadata`（优先采用调用方提供的资料，其次读取主线程发送者缓存，最后尽力通过 `getChat` 探测），并同步更新主线程发送者缓存。
 * @param id 目标身份 ID。
 * @param fallback 调用方传入的可选部分元数据。
 * @returns 完整的只读 `TelegramIdentityMetadata`。
 */
export async function resolveIdentityMetadataForMiniApp(
  id: number,
  fallback?: Readonly<Partial<TelegramIdentityMetadata>>
): Promise<Readonly<TelegramIdentityMetadata>> {
  const firstNameFromFallback: string = fallback?.firstName?.trim() ?? "";
  const lastNameFromFallback: string = fallback?.lastName?.trim() ?? "";
  const usernameFromFallback: string = stripLeadingAtSigns(
    fallback?.username?.trim() ?? ""
  );
  if (firstNameFromFallback.length > 0 || usernameFromFallback.length > 0) {
    const resolved: Readonly<TelegramIdentityMetadata> = {
      firstName: firstNameFromFallback,
      lastName: lastNameFromFallback,
      username: usernameFromFallback,
    };
    cacheIdentityMetadataInBot(id, resolved);
    return resolved;
  }

  const cachedUser: CachedUser = resolveIdTarget(id);
  const fromCached: TelegramIdentityMetadata =
    identityMetadataFromCachedUser(cachedUser);
  if (fromCached.firstName.length > 0 || fromCached.username.length > 0) {
    return fromCached;
  }

  const chatInfo: ChatFullInfo | undefined = await probeTelegramChatInfoSilent(id);
  if (chatInfo !== undefined) {
    const firstName: string =
      "first_name" in chatInfo && typeof chatInfo.first_name === "string"
        ? chatInfo.first_name.trim()
        : "title" in chatInfo && typeof chatInfo.title === "string"
          ? chatInfo.title.trim()
          : "";
    const lastName: string =
      "last_name" in chatInfo && typeof chatInfo.last_name === "string"
        ? chatInfo.last_name.trim()
        : "";
    const username: string =
      "username" in chatInfo && typeof chatInfo.username === "string"
        ? chatInfo.username.trim()
        : "";
    if (firstName.length > 0 || username.length > 0) {
      const resolved: Readonly<TelegramIdentityMetadata> = {
        firstName,
        lastName,
        username,
      };
      cacheIdentityMetadataInBot(id, resolved);
      return resolved;
    }
  }

  return fromCached;
}

/**
 * 读取当前 Bot 自身的用户 ID（优先读取已初始化 `bot.botInfo`，测试环境下回退到 `aiChatBotInfo`）。
 * @returns Bot 用户 ID；未就绪时返回 `undefined`。
 */
export function currentBotUserId(): number | undefined {
  return bot.isInited() ? bot.botInfo.id : aiChatBotInfo.current?.id;
}

/**
 * 判断负数身份 ID 是否指向当前已启用 `/init` 的受管群聊自身（与 `/white`、`/block` 一致，拒绝把群组自身身份设入黑白名单）。
 * @param id 待判定的身份 ID。
 * @returns 命中已启用 `/init` 的受管群聊时返回 `true`。
 */
export function isInitializedManagedChatTarget(id: number): boolean {
  return id < 0 && getChatStateCache().get(id)?.isInitEnabled === true;
}
