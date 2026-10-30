import type { ChatFullInfo } from "grammy/types";
import { observeChatKind } from "../../../antiRaid/chatKind";
import { chatIsSupergroupById } from "../../../cache/main/antiRaid/chatKind";
import {
  batchKickChats,
  miniAppBatchKickCompletedByChat,
} from "../../../cache/main/batchKick";
import { startBatchKickTask } from "../../../commands/batchKick";
import type { BatchKickStats } from "../../../commands/batchKick";
import { HOUR_MS } from "../../../consts/time";
import { readJoinLog } from "../../../infra/diskIO";
import { logger } from "../../../infra/logger";
import { getChatState } from "../../../infra/storage/stateStore";
import { telegramApi } from "../../../infra/telegram/client";
import type { ChatState } from "../../../types/chatState";
import type { JoinLogRecord } from "../../../types/diskIO/storage";
import type { MiniAppBatchKickResult } from "../../../types/miniApp";
import { getManagedChatDetail } from "./query";

/**
 * 确认受管群是否为超级群：优先读取主线程 `chatIsSupergroupById` 缓存，未命中时调用
 * `telegramApi.getChat(chatId)` 并经 `observeChatKind` 写回缓存与 Anti-Raid Worker 镜像。
 * @param chatId 目标群聊 ID。
 * @returns 确认为超级群时返回 `true`，确认为普通群时返回 `false`，探测失败或未知类型时返回 `undefined`。
 */
async function resolveIsSupergroup(chatId: number): Promise<boolean | undefined> {
  const cached: boolean | undefined = chatIsSupergroupById.get(chatId);
  if (cached !== undefined) return cached;
  try {
    const chat: ChatFullInfo = await telegramApi.getChat(chatId);
    observeChatKind(chat);
  } catch (error: unknown) {
    logger.error(
      `Failed to probe chat kind for /batch_kick in chat ${chatId}:`,
      error
    );
    return undefined;
  }
  return chatIsSupergroupById.get(chatId);
}

/**
 * 按指定回溯小时数（`1..24`）在已开启 `/init` 的超级群触发 `/batch_kick` 批量清理新进群成员任务。
 * @param chatId 目标群聊 ID。
 * @param hours 回溯小时数（`1..24`）。
 * @returns 批量清理任务触发结果及最新群详细状态。
 */
export async function triggerManagedChatBatchKick(
  chatId: number,
  hours: number
): Promise<Readonly<MiniAppBatchKickResult>> {
  const current: Readonly<ChatState> = getChatState(chatId);
  if (current.isInitEnabled !== true) {
    return {
      ok: false,
      outcome: "notInitialized",
      hours,
      recordCount: 0,
      message: "CHAT_NOT_INITIALIZED",
      detail: null,
    };
  }

  if (batchKickChats.has(chatId)) {
    return {
      ok: false,
      outcome: "running",
      hours,
      recordCount: 0,
      message: "BATCH_KICK_RUNNING",
      detail: await getManagedChatDetail(chatId),
    };
  }

  const isSupergroup: boolean | undefined = await resolveIsSupergroup(chatId);
  if (isSupergroup === undefined) {
    return {
      ok: false,
      outcome: "unavailable",
      hours,
      recordCount: 0,
      message: "CHAT_KIND_UNAVAILABLE",
      detail: await getManagedChatDetail(chatId),
    };
  }
  if (!isSupergroup) {
    return {
      ok: false,
      outcome: "notSupergroup",
      hours,
      recordCount: 0,
      message: "CHAT_NOT_SUPERGROUP",
      detail: await getManagedChatDetail(chatId),
    };
  }

  const durationMs: number = hours * HOUR_MS;
  const now: number = Date.now();
  let records: readonly JoinLogRecord[];
  try {
    records = await readJoinLog({
      chatId,
      since: now - durationMs,
      now,
    });
  } catch (error: unknown) {
    logger.error(
      `Failed to read join logs for /batch_kick in chat ${chatId}:`,
      error
    );
    return {
      ok: false,
      outcome: "unavailable",
      hours,
      recordCount: 0,
      message: "JOIN_LOG_UNAVAILABLE",
      detail: await getManagedChatDetail(chatId),
    };
  }

  if (records.length === 0) {
    return {
      ok: true,
      outcome: "empty",
      hours,
      recordCount: 0,
      message: "BATCH_KICK_EMPTY",
      detail: await getManagedChatDetail(chatId),
    };
  }

  miniAppBatchKickCompletedByChat.delete(chatId);
  const recordCount: number = records.length;
  const accepted: boolean = startBatchKickTask({
    chatId,
    source: "api",
    durationMs,
    records,
    onComplete: (stats: Readonly<BatchKickStats>): void => {
      if (stats.unmanaged || getChatState(chatId).isInitEnabled !== true) {
        miniAppBatchKickCompletedByChat.delete(chatId);
        return;
      }
      miniAppBatchKickCompletedByChat.set(chatId, {
        hours,
        recordCount,
        scanned: stats.scanned,
        kicked: stats.kicked,
        absent: stats.absent,
        protected: stats.protected,
        blocked: stats.blocked,
        forbidden: stats.forbidden,
        failed: stats.failed,
        aborted: stats.aborted,
        unmanaged: stats.unmanaged,
        completedAt: Date.now(),
      });
    },
  });
  if (!accepted) {
    return {
      ok: false,
      outcome: "busy",
      hours,
      recordCount,
      message: "BATCH_KICK_BUSY",
      detail: await getManagedChatDetail(chatId),
    };
  }

  return {
    ok: true,
    outcome: "accepted",
    hours,
    recordCount,
    message: "BATCH_KICK_ACCEPTED",
    detail: await getManagedChatDetail(chatId),
  };
}
