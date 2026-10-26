import { aiMemoryUsages, latestAiMemories } from "../../../cache/main/aiChat";
import { activeVerificationSnapshots } from "../../../cache/main/antiRaid/verificationMirror";
import { gagSessionsByChat } from "../../../cache/main/gag";
import { chatQaEntries, qaFormSessions } from "../../../cache/main/qa";
import { wedChats } from "../../../cache/main/wed";
import { VERBATIM_CONTEXT_MAX } from "../../../consts/aiChat/memory";
import {
  BOT_CHAT_PERMISSION_KEYS,
  BOT_CHAT_PERMISSION_LABELS,
} from "../../../consts/botAdmin";
import {
  getChatState,
  getChatStateCache,
} from "../../../infra/storage/stateStore";
import { parseAiMemorySnapshot } from "../../../libs/persistedSnapshotCodec";
import { isTerminalVerificationPhase } from "../../../states/verification/shared";
import type { ChatState } from "../../../types/chatState";
import type { GagSession } from "../../../types/gag";
import type {
  MiniAppChatBotPermissionsView,
  MiniAppChatDetail,
  MiniAppChatFeatureFlags,
  MiniAppChatSummary,
} from "../../../types/miniApp";

/**
 * 读取指定群当前的热缓冲区消息条数（优先取 `aiMemoryUsages` 镜像，回退解析 `latestAiMemories`）。
 * @param chatId 群聊 ID。
 * @returns 当前热 256 缓冲区内的消息条数。
 */
export function readChatHotMessageCount(chatId: number): number {
  const usageCount: number | undefined = aiMemoryUsages.get(chatId)?.bufferedCount;
  if (usageCount !== undefined) return usageCount;
  const rawSnapshot: string | undefined = latestAiMemories.get(chatId);
  if (rawSnapshot === undefined) return 0;
  try {
    return parseAiMemorySnapshot(
      rawSnapshot,
      `AI memory snapshot for chat ${chatId}`
    ).buffer.length;
  } catch (_error: unknown) {
    return 0;
  }
}

/**
 * 提取群聊的七项功能开关布尔快照。
 * @param state 群聊状态。
 * @returns 只读的功能开关布尔对象。
 */
function buildFeatureFlags(state: Readonly<ChatState>): Readonly<MiniAppChatFeatureFlags> {
  return {
    init: state.isInitEnabled === true,
    aiChat: state.isAIChatEnabled === true,
    translation: state.isTranslationEnabled === true,
    adDetect: state.isAdDetectEnabled === true,
    floodControl: state.isFloodControlEnabled === true,
    antiRaid: state.isAntiRaidEnabled === true,
    proxySend: state.isProxySendEnabled === true,
  };
}

/**
 * 格式化群聊展示名称（优先使用 `ChatState.title`，缺省回退群 ID 文本）。
 * @param chatId 群聊 ID。
 * @param state 群聊状态。
 * @returns 非空的群聊标题文本。
 */
export function formatManagedChatTitle(
  chatId: number,
  state: Readonly<ChatState>
): string {
  const rawTitle: string | undefined = state.title?.trim();
  return rawTitle !== undefined && rawTitle.length > 0 ? rawTitle : `群聊 ${chatId}`;
}

/**
 * 构建单个已启用 `/init` 群聊的列表摘要视图。
 * @param chatId 群聊 ID。
 * @param state 群聊状态。
 * @param now 当前毫秒时间戳。
 * @returns 群列表摘要视图。
 */
function buildChatSummary(
  chatId: number,
  state: Readonly<ChatState>,
  now: number
): Readonly<MiniAppChatSummary> {
  const lockdownRemainingMs: number =
    state.lockdown !== undefined && state.lockdown.expiresAt > now
      ? state.lockdown.expiresAt - now
      : 0;
  return {
    chatId,
    title: formatManagedChatTitle(chatId, state),
    features: buildFeatureFlags(state),
    hotMessageCount: readChatHotMessageCount(chatId),
    qaPairCount: chatQaEntries.get(chatId)?.size ?? 0,
    isLockdownActive: lockdownRemainingMs > 0,
  };
}

/**
 * 列出全部当前已开启 `/init` 的受管群聊摘要列表（按 `chatId` 升序稳定排列）。
 * @returns 已初始化受管群聊摘要只读数组。
 */
export function listManagedChats(): readonly Readonly<MiniAppChatSummary>[] {
  const now: number = Date.now();
  const summaries: Readonly<MiniAppChatSummary>[] = [];
  for (const [chatId, state] of getChatStateCache()) {
    if (state.isInitEnabled !== true) continue;
    summaries.push(buildChatSummary(chatId, state, now));
  }
  summaries.sort(
    (left: Readonly<MiniAppChatSummary>, right: Readonly<MiniAppChatSummary>): number =>
      left.chatId - right.chatId
  );
  return summaries;
}

/**
 * 读取单个已开启 `/init` 群聊的详细状态视图；未开启 `/init` 时返回 `null`。
 * @param chatId 目标群聊 ID。
 * @returns 群详细状态视图或 `null`。
 */
export function getManagedChatDetail(
  chatId: number
): Readonly<MiniAppChatDetail> | null {
  const state: Readonly<ChatState> = getChatState(chatId);
  if (state.isInitEnabled !== true) return null;
  const now: number = Date.now();
  const summary: Readonly<MiniAppChatSummary> = buildChatSummary(chatId, state, now);

  const quietRemainingMs: number =
    state.quietUntil !== undefined && state.quietUntil > now
      ? state.quietUntil - now
      : 0;
  const lockdownRemainingMs: number =
    state.lockdown !== undefined && state.lockdown.expiresAt > now
      ? state.lockdown.expiresAt - now
      : 0;

  let botPermissions: Readonly<MiniAppChatBotPermissionsView> | null = null;
  if (state.botPermissions !== undefined) {
    const missingLabels: string[] = [];
    for (const key of BOT_CHAT_PERMISSION_KEYS) {
      if (state.botPermissions[key] !== true) {
        missingLabels.push(BOT_CHAT_PERMISSION_LABELS[key]);
      }
    }
    botPermissions = {
      canDeleteMessages: state.botPermissions.canDeleteMessages === true,
      canRestrictMembers: state.botPermissions.canRestrictMembers === true,
      canChangeInfo: state.botPermissions.canChangeInfo === true,
      missingLabels,
    };
  }

  let gagActiveCount: number = 0;
  const gagSessions: readonly GagSession[] | undefined = gagSessionsByChat.get(chatId);
  if (gagSessions !== undefined) {
    for (const session of gagSessions) {
      if (session.phase === "active") gagActiveCount++;
    }
  }

  let verifyActiveCount: number = 0;
  for (const record of activeVerificationSnapshots.values()) {
    if (record.chatId === chatId && !isTerminalVerificationPhase(record.phase)) {
      verifyActiveCount++;
    }
  }

  return {
    ...summary,
    hotMessageMax: VERBATIM_CONTEXT_MAX,
    quietRemainingMs,
    lockdownRemainingMs,
    botPermissions,
    translateTargetCount: state.translate?.length ?? 0,
    deleteMessageTargetCount: state.deleteMessageTargets?.length ?? 0,
    activeSessions: {
      gag: gagActiveCount,
      wed: (wedChats.get(chatId)?.sessions.size ?? 0) > 0,
      verify: verifyActiveCount,
      qaSet: qaFormSessions.has(chatId),
    },
  };
}
