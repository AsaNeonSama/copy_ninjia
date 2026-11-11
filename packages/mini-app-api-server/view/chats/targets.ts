import { chatQaEntries } from "../../../cache/main/qa";
import { answerRejectionOf, questionRejectionOf } from "../../../commands/qa/fieldRules";
import { SUPER_ADMIN_USER_ID } from "../../../config/bot";
import { translateConfigReadiness } from "../../../config/readiness";
import { DELETE_MESSAGE_CHAT_TARGET_MAX } from "../../../consts/deleteMessage";
import { MINI_APP_TRANSLATE_LANGUAGES } from "../../../consts/miniApp";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
} from "../../../consts/qa";
import { BIDI_CONTROL_PATTERN } from "../../../consts/text";
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
} from "../../../infra/chatStateStorage";
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
} from "../../../types/miniApp/chats";
import type { QaFieldRejection } from "../../../types/qa";
import type { BotChatPermissions } from "../../../types/telegram";
import type { TranslateState } from "../../../types/translate";
import { resolveIdTarget } from "../../../users/senderIdentity";
import {
  formatIdentityDisplayName,
  syncIdentityMetadataWithBotCache,
} from "../identities/metadata";
import { getManagedChatDetail } from "./query";
import { resolveTargetInput, verifyTargetUserInChat } from "./targetInput";
import type { ResolvedTargetInput } from "./targetInput";

/**
 * 将问答字段校验拒绝原因映射为 Mini App 服务端回执编码。
 * @param rejection `questionRejectionOf` 或 `answerRejectionOf` 返回的拒绝原因。
 * @returns Mini App 问答字段拒绝回执编码。
 */
function qaRejectionMessageOf(rejection: QaFieldRejection): string {
  switch (rejection) {
    case "questionTooLong":
      return "QA_QUESTION_TOO_LONG";
    case "answerTooLong":
      return "QA_ANSWER_TOO_LONG";
    case "questionHasCommand":
      return "QA_COMMAND_IN_QUESTION";
    case "answerHasCommand":
      return "QA_COMMAND_IN_ANSWER";
  }
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
    .replace(BIDI_CONTROL_PATTERN, "")
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
    .replace(BIDI_CONTROL_PATTERN, "")
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
 * 群未 `/init`（或在等待期间被关闭）时的变更结果，不附视图。
 * @returns 不附视图的 `CHAT_NOT_FOUND` 结果。
 */
function chatNotFound(): Readonly<MiniAppChatTargetsMutationResult> {
  return { ok: false, message: "CHAT_NOT_FOUND", targets: null, detail: null };
}

/**
 * 读取仍处于 `/init` 的群状态；跨过 await 的分支在写入前用它重新确认群仍受管。
 * @param chatId 目标群 ID。
 * @returns 群仍启用 `/init` 时返回其可变状态，否则返回 undefined。
 */
function initializedChatState(chatId: number): ChatState | undefined {
  const state: ChatState | undefined = getChatStateCache().get(chatId);
  return state?.isInitEnabled === true ? state : undefined;
}

/**
 * 校验移除类请求的目标数字 ID：非零安全整数（用户为正、频道为负）。
 * @param id 请求里的目标 ID。
 * @returns 合法时返回该 ID，否则返回 undefined。
 */
function removalTargetId(id: number | undefined): number | undefined {
  return typeof id === "number" && Number.isSafeInteger(id) && id !== 0 ? id : undefined;
}

/**
 * 新增或替换一条问答对；字段规则与群内 `/qa set` 表单共用。
 * @param chatId 目标群 ID。
 * @param request 变更请求（读取 `q`、`a`）。
 * @returns 变更结果。
 */
async function setQaPair(
  chatId: number,
  request: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
  const q: string = (request.q ?? "").trim();
  const a: string = (request.a ?? "").trim();
  if (q.length === 0 || a.length === 0) {
    return buildMutationResult(chatId, false, "QA_EMPTY_FIELDS");
  }
  const rejection: QaFieldRejection | null =
    questionRejectionOf(q) ?? answerRejectionOf(a);
  if (rejection !== null) {
    return buildMutationResult(chatId, false, qaRejectionMessageOf(rejection));
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

/**
 * 删除一条问答对。
 * @param chatId 目标群 ID。
 * @param request 变更请求（读取 `q`）。
 * @returns 变更结果。
 */
async function removeQaPair(
  chatId: number,
  request: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
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

/**
 * 新增一个追着删目标：拒绝超级管理员与缺删消息权限，核验在群后去重并受 DELETE_MESSAGE_CHAT_TARGET_MAX 限制。
 * @param chatId 目标群 ID。
 * @param request 变更请求（读取 `target`）。
 * @returns 变更结果。
 */
async function addDeleteMessageTarget(
  chatId: number,
  request: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
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
  const latestState: ChatState | undefined = initializedChatState(chatId);
  if (latestState === undefined) return chatNotFound();
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

/**
 * 移除一个追着删目标。
 * @param chatId 目标群 ID。
 * @param state 入口已确认启用 `/init` 的群状态。
 * @param request 变更请求（读取 `id`）。
 * @returns 变更结果。
 */
async function removeDeleteMessageTarget(
  chatId: number,
  state: ChatState,
  request: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
  const targetId: number | undefined = removalTargetId(request.id);
  if (targetId === undefined) {
    return buildMutationResult(chatId, false, "TARGET_INVALID");
  }
  const current: readonly number[] = state.deleteMessageTargets ?? [];
  if (!current.includes(targetId)) {
    return buildMutationResult(chatId, true, "DELETE_TARGET_NOT_FOUND");
  }
  const next: number[] = current.filter((id: number): boolean => id !== targetId);
  state.deleteMessageTargets = next.length > 0 ? next : undefined;
  await persistChatState(chatId, "delete_message target removed via Mini App");
  return buildMutationResult(chatId, true, "DELETE_TARGET_REMOVED");
}

/**
 * 新增或改语言一个追着翻目标：要求翻译能力就绪且本群翻译开着，核验在群后受 TRANSLATE_CHAT_USER_LIMIT 限制。
 * @param chatId 目标群 ID。
 * @param state 入口已确认启用 `/init` 的群状态。
 * @param request 变更请求（读取 `target`、`language`）。
 * @returns 变更结果。
 */
async function addTranslateTarget(
  chatId: number,
  state: ChatState,
  request: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
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
  const latestState: ChatState | undefined = initializedChatState(chatId);
  if (latestState === undefined) return chatNotFound();
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

/**
 * 移除一个追着翻目标（与 `/translate stop` 指定目标同源）。
 * @param chatId 目标群 ID。
 * @param state 入口已确认启用 `/init` 的群状态。
 * @param request 变更请求（读取 `id`）。
 * @returns 变更结果。
 */
async function removeTranslateTarget(
  chatId: number,
  state: ChatState,
  request: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<Readonly<MiniAppChatTargetsMutationResult>> {
  const targetId: number | undefined = removalTargetId(request.id);
  if (targetId === undefined) {
    return buildMutationResult(chatId, false, "TARGET_INVALID");
  }
  const hadTarget: boolean = (state.translate ?? []).some(
    (item: TranslateState): boolean => item.translatedUser.id === targetId
  );
  await stopTranslation(chatId, targetId);
  return buildMutationResult(
    chatId,
    true,
    hadTarget ? "TRANSLATE_TARGET_REMOVED" : "TRANSLATE_TARGET_NOT_FOUND"
  );
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
  const state: ChatState | undefined = initializedChatState(chatId);
  if (state === undefined) return chatNotFound();
  switch (request.action) {
    case "setQa":
      return setQaPair(chatId, request);
    case "removeQa":
      return removeQaPair(chatId, request);
    case "addDeleteTarget":
      return addDeleteMessageTarget(chatId, request);
    case "removeDeleteTarget":
      return removeDeleteMessageTarget(chatId, state, request);
    case "addTranslateTarget":
      return addTranslateTarget(chatId, state, request);
    case "removeTranslateTarget":
      return removeTranslateTarget(chatId, state, request);
  }
}
