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
import type { ChatState } from "../../../types/chatState";
import type { JoinLogRecord } from "../../../types/diskIO/storage";
import type { MiniAppBatchKickResult } from "../../../types/miniApp";
import { getManagedChatDetail } from "./query";

/**
 * 按指定回溯小时数（`1..24`）在已开启 `/init` 的群聊触发 `/batch_kick` 批量清理新进群成员任务。
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
