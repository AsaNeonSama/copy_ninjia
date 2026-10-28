import type { ChatFullInfo } from "grammy/types";
import { chatQaEntries } from "../../../cache/main/qa";
import { telegramApiState } from "../../../cache/perThread/telegramApi";
import { SUPER_ADMIN_USER_ID } from "../../../config/bot";
import { translateConfigReadiness } from "../../../config/readiness";
import { USERNAME_ARG_PATTERN } from "../../../consts/commands";
import { DELETE_MESSAGE_CHAT_TARGET_MAX } from "../../../consts/deleteMessage";
import {
  MINI_APP_BIDI_CONTROL_CHARS_PATTERN,
  MINI_APP_TRANSLATE_LANGUAGES,
} from "../../../consts/miniApp";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
} from "../../../consts/qa";
import { TRANSLATE_CHAT_USER_LIMIT } from "../../../consts/translate";
import { botChatPermissionsIn } from "../../../infra/botAdmin";
import { identityMetadataFromCachedUser } from "../../../infra/identityStorage";
import {
  ChatQaCapacityError,
  removeChatQa,
  setChatQa,
} from "../../../infra/qaStore";
import {
  getChatState,
  getChatStateCache,
  persistChatState,
} from "../../../infra/storage/stateStore";
import { readPresentChatUser } from "../../../infra/telegram/actions/membership";
import { probeTelegramChatInfoSilent } from "../../../infra/telegram/actions/miniApp";
import { bot } from "../../../infra/telegram/mainClient";
import { renderFencedText } from "../../../libs/codeFence";
import { containsRenderableCommand } from "../../../libs/renderableCommand";
import { parseChatIdArgument, parseUserIdArgument } from "../../../libs/telegramId";
import { setTranslateState, stopTranslation } from "../../../translate/state";
import type { CachedUser, ChatState } from "../../../types/chatState";
import type { TelegramIdentityMetadata } from "../../../types/identityPolicy";
import type {
  MiniAppChatDeleteTargetItem,
  MiniAppChatDetail,
  MiniAppChatQaItem,
  MiniAppChatTargetsMutationRequest,
  MiniAppChatTargetsMutationResult,
  MiniAppChatTargetsView,
  MiniAppChatTranslateTargetItem,
  MiniAppTranslateLanguage,
} from "../../../types/miniApp";
import type {
  BotChatPermissions,
  ChatMemberPresence,
  RichTextMessage,
} from "../../../types/telegram";
import type { TranslateState } from "../../../types/translate";
import {
  resolveIdTarget,
  resolveUsernameTarget,
  updateCachedIdentity,
} from "../../../users/senderIdentity";
import { channelIdentity, userIdentity } from "../../../users/visibleSender";
import {
  currentBotUserId,
  formatIdentityDisplayName,
  syncIdentityMetadataWithBotCache,
} from "../identities/metadata";
import { getManagedChatDetail } from "./query";

/**
 * 检查问答答案在 `pre` 代码围栏之外的普通正文片段是否包含可点击的 `/command`。
 * @param answer 已 trim 的问答答案文本。
 * @returns 普通正文含可触发命令时返回 `true`。
 */
function answerContainsCommandOutsideCodeFence(answer: string): boolean {
  const rendered: RichTextMessage = renderFencedText(answer);
  let cursor: number = 0;
  for (const entity of rendered.entities) {
    if (entity.type !== "pre") continue;
    if (
      entity.offset > cursor &&
      containsRenderableCommand(rendered.text.slice(cursor, entity.offset))
    ) {
      return true;
    }
    cursor = entity.offset + entity.length;
  }
  return (
    cursor < rendered.text.length &&
    containsRenderableCommand(rendered.text.slice(cursor))
  );
}

/**
 * 将群内单个数字身份 ID 格式化为追着删目标展示项。
 * @param targetId 目标用户（正整数）或频道（负整数）ID。
 * @returns 只读追着删目标项。
 */
function buildDeleteTargetItem(targetId: number): Readonly<MiniAppChatDeleteTargetItem> {
  const cached: CachedUser = resolveIdTarget(targetId);
  const meta: TelegramIdentityMetadata = identityMetadataFromCachedUser(cached);
  const displayName: string = formatIdentityDisplayName(targetId, meta);
  const cleanUsername: string = meta.username
    .replace(MINI_APP_BIDI_CONTROL_CHARS_PATTERN, "")
    .trim();
  return {
    id: targetId,
    isChannel: targetId < 0 || cached.isChannel === true,
    displayName,
    ...(cleanUsername.length > 0 ? { username: cleanUsername } : {}),
  };
}

/**
 * 将群内单条 `TranslateState` 格式化为追着翻目标展示项。
 * @param entry 持久化在 `ChatState.translate` 中的翻译目标记录。
 * @returns 只读追着翻目标项。
 */
function buildTranslateTargetItem(
  entry: Readonly<TranslateState>
): Readonly<MiniAppChatTranslateTargetItem> {
  const targetId: number = entry.translatedUser.id;
  const latestCached: CachedUser = resolveIdTarget(targetId);
  const effectiveMeta: Readonly<TelegramIdentityMetadata> =
    syncIdentityMetadataWithBotCache(
      targetId,
      identityMetadataFromCachedUser(entry.translatedUser)
    );
  const displayName: string = formatIdentityDisplayName(targetId, effectiveMeta);
  const cleanUsername: string = effectiveMeta.username
    .replace(MINI_APP_BIDI_CONTROL_CHARS_PATTERN, "")
    .trim();
  return {
    id: targetId,
    isChannel:
      targetId < 0 ||
      entry.translatedUser.isChannel === true ||
      latestCached.isChannel === true,
    displayName,
    ...(cleanUsername.length > 0 ? { username: cleanUsername } : {}),
    language: entry.language,
  };
}

/**
 * 读取指定已 `/init` 群的问答对、追着删目标与追着翻目标完整清单。
 * @param chatId 目标群 ID。
 * @returns 群已启用 `/init` 时返回目标管理视图，否则返回 `null`。
 */
export function getManagedChatTargets(
  chatId: number
): Readonly<MiniAppChatTargetsView> | null {
  const state: Readonly<ChatState> = getChatState(chatId);
  if (!state.isInitEnabled) return null;

  const rawQaMap: ReadonlyMap<string, string> | undefined = chatQaEntries.get(chatId);
  const qaItems: MiniAppChatQaItem[] = [];
  if (rawQaMap !== undefined) {
    for (const [q, a] of rawQaMap) {
      qaItems.push({ q, a });
    }
  }
  const deleteMessageTargets: readonly Readonly<MiniAppChatDeleteTargetItem>[] = (
    state.deleteMessageTargets ?? []
  ).map(buildDeleteTargetItem);
  const translateTargets: readonly Readonly<MiniAppChatTranslateTargetItem>[] = (
    state.translate ?? []
  ).map(buildTranslateTargetItem);

  return {
    chatId,
    qaItems,
    qaMax: CHAT_QA_MAX_PER_CHAT,
    qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
    qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
    deleteMessageTargets,
    deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
    translateTargets,
    translateMax: TRANSLATE_CHAT_USER_LIMIT,
    isTranslationEnabled: state.isTranslationEnabled,
  };
}

/** 目标输入解析结果。 */
type ResolvedTargetInput =
  | { readonly ok: true; readonly user: CachedUser }
  | { readonly ok: false; readonly message: string };

/**
 * 将前端传入的目标参数（`@username`、`username`、正整数用户 ID 或负数频道 ID）解析为 `CachedUser`，并执行自指与当前群自身身份拦截。
 * @param chatId 当前操作的群 ID。
 * @param rawTarget 前端提交的原始目标字符串。
 * @returns 解析成功的目标身份或失败提示键。
 */
function resolveTargetInput(chatId: number, rawTarget: string | undefined): ResolvedTargetInput {
  const trimmed: string = (rawTarget ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "TARGET_REQUIRED" };
  }

  const numericId: number | undefined =
    parseUserIdArgument(trimmed) ?? parseChatIdArgument(trimmed);
  let targetUser: CachedUser;
  if (numericId !== undefined) {
    targetUser = resolveIdTarget(numericId);
  } else {
    const candidate: string = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    const match: RegExpExecArray | null = USERNAME_ARG_PATTERN.exec(candidate);
    if (match === null) {
      return { ok: false, message: "TARGET_INVALID" };
    }
    const found: CachedUser | undefined = resolveUsernameTarget(match[1]!);
    if (found === undefined) {
      return { ok: false, message: "TARGET_USERNAME_NOT_FOUND" };
    }
    targetUser = found;
  }

  const botUserId: number | undefined = currentBotUserId();
  if (botUserId !== undefined && targetUser.id === botUserId) {
    return { ok: false, message: "TARGET_SELF_FORBIDDEN" };
  }
  if (targetUser.id === chatId) {
    return { ok: false, message: "TARGET_CURRENT_CHAT_FORBIDDEN" };
  }
  return { ok: true, user: targetUser };
}

/**
 * 当目标为正整数用户 ID 且 Telegram API 客户端已就绪时，探测该用户当前是否在目标群内，并将现查到的资料同步写入 Bot 主线程发送者缓存。
 * @param chatId 目标群 ID。
 * @param targetUser 初步解析出的目标身份。
 * @returns 确认不在群时返回失败结果；在群或离线未挂载 API 时返回目标身份（在群时补齐最新用户资料）。
 */
async function verifyTargetUserInChat(
  chatId: number,
  targetUser: CachedUser
): Promise<ResolvedTargetInput> {
  if (telegramApiState.current === null && !bot.isInited()) {
    return { ok: true, user: targetUser };
  }
  if (targetUser.id <= 0 || targetUser.isChannel === true) {
    if (targetUser.title === undefined && targetUser.username === undefined) {
      const chatInfo: ChatFullInfo | undefined =
        await probeTelegramChatInfoSilent(targetUser.id);
      if (chatInfo !== undefined) {
        const liveChannel: CachedUser = channelIdentity(chatInfo);
        updateCachedIdentity(liveChannel);
        return { ok: true, user: liveChannel };
      }
    }
    return { ok: true, user: targetUser };
  }
  const presence: ChatMemberPresence = await readPresentChatUser({
    chatId,
    userId: targetUser.id,
  });
  if (presence.kind === "absent") {
    return { ok: false, message: "TARGET_NOT_IN_CHAT" };
  }
  if (presence.kind === "present") {
    const liveUser: CachedUser = userIdentity(presence.user);
    updateCachedIdentity(liveUser);
    return { ok: true, user: liveUser };
  }
  return { ok: true, user: targetUser };
}

/**
 * 构造目标管理变更后的统一返回载荷（含最新群详情与目标管理视图）。
 * @param chatId 目标群 ID。
 * @param ok 是否执行成功。
 * @param message 服务端回执编码。
 * @returns 完整变更结果。
 */
async function buildMutationResult(
  chatId: number,
  ok: boolean,
  message: string
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
  const detail: Readonly<MiniAppChatDetail> | null = await getManagedChatDetail(chatId);
  const targets: Readonly<MiniAppChatTargetsView> | null = getManagedChatTargets(chatId);
  return {
    ok,
    message,
    targets,
    detail,
  };
}

/**
 * 在指定已 `/init` 群内执行问答对、追着删目标或追着翻目标的新增/修改/删除操作。
 * @param chatId 目标群 ID。
 * @param request 变更动作及对应字段。
 * @returns 变更执行结果（含最新 `detail` 与 `targets` 快照）。
 */
export async function mutateManagedChatTargets(
  chatId: number,
  request: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
  const state: ChatState = getChatState(chatId);
  if (!state.isInitEnabled) {
    return { ok: false, message: "CHAT_NOT_FOUND", targets: null, detail: null };
  }

  switch (request.action) {
    case "setQa": {
      const q: string = (request.q ?? "").trim();
      const a: string = (request.a ?? "").trim();
      if (q.length === 0 || a.length === 0) {
        return buildMutationResult(chatId, false, "QA_EMPTY_FIELDS");
      }
      if (q.length > CHAT_QA_QUESTION_MAX_CHARS) {
        return buildMutationResult(chatId, false, "QA_QUESTION_TOO_LONG");
      }
      if (a.length > CHAT_QA_ANSWER_MAX_CHARS) {
        return buildMutationResult(chatId, false, "QA_ANSWER_TOO_LONG");
      }
      if (containsRenderableCommand(q)) {
        return buildMutationResult(chatId, false, "QA_COMMAND_IN_QUESTION");
      }
      if (answerContainsCommandOutsideCodeFence(a)) {
        return buildMutationResult(chatId, false, "QA_COMMAND_IN_ANSWER");
      }
      try {
        const outcome: "created" | "replaced" = setChatQa(chatId, q, a);
        return buildMutationResult(
          chatId,
          true,
          outcome === "replaced" ? "QA_UPDATED" : "QA_ADDED"
        );
      } catch (error: unknown) {
        if (error instanceof ChatQaCapacityError) {
          return buildMutationResult(chatId, false, "QA_LIMIT_REACHED");
        }
        return buildMutationResult(chatId, false, "QA_STORAGE_FAILED");
      }
    }

    case "removeQa": {
      const q: string = (request.q ?? "").trim();
      if (q.length === 0) {
        return buildMutationResult(chatId, false, "QA_EMPTY_FIELDS");
      }
      try {
        const removed: boolean = removeChatQa(chatId, q);
        return buildMutationResult(
          chatId,
          true,
          removed ? "QA_REMOVED" : "QA_NOT_FOUND"
        );
      } catch (_error: unknown) {
        return buildMutationResult(chatId, false, "QA_STORAGE_FAILED");
      }
    }

    case "addDeleteTarget": {
      const resolved: ResolvedTargetInput = resolveTargetInput(chatId, request.target);
      if (!resolved.ok) {
        return buildMutationResult(chatId, false, resolved.message);
      }
      if (resolved.user.id === SUPER_ADMIN_USER_ID) {
        return buildMutationResult(chatId, false, "DELETE_TARGET_SUPER_ADMIN_FORBIDDEN");
      }
      const permissions: Readonly<BotChatPermissions> | undefined =
        await botChatPermissionsIn(chatId);
      if (permissions?.canDeleteMessages !== true) {
        return buildMutationResult(chatId, false, "DELETE_TARGET_MISSING_BOT_PERMISSION");
      }
      const verified: ResolvedTargetInput = await verifyTargetUserInChat(
        chatId,
        resolved.user
      );
      if (!verified.ok) {
        return buildMutationResult(chatId, false, verified.message);
      }
      const latestState: ChatState | undefined = getChatStateCache().get(chatId);
      if (latestState?.isInitEnabled !== true) {
        return { ok: false, message: "CHAT_NOT_FOUND", targets: null, detail: null };
      }
      const current: readonly number[] = latestState.deleteMessageTargets ?? [];
      if (current.includes(verified.user.id)) {
        return buildMutationResult(chatId, true, "DELETE_TARGET_ALREADY_EXISTS");
      }
      if (current.length >= DELETE_MESSAGE_CHAT_TARGET_MAX) {
        return buildMutationResult(chatId, false, "DELETE_TARGET_LIMIT_REACHED");
      }
      latestState.deleteMessageTargets = [...current, verified.user.id];
      await persistChatState(chatId, "delete_message target added via Mini App");
      return buildMutationResult(chatId, true, "DELETE_TARGET_ADDED");
    }

    case "removeDeleteTarget": {
      const targetId: number | undefined = request.id;
      if (
        typeof targetId !== "number" ||
        !Number.isSafeInteger(targetId) ||
        targetId === 0
      ) {
        return buildMutationResult(chatId, false, "TARGET_INVALID");
      }
      const latestState: ChatState | undefined = getChatStateCache().get(chatId);
      if (latestState?.isInitEnabled !== true) {
        return { ok: false, message: "CHAT_NOT_FOUND", targets: null, detail: null };
      }
      const current: readonly number[] = latestState.deleteMessageTargets ?? [];
      if (!current.includes(targetId)) {
        return buildMutationResult(chatId, true, "DELETE_TARGET_NOT_FOUND");
      }
      const next: number[] = current.filter((id: number): boolean => id !== targetId);
      latestState.deleteMessageTargets = next.length > 0 ? next : undefined;
      await persistChatState(chatId, "delete_message target removed via Mini App");
      return buildMutationResult(chatId, true, "DELETE_TARGET_REMOVED");
    }

    case "addTranslateTarget": {
      if (!translateConfigReadiness().ok) {
        return buildMutationResult(chatId, false, "TRANSLATE_CAPABILITY_UNAVAILABLE");
      }
      if (!state.isTranslationEnabled) {
        return buildMutationResult(chatId, false, "TRANSLATE_FEATURE_DISABLED");
      }
      const language: MiniAppTranslateLanguage | undefined = request.language;
      if (
        language === undefined ||
        !MINI_APP_TRANSLATE_LANGUAGES.includes(language)
      ) {
        return buildMutationResult(chatId, false, "TRANSLATE_LANGUAGE_INVALID");
      }
      const resolved: ResolvedTargetInput = resolveTargetInput(chatId, request.target);
      if (!resolved.ok) {
        return buildMutationResult(chatId, false, resolved.message);
      }
      const verified: ResolvedTargetInput = await verifyTargetUserInChat(
        chatId,
        resolved.user
      );
      if (!verified.ok) {
        return buildMutationResult(chatId, false, verified.message);
      }
      const latestState: ChatState | undefined = getChatStateCache().get(chatId);
      if (latestState?.isInitEnabled !== true) {
        return { ok: false, message: "CHAT_NOT_FOUND", targets: null, detail: null };
      }
      if (!latestState.isTranslationEnabled) {
        return buildMutationResult(chatId, false, "TRANSLATE_FEATURE_DISABLED");
      }
      const currentList: readonly TranslateState[] = latestState.translate ?? [];
      const existing: TranslateState | undefined = currentList.find(
        (item: TranslateState): boolean => item.translatedUser.id === verified.user.id
      );
      if (existing === undefined && currentList.length >= TRANSLATE_CHAT_USER_LIMIT) {
        return buildMutationResult(chatId, false, "TRANSLATE_TARGET_LIMIT_REACHED");
      }
      setTranslateState(chatId, {
        translatedUser: verified.user,
        language,
      });
      await persistChatState(chatId, "translation target updated via Mini App");
      if (existing?.language === language) {
        return buildMutationResult(chatId, true, "TRANSLATE_TARGET_ALREADY_EXISTS");
      }
      return buildMutationResult(
        chatId,
        true,
        existing !== undefined ? "TRANSLATE_TARGET_UPDATED" : "TRANSLATE_TARGET_ADDED"
      );
    }

    case "removeTranslateTarget": {
      const targetId: number | undefined = request.id;
      if (
        typeof targetId !== "number" ||
        !Number.isSafeInteger(targetId) ||
        targetId === 0
      ) {
        return buildMutationResult(chatId, false, "TARGET_INVALID");
      }
      const latestState: ChatState | undefined = getChatStateCache().get(chatId);
      if (latestState?.isInitEnabled !== true) {
        return { ok: false, message: "CHAT_NOT_FOUND", targets: null, detail: null };
      }
      const hadTarget: boolean = (latestState.translate ?? []).some(
        (item: TranslateState): boolean => item.translatedUser.id === targetId
      );
      await stopTranslation(chatId, targetId);
      return buildMutationResult(
        chatId,
        true,
        hadTarget ? "TRANSLATE_TARGET_REMOVED" : "TRANSLATE_TARGET_NOT_FOUND"
      );
    }
  }
}
