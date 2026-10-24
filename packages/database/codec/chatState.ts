import {
  CHAT_STATE_KEYS,
  LOCKDOWN_KEYS,
  TRANSLATE_SESSION_KEYS,
} from "../../consts/storageSchema";
import type { ChatPermissions } from "grammy/types";
import { BOT_CHAT_PERMISSION_KEYS } from "../../consts/botAdmin";
import { CHAT_PERMISSION_KEYS } from "../../consts/storage";
import {
  invalidInput,
  optionalBooleanField,
  optionalTimestampField,
  parseJsonInput,
} from "../../libs/inputValidation";
import { TRANSLATE_CHAT_USER_LIMIT } from "../../consts/translate";
import { DELETE_MESSAGE_CHAT_TARGET_MAX } from "../../consts/deleteMessage";
import type { InputFieldContext } from "../../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { decodeCachedUser } from "../../libs/cachedUserCodec";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type { CachedUser, ChatState, LockdownPhase, LockdownRecord } from "../../types/chatState";
import type { TranslateState } from "../../types/translate";
import type { BotChatPermissions } from "../../types/telegram";

/**
 * 校验主键为合法的 Telegram 群或频道 ID。
 * @param chatId 待校验的会话 ID。
 * @param source 来源标识，用于构造致命错误诊断。
 */
export function assertTelegramChatId(chatId: number, source: string): void {
  if (!isTelegramGroupChatId(chatId)) {
    return invalidInput(source, "$.chatId", "a negative safe integer Telegram group or channel ID");
  }
}

/**
 * 读取并校验对象中必填的布尔属性。
 * @param value 父级对象记录。
 * @param key 属性名称。
 * @param context 父级对象的来源与路径上下文。
 * @returns 校验通过的布尔值。
 */
function requiredBoolean(
  value: Record<string, unknown>,
  key: string,
  { source, path }: InputFieldContext
): boolean {
  const field: unknown = value[key];
  if (typeof field !== "boolean") return invalidInput(source, `${path}.${key}`, "a required boolean");
  return field;
}

/**
 * 校验可选的 Telegram 消息 ID（正安全整数）。
 * @param value 父级对象记录。
 * @param key 属性名称。
 * @param context 父级对象的来源与路径上下文。
 * @returns 校验通过的消息 ID；字段缺省时返回 undefined。
 */
function optionalMessageId(
  value: Record<string, unknown>,
  key: string,
  { source, path }: InputFieldContext
): number | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (!Number.isSafeInteger(field) || (field as number) < 1) {
    return invalidInput(source, `${path}.${key}`, "a positive safe integer message ID");
  }
  return field as number;
}

/**
 * 解码并校验群默认发言权限对象。
 * @param value 待校验的权限字段值。
 * @param source 来源标识，用于构造致命错误诊断。
 * @param path 字段 JSONPath，用于构造致命错误诊断。
 * @returns 已通过校验的 Telegram 群发言权限对象。
 */
function decodeChatPermissions(
  value: unknown,
  source: string,
  path: string
): ChatPermissions {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CHAT_PERMISSION_KEYS)) {
    return invalidInput(source, path, "an object containing only supported chat permission booleans");
  }
  const permissions: ChatPermissions = {};
  for (const key of CHAT_PERMISSION_KEYS) {
    const field: unknown = value[key];
    if (field === undefined) continue;
    if (typeof field !== "boolean") {
      return invalidInput(source, `${path}.${key}`, "a boolean");
    }
    Reflect.set(permissions, key, field);
  }
  return permissions;
}

/**
 * 解码并校验机器人在群内的管理员权限快照。
 * @param value 待校验的机器人权限字段值。
 * @param source 来源标识，用于构造致命错误诊断。
 * @param path 字段 JSONPath，用于构造致命错误诊断。
 * @returns 已通过校验的机器人群内权限对象。
 */
function decodeBotPermissions(
  value: unknown,
  source: string,
  path: string
): BotChatPermissions {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, BOT_CHAT_PERMISSION_KEYS)) {
    return invalidInput(source, path, "the complete supported bot permission object");
  }
  const context: InputFieldContext = { source, path };
  const permissions: BotChatPermissions = {
    isAdministrator: requiredBoolean(value, "isAdministrator", context),
    isAnonymous: requiredBoolean(value, "isAnonymous", context),
    canManageChat: requiredBoolean(value, "canManageChat", context),
    canDeleteMessages: requiredBoolean(value, "canDeleteMessages", context),
    canManageVideoChats: requiredBoolean(value, "canManageVideoChats", context),
    canRestrictMembers: requiredBoolean(value, "canRestrictMembers", context),
    canPromoteMembers: requiredBoolean(value, "canPromoteMembers", context),
    canChangeInfo: requiredBoolean(value, "canChangeInfo", context),
    canInviteUsers: requiredBoolean(value, "canInviteUsers", context),
    canManageTags: requiredBoolean(value, "canManageTags", context),
    canPostStories: requiredBoolean(value, "canPostStories", context),
    canEditStories: requiredBoolean(value, "canEditStories", context),
    canDeleteStories: requiredBoolean(value, "canDeleteStories", context),
    canPostMessages: requiredBoolean(value, "canPostMessages", context),
    canEditMessages: requiredBoolean(value, "canEditMessages", context),
    canPinMessages: requiredBoolean(value, "canPinMessages", context),
    canManageTopics: requiredBoolean(value, "canManageTopics", context),
    canManageDirectMessages: requiredBoolean(value, "canManageDirectMessages", context),
  };
  if (!permissions.isAdministrator) {
    for (const key of BOT_CHAT_PERMISSION_KEYS) {
      if (key !== "isAdministrator" && permissions[key]) {
        return invalidInput(
          source,
          `${path}.${key}`,
          `false when ${path}.isAdministrator is false`
        );
      }
    }
  }
  return permissions;
}

/**
 * 解码并校验反刷群私密模式（Lockdown，关闭群邀请权限）状态机记录。
 * @param value 待校验的 `lockdown` 字段值。
 * @param source 来源标识，用于构造致命错误诊断。
 * @param path 字段 JSONPath，用于构造致命错误诊断。
 * @returns 已通过校验的反刷群私密模式记录。
 */
function decodeLockdown(
  value: unknown,
  source: string,
  path: string
): LockdownRecord {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, LOCKDOWN_KEYS)) {
    return invalidInput(source, path, "the current lockdown object shape");
  }
  const phaseValue: unknown = value.phase;
  if (
    phaseValue !== "applying" &&
    phaseValue !== "active" &&
    phaseValue !== "reconciling" &&
    phaseValue !== "restoring"
  ) {
    return invalidInput(source, `${path}.phase`, "applying, active, reconciling, or restoring");
  }
  const phase: LockdownPhase = phaseValue;
  const context: InputFieldContext = { source, path };
  const intentId: number | undefined = optionalTimestampField(value, "intentId", context);
  if (intentId === undefined || intentId === 0) {
    return invalidInput(source, `${path}.intentId`, "a positive safe integer");
  }
  const expiresAt: number | undefined = optionalTimestampField(value, "expiresAt", context);
  if (expiresAt === undefined) {
    return invalidInput(source, `${path}.expiresAt`, "a required non-negative safe integer timestamp");
  }
  const announced: boolean = requiredBoolean(value, "announced", context);
  const announcementMessageId: number | undefined =
    optionalMessageId(value, "announcementMessageId", context);
  if (announcementMessageId !== undefined && !announced) {
    return invalidInput(source, `${path}.announcementMessageId`, "absent while announced is false");
  }
  if (announcementMessageId === undefined && announced) {
    return invalidInput(source, `${path}.announcementMessageId`, "a message id while announced is true");
  }
  return {
    phase,
    intentId,
    originalPermissions: decodeChatPermissions(
      value.originalPermissions,
      source,
      `${path}.originalPermissions`
    ),
    announced,
    announcementMessageId,
    expiresAt,
  };
}

/**
 * 校验 LockdownRecord 是否满足持久化约束。
 * @param record 待校验的反刷群私密模式记录。
 * @param source 来源标识，用于构造致命错误诊断。
 */
export function assertPersistableLockdown(
  record: LockdownRecord,
  source: string
): void {
  decodeLockdown(record, source, "$.lockdown");
}

/**
 * 解码并校验群翻译会话列表（非空且不超过 TRANSLATE_CHAT_USER_LIMIT 项，群内目标用户唯一）。
 * @param value 待校验的 `translate` 字段值。
 * @param source 来源标识，用于构造致命错误诊断。
 * @returns 已通过校验的群翻译会话只读列表。
 */
function decodeTranslateSessions(value: unknown, source: string): readonly TranslateState[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TRANSLATE_CHAT_USER_LIMIT) {
    return invalidInput(source, "$.translate", `an array containing 1 to ${TRANSLATE_CHAT_USER_LIMIT} translation sessions`);
  }
  const sessions: TranslateState[] = [];
  const userIds: Set<number> = new Set();
  for (let index: number = 0; index < value.length; index++) {
    const path: string = `$.translate[${index}]`;
    const entry: unknown = value[index];
    if (!isPlainRecord(entry) || !hasOnlyKeys(entry, TRANSLATE_SESSION_KEYS)) {
      return invalidInput(source, path, "an object containing only translatedUser and language");
    }
    const language: unknown = entry.language;
    if (language !== "ja" && language !== "cn" && language !== "en" && language !== "uk" && language !== "ru") {
      return invalidInput(source, `${path}.language`, "one of ja, cn, en, uk or ru");
    }
    const translatedUser: CachedUser = decodeCachedUser(entry.translatedUser, { source, path: `${path}.translatedUser` });
    if (userIds.has(translatedUser.id)) {
      return invalidInput(source, `${path}.translatedUser.id`, "unique within the chat");
    }
    userIds.add(translatedUser.id);
    sessions.push({ translatedUser, language });
  }
  return sessions;
}

/**
 * 解码并校验本群自动删帖目标列表（非空且不超过 DELETE_MESSAGE_CHAT_TARGET_MAX 个互异非零安全整数，且不含本群自身 ID）。
 * @param value 待校验的 `deleteMessageTargets` 字段值。
 * @param source 来源标识，用于构造致命错误诊断。
 * @param chatId 所属群会话 ID；提供时拒绝包含本群自身 ID。
 * @returns 已通过校验的自动删帖目标 ID 只读列表。
 */
function decodeDeleteMessageTargets(
  value: unknown,
  source: string,
  chatId?: number
): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DELETE_MESSAGE_CHAT_TARGET_MAX) {
    return invalidInput(
      source,
      "$.deleteMessageTargets",
      `an array containing 1 to ${DELETE_MESSAGE_CHAT_TARGET_MAX} user or channel IDs`
    );
  }
  const targets: number[] = [];
  for (let index: number = 0; index < value.length; index++) {
    const id: unknown = value[index];
    if (!Number.isSafeInteger(id) || id === 0) {
      return invalidInput(source, `$.deleteMessageTargets[${index}]`, "a non-zero safe integer user or channel ID");
    }
    if (chatId !== undefined && id === chatId) {
      return invalidInput(source, `$.deleteMessageTargets[${index}]`, "a user or channel ID other than the chat itself");
    }
    if (targets.includes(id as number)) {
      return invalidInput(source, `$.deleteMessageTargets[${index}]`, "unique within the chat");
    }
    targets.push(id as number);
  }
  return targets;
}

/**
 * 严格解码 `chat_states.status` JSON 文本；拒绝未知字段与空对象，缺省布尔开关归并为 false。
 * @param text 数据库列读出的 JSON 文本。
 * @param source 来源标识，用于构造致命错误诊断。
 * @param chatId 所属群会话 ID；提供时用于交叉校验自动删帖目标。
 * @returns 已通过校验的群状态对象。
 */
export function decodeChatStateData(text: string, source: string, chatId?: number): ChatState {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CHAT_STATE_KEYS)) {
    return invalidInput(source, "$", "an object containing only supported chat-state fields");
  }
  const titleValue: unknown = value.title;
  if (titleValue !== undefined && typeof titleValue !== "string") {
    return invalidInput(source, "$.title", "a string");
  }
  const rootContext: InputFieldContext = { source, path: "$" };
  const state: ChatState = {
    quietUntil: optionalTimestampField(value, "quietUntil", rootContext),
    lockdown: value.lockdown === undefined
      ? undefined
      : decodeLockdown(value.lockdown, source, "$.lockdown"),
    isAIChatEnabled: optionalBooleanField(value, "isAIChatEnabled", rootContext) === true,
    isTranslationEnabled: optionalBooleanField(value, "isTranslationEnabled", rootContext) === true,
    isAdDetectEnabled: optionalBooleanField(value, "isAdDetectEnabled", rootContext) === true,
    isFloodControlEnabled: optionalBooleanField(value, "isFloodControlEnabled", rootContext) === true,
    isAntiRaidEnabled: optionalBooleanField(value, "isAntiRaidEnabled", rootContext) === true,
    isInitEnabled: optionalBooleanField(value, "isInitEnabled", rootContext) === true,
    botPermissions: value.botPermissions === undefined
      ? undefined
      : decodeBotPermissions(value.botPermissions, source, "$.botPermissions"),
    title: titleValue,
    isProxySendEnabled: optionalBooleanField(value, "isProxySendEnabled", rootContext) === true,
    translate: value.translate === undefined ? undefined : decodeTranslateSessions(value.translate, source),
    deleteMessageTargets: value.deleteMessageTargets === undefined
      ? undefined
      : decodeDeleteMessageTargets(value.deleteMessageTargets, source, chatId),
  };
  if (Object.keys(value).length === 0) {
    return invalidInput(source, "$", "a non-empty chat-state object");
  }
  return state;
}

/**
 * 布尔开关为 true 时返回 true，否则返回 undefined 以在 JSON 中省略。
 * @param enabled 布尔功能开关值。
 * @returns 开启时返回 true；关闭时返回 undefined。
 */
function enabledOrOmitted(enabled: boolean): true | undefined {
  return enabled ? true : undefined;
}

/**
 * 将 ChatState 编码为 JSON 文本并经 decodeChatStateData 复核。
 * @param state 待编码的群状态对象。
 * @param source 来源标识，用于复核失败时的错误诊断。
 * @returns 序列化并通过复核的 JSON 字符串。
 */
export function encodeChatStateData(
  state: Readonly<ChatState>,
  source: string = "chat state"
): string {
  const text: string = JSON.stringify({
    quietUntil: state.quietUntil,
    lockdown: state.lockdown,
    isAIChatEnabled: enabledOrOmitted(state.isAIChatEnabled),
    isTranslationEnabled: enabledOrOmitted(state.isTranslationEnabled),
    isAdDetectEnabled: enabledOrOmitted(state.isAdDetectEnabled),
    isFloodControlEnabled: enabledOrOmitted(state.isFloodControlEnabled),
    isAntiRaidEnabled: enabledOrOmitted(state.isAntiRaidEnabled),
    isInitEnabled: enabledOrOmitted(state.isInitEnabled),
    botPermissions: state.botPermissions,
    title: state.title,
    isProxySendEnabled: enabledOrOmitted(state.isProxySendEnabled),
    translate: state.translate,
    deleteMessageTargets: state.deleteMessageTargets,
  });
  decodeChatStateData(text, source);
  return text;
}
