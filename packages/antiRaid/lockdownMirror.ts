/**
 * Anti-Raid 主线程侧的 lockdown 镜像与紧急恢复。
 *
 * ChatState.lockdown 是跨进程恢复的权威记录；本模块只维护落盘指纹、构造
 * Worker adopt 消息，并在 Worker 耗尽重建预算后接管邀请权限恢复与本轮封锁
 * 公告的定向删除。
 */
import { logger } from "../infra/logger";
import {
  clearChatStateField,
  getChatStateCache,
  saveChatStateInBackground,
} from "../infra/storage/stateStore";
import { telegramApi } from "../infra/telegram/client";
import { deleteMessageWithOutcome } from "../infra/telegram/actions";
import { restoreLockdownInvitePermission } from "../infra/telegram/lockdownPermissions";
import { RESTORE_RETRY_MS } from "../consts/antiRaid/lockdown";
import { antiRaidRuntimeState } from "../cache/main/antiRaid/proxy";
import {
  emergencyLockdownRecoveries,
  emergencyLockdownRecoveryRuntime,
  persistedLockdownFingerprints,
} from "../cache/main/antiRaid/lockdownMirror";
import type {
  EmergencyLockdownRecovery,
  LockdownIntentFingerprint,
  PersistedLockdownFingerprint,
} from "../types/antiRaid/internal";
import type { AdoptableLockdown, AdoptLockdownsMessage } from
  "../types/antiRaid/protocol";
import type { LockdownRecord } from "../types/chatState";

/**
 * 提取群封锁记录的持久化指纹（不含 `expiresAt`）。
 *
 * @param record 群状态中的封锁记录
 * @returns 包含 `phase`、`intentId` 与 `announced` 的持久化指纹
 */
export function lockdownFingerprint(record: LockdownRecord): PersistedLockdownFingerprint {
  return {
    phase: record.phase,
    intentId: record.intentId,
    announced: record.announced,
  };
}

/**
 * 比较 phase、intentId 与 announced 是否已落盘；ACTIVE/RECONCILING 的截止时刻
 * 在激活时确定，后续入群不刷新。APPLYING/RESTORING 发布时使用当前时间，
 * 因此 expiresAt 不参与恢复语义指纹，见 types/antiRaid/internal.ts。
 *
 * @param record 当前群状态中的封锁记录
 * @param fingerprint 已落盘的封锁指纹；尚未落盘时为 undefined
 * @returns 当前记录的恢复语义与已落盘指纹一致时返回 true，否则返回 false
 */
export function lockdownFingerprintMatches(
  record: LockdownRecord,
  fingerprint: PersistedLockdownFingerprint | undefined
): boolean {
  const current: PersistedLockdownFingerprint = lockdownFingerprint(record);
  return fingerprint?.phase === current.phase &&
    fingerprint.intentId === current.intentId &&
    fingerprint.announced === current.announced;
}

/**
 * 提取封锁记录的阶段与意图标识指纹。
 *
 * @param record 群状态中的封锁记录
 * @returns 仅含 `phase` 与 `intentId` 的封锁意图指纹
 */
function lockdownIntentFingerprint(record: LockdownRecord): LockdownIntentFingerprint {
  return { phase: record.phase, intentId: record.intentId };
}

/**
 * 判断当前封锁记录是否仍处于同一阶段与同一封锁意图。
 *
 * @param record 当前群状态中的封锁记录
 * @param fingerprint 待比对的封锁意图指纹
 * @returns `phase` 与 `intentId` 均一致时返回 true，否则返回 false
 */
function lockdownIntentMatches(
  record: LockdownRecord,
  fingerprint: LockdownIntentFingerprint
): boolean {
  return record.phase === fingerprint.phase && record.intentId === fingerprint.intentId;
}

/**
 * 将群状态中的封锁记录换算为可供 Worker 接管的快照条目。
 *
 * @param chatId 群聊 ID
 * @param record 群状态中的封锁记录
 * @param now 当前毫秒时间戳
 * @returns 包含剩余毫秒数与落盘状态的 Worker 接管封锁条目
 */
function toAdoptableLockdown(
  chatId: number,
  record: LockdownRecord,
  now: number
): AdoptableLockdown {
  return {
    chatId,
    phase: record.phase,
    intentId: record.intentId,
    originalPermissions: record.originalPermissions,
    announced: record.announced,
    announcementMessageId: record.announcementMessageId,
    remainingMs: Math.max(0, record.expiresAt - now),
    persisted: lockdownFingerprintMatches(record, persistedLockdownFingerprints.get(chatId)),
  };
}

/**
 * 把仍在生效的私密模式打包成 adopt 消息，并换算各自的真实剩余时长。
 *
 * @returns 发送给 Anti-Raid Worker 的私密模式接管消息载荷
 */
export function buildAdoptLockdownsMessage(): AdoptLockdownsMessage {
  const lockdowns: AdoptableLockdown[] = [];
  const now: number = Date.now();
  for (const [chatId, chatState] of getChatStateCache()) {
    if (chatState.lockdown) {
      lockdowns.push(toAdoptableLockdown(chatId, chatState.lockdown, now));
    }
  }
  return { type: "adopt", lockdowns };
}

/** 用启动时已从 SQLite 恢复的记录播种“已持久化”指纹。 */
export function seedPersistedLockdownFingerprints(): void {
  persistedLockdownFingerprints.clear();
  for (const [chatId, chatState] of getChatStateCache()) {
    if (chatState.lockdown !== undefined) {
      persistedLockdownFingerprints.set(chatId, lockdownFingerprint(chatState.lockdown));
    }
  }
}

/**
 * 停止指定群紧急恢复的重试定时器并从活动恢复表中摘除。
 *
 * @param chatId 群聊 ID
 * @param recovery 待结束的紧急封锁恢复状态对象
 */
function finishEmergencyLockdownRecovery(
  chatId: number,
  recovery: EmergencyLockdownRecovery
): void {
  if (recovery.retryTimer !== null) {
    clearTimeout(recovery.retryTimer);
    recovery.retryTimer = null;
  }
  if (emergencyLockdownRecoveries.get(chatId) === recovery) {
    emergencyLockdownRecoveries.delete(chatId);
  }
}

/**
 * 紧急恢复完成时撤掉本轮封锁公告。只经统一删除动作发出一次，不重试、不排定时删除；
 * API 失败已由统一 Telegram 错误日志记录，这里只兜住边界自身的意外异常。
 *
 * @param chatId 群聊 ID
 * @param messageId 封锁公告的 message_id
 */
function deleteEmergencyLockdownAnnouncement(chatId: number, messageId: number): void {
  void deleteMessageWithOutcome(chatId, messageId, telegramApi).catch((error: unknown): void => {
    logger.error(
      `Error deleting the anti-raid lockdown announcement in chat ${chatId} after emergency restore:`,
      error
    );
  });
}

/**
 * 执行一轮主线程紧急封锁恢复：还原群邀请权限、删除封锁公告并清除群状态中的 lockdown 记录；失败时安排重试。
 *
 * @param chatId 群聊 ID
 * @param recovery 当前群的紧急封锁恢复状态对象
 */
function runEmergencyLockdownRecovery(
  chatId: number,
  recovery: EmergencyLockdownRecovery
): void {
  if (
    emergencyLockdownRecoveryRuntime.stopped ||
    emergencyLockdownRecoveries.get(chatId) !== recovery ||
    recovery.inFlight !== null
  ) return;

  const task: Promise<void> = (async (): Promise<void> => {
    const before: LockdownRecord | undefined = getChatStateCache().get(chatId)?.lockdown;
    if (
      before === undefined ||
      !lockdownIntentMatches(before, recovery.fingerprint)
    ) {
      finishEmergencyLockdownRecovery(chatId, recovery);
      return;
    }
    try {
      await restoreLockdownInvitePermission({
        chatId,
        originalPermissions: recovery.originalPermissions,
        api: telegramApi,
      });
      if (
        emergencyLockdownRecoveryRuntime.stopped ||
        emergencyLockdownRecoveries.get(chatId) !== recovery
      ) {
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      const current: LockdownRecord | undefined = getChatStateCache().get(chatId)?.lockdown;
      if (
        current === undefined ||
        !lockdownIntentMatches(current, recovery.fingerprint)
      ) {
        logger.warn(
          `Emergency anti-raid restore for chat ${chatId} completed after its lockdown intent changed; ` +
          "leaving the newer state untouched."
        );
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      if (current.announcementMessageId !== undefined) {
        deleteEmergencyLockdownAnnouncement(chatId, current.announcementMessageId);
      }
      persistedLockdownFingerprints.delete(chatId);
      if (clearChatStateField(chatId, "lockdown")) {
        saveChatStateInBackground(chatId, "emergency anti-raid unlock");
        antiRaidRuntimeState.lockdownVersion++;
      }
      logger.log(`Emergency anti-raid permission restore completed for chat ${chatId}.`);
      finishEmergencyLockdownRecovery(chatId, recovery);
    } catch (error: unknown) {
      const current: LockdownRecord | undefined = getChatStateCache().get(chatId)?.lockdown;
      if (
        emergencyLockdownRecoveryRuntime.stopped ||
        current === undefined ||
        !lockdownIntentMatches(current, recovery.fingerprint) ||
        emergencyLockdownRecoveries.get(chatId) !== recovery
      ) {
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      logger.error(
        `Emergency anti-raid permission restore failed for chat ${chatId}; ` +
        `retrying in ${RESTORE_RETRY_MS / 1000}s:`,
        error
      );
      recovery.retryTimer = setTimeout((): void => {
        recovery.retryTimer = null;
        runEmergencyLockdownRecovery(chatId, recovery);
      }, RESTORE_RETRY_MS);
      recovery.retryTimer.unref();
    }
  })();
  recovery.inFlight = task;
  const settle = (): void => {
    if (recovery.inFlight === task) recovery.inFlight = null;
  };
  void task.then(settle, settle);
}

/**
 * 为指定群登记并启动主线程紧急封锁恢复（同阶段与同意图已在恢复中时不重复启动）。
 *
 * @param chatId 群聊 ID
 * @param record 群状态中的封锁记录
 */
function startEmergencyLockdownRecovery(chatId: number, record: LockdownRecord): void {
  const fingerprint: LockdownIntentFingerprint = lockdownIntentFingerprint(record);
  const existing: EmergencyLockdownRecovery | undefined =
    emergencyLockdownRecoveries.get(chatId);
  if (existing !== undefined) {
    if (
      existing.fingerprint.phase === fingerprint.phase &&
      existing.fingerprint.intentId === fingerprint.intentId
    ) return;
    finishEmergencyLockdownRecovery(chatId, existing);
  }
  const recovery: EmergencyLockdownRecovery = {
    fingerprint,
    originalPermissions: { ...record.originalPermissions },
    retryTimer: null,
    inFlight: null,
  };
  emergencyLockdownRecoveries.set(chatId, recovery);
  runEmergencyLockdownRecovery(chatId, recovery);
}

/** 停机时停止全部主线程紧急封锁恢复的重试定时器并清空恢复表。 */
export function stopEmergencyLockdownRecoveries(): void {
  emergencyLockdownRecoveryRuntime.stopped = true;
  for (const recovery of emergencyLockdownRecoveries.values()) {
    if (recovery.retryTimer !== null) {
      clearTimeout(recovery.retryTimer);
      recovery.retryTimer = null;
    }
  }
  // 停机时标记 stopped 并清空恢复表；在途请求完成后不再修改群状态，保留 lockdown 记录供下次启动恢复。
  emergencyLockdownRecoveries.clear();
}

/**
 * 群已不存在（teardown 起因 gone）且主线程紧急恢复已接管时，终止该群的紧急恢复并清除 lockdown 记录。
 *
 * @param chatId 群聊 ID
 */
export function abandonEmergencyLockdownRecovery(chatId: number): void {
  const recovery: EmergencyLockdownRecovery | undefined =
    emergencyLockdownRecoveries.get(chatId);
  if (recovery === undefined) return;
  finishEmergencyLockdownRecovery(chatId, recovery);
  persistedLockdownFingerprints.delete(chatId);
  if (clearChatStateField(chatId, "lockdown")) {
    saveChatStateInBackground(chatId, "abandoned emergency anti-raid lockdown");
    antiRaidRuntimeState.lockdownVersion++;
  }
}

/** Worker 自愈放弃后，由主线程独立接管仍挂着的邀请权限恢复。 */
export function recoverAbandonedLockdowns(): void {
  const abandoned: number[] = [];
  for (const [chatId, chatState] of getChatStateCache()) {
    if (chatState.lockdown === undefined) continue;
    abandoned.push(chatId);
    startEmergencyLockdownRecovery(chatId, chatState.lockdown);
  }
  if (abandoned.length === 0) return;
  logger.error(
    "Anti-raid Worker gave up self-healing; main-thread emergency permission recovery started for chats: " +
    abandoned.join(", ")
  );
}
