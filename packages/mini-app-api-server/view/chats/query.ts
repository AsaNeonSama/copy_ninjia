import { aiMemoryUsages, latestAiMemories } from "../../../cache/main/aiChat";
import { activeVerificationSnapshots } from "../../../cache/main/antiRaid/verificationMirror";
import {
  batchKickChats,
  miniAppBatchKickCompletedByChat,
} from "../../../cache/main/batchKick";
import { gagSessionsByChat } from "../../../cache/main/gag";
import { chatQaEntries, qaFormSessions } from "../../../cache/main/qa";
import { wedChats } from "../../../cache/main/wed";
import { VERBATIM_CONTEXT_MAX } from "../../../consts/aiChat/memory";
import {
  BOT_CHAT_PERMISSION_KEYS,
  BOT_CHAT_PERMISSION_LABELS,
} from "../../../consts/botAdmin";
import { MINI_APP_BATCH_KICK_MAX_HOURS } from "../../../consts/miniApp";
import { DAY_MS, HOUR_MS } from "../../../consts/time";
import { readJoinLog } from "../../../infra/diskIO";
import {
  getChatState,
  getChatStateCache,
} from "../../../infra/storage/stateStore";
import { parseAiMemorySnapshot } from "../../../libs/persistedSnapshotCodec";
import { isTerminalVerificationPhase } from "../../../states/verification/shared";
import type { ChatState } from "../../../types/chatState";
import type { JoinLogRecord } from "../../../types/diskIO/storage";
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
 * 读取指定群在最近 1..24 小时各滚动回溯窗口（`[now - hours * HOUR_MS, now]`）内的去重入群人数。
 * Disk I/O 未就绪或读取异常时返回全 `0` 数组。
 * @param chatId 群聊 ID。
 * @param now 当前毫秒时间戳。
 * @returns 长度 24 的去重入群人数只读数组（下标 `hours - 1` 对应最近 `hours` 小时）。
 */
export async function readChatJoinedCountsByHour(
  chatId: number,
  now: number
): Promise<readonly number[]> {
  const counts: number[] = Array.from(
    { length: MINI_APP_BATCH_KICK_MAX_HOURS },
    (): number => 0
  );
  const since: number = Math.max(0, now - DAY_MS);
  try {
    const records: readonly JoinLogRecord[] = await readJoinLog({
      chatId,
      since,
      now,
    });
    for (const record of records) {
      if (record.joinedAt < since || record.joinedAt > now) continue;
      const startHour: number = Math.min(
        MINI_APP_BATCH_KICK_MAX_HOURS,
        Math.max(1, Math.ceil((now - record.joinedAt) / HOUR_MS))
      );
      counts[startHour - 1] = (counts[startHour - 1] ?? 0) + 1;
    }
    for (let index: number = 1; index < MINI_APP_BATCH_KICK_MAX_HOURS; index += 1) {
      counts[index] = (counts[index] ?? 0) + (counts[index - 1] ?? 0);
    }
    return counts;
  } catch (_error: unknown) {
    return counts;
  }
}

/**
 * 读取单个已开启 `/init` 群聊的详细状态视图；未开启 `/init` 时返回 `null`。
 * @param chatId 目标群聊 ID。
 * @returns 群详细状态视图或 `null`。
 */
export async function getManagedChatDetail(
  chatId: number
): Promise<Readonly<MiniAppChatDetail> | null> {
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
    const grantedLabels: string[] = [];
    for (const key of BOT_CHAT_PERMISSION_KEYS) {
      if (state.botPermissions[key] === true) {
        grantedLabels.push(BOT_CHAT_PERMISSION_LABELS[key]);
      }
    }
    botPermissions = {
      canDeleteMessages: state.botPermissions.canDeleteMessages === true,
      canRestrictMembers: state.botPermissions.canRestrictMembers === true,
      canChangeInfo: state.botPermissions.canChangeInfo === true,
      grantedLabels,
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

  const joinedCountsByHour: readonly number[] = await readChatJoinedCountsByHour(
    chatId,
    now
  );
  const batchKickRunning: boolean = batchKickChats.has(chatId);

  return {
    ...summary,
    hotMessageMax: VERBATIM_CONTEXT_MAX,
    quietRemainingMs,
    lockdownRemainingMs,
    botPermissions,
    translateTargetCount: state.translate?.length ?? 0,
    deleteMessageTargetCount: state.deleteMessageTargets?.length ?? 0,
    joinedCountsByHour,
    batchKickRunning,
    lastBatchKickCompletion: batchKickRunning
      ? null
      : (miniAppBatchKickCompletedByChat.get(chatId) ?? null),
    activeSessions: {
      gag: gagActiveCount,
      wed: (wedChats.get(chatId)?.sessions.size ?? 0) > 0,
      verify: verifyActiveCount,
      qaSet: qaFormSessions.has(chatId),
    },
  };
}
