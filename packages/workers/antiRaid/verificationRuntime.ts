/**
 * 入群验证状态机（`packages/states/verification.ts`）的核心解释器：负责同步状态更替、
 * 计时器、代际与修订号（`generation/revision`）镜像发布及崩溃恢复（跨模块约束见 `docs/cn/04-invariants.md`）。
 */
import { logger } from "../../infra/logger";
import {
  LOCKDOWN_KICK_DEDUPE_MS,
  VERIFICATION_RUNTIME_CAPACITY,
} from "../../consts/antiRaid/verification";
import {
  canAdmitVerificationRevision,
  deferredVerificationRecords,
  threadCommentConfirmations,
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
  verificationRevisionCapacityFatalState,
  verificationRuntimeCapacityFatalState,
} from "../../cache/workers/antiRaid/verification";
import type {
  AdoptVerificationsMessage,
  VerificationPersistedMessage,
} from "../../types/antiRaid/protocol";
import type {
  DeferredVerificationRecord,
} from "../../types/antiRaid/verification";
import type {
  VerificationDeleteEvent,
  VerificationDeferredEvent,
  VerificationUpsertEvent,
} from "../../types/antiRaid/events";
import {
  adoptVerificationState,
  transitionVerification,
} from "../../states/verification";
import type {
  VerificationEvent,
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import {
  parseVerificationKey,
  requireVerificationKey,
  verificationKey,
  verificationKeyPrefix,
} from "../../libs/verificationKey";
import type { ParsedVerificationKey } from "../../libs/verificationKey";
import { runVerificationEffects } from "./verificationEffects";
import {
  cancelReminderDelivery,
  clearReminderDeliveries,
  ensurePendingReminder,
} from "./verificationReminders";
import { trackAntiRaidTask } from "./taskTracker";
import type { VerificationEntry } from "../../types/antiRaid/internal";
import {
  isPersistedVerificationState,
  verificationSnapshot,
} from "./verificationSnapshot";
import { isTerminalVerificationPhase } from "../../states/verification/shared";
import {
  reportVerificationRevisionCapacity,
  reportVerificationRuntimeCapacity,
} from "./verificationAdmission";

declare const self: Worker;

/**
 * 为 `pending` 阶段启动验证超时计时器，为 `exempt`/`kicked` 阶段启动去重窗口计时器；
 * 终态阶段（`kickPending`、`checkingInviter`、`expelling`）由落盘回执与重试计时器驱动，不在此处挂计时器。
 * @param chatId 群组 ID。
 * @param userId 成员 ID。
 * @param state 当前验证状态。
 * @returns 启动的计时器句柄；终态阶段返回 undefined。
 */
function startVerificationTimer(
  chatId: number,
  userId: number,
  state: VerificationState
): ReturnType<typeof setTimeout> | undefined {
  switch (state.kind) {
    case "pending": {
      const expiryTimer: ReturnType<typeof setTimeout> = setTimeout(
        (): void => dispatchVerification(
          chatId,
          userId,
          { type: "verifyTimeout", now: Date.now() }
        ),
        Math.max(0, state.expiresAt - Date.now())
      );
      expiryTimer.unref();
      return expiryTimer;
    }
    case "kickPending":
    case "checkingInviter":
    case "expelling":
      return undefined;
    case "exempt":
    case "kicked": {
      const dedupeTimer: ReturnType<typeof setTimeout> = setTimeout(
        (): void => dispatchVerification(chatId, userId, { type: "dedupeExpired" }),
        LOCKDOWN_KICK_DEDUPE_MS
      );
      dedupeTimer.unref();
      return dedupeTimer;
    }
  }
}

/**
 * 把事件喂给某成员的状态机并同步落地结果；网络副作用异步执行，不阻塞
 * Worker mailbox 中后续投递。join 事件只由 verificationEvents.ts 的 handleJoinEvent
 * 在 admitVerificationJoin 准入之后派发，运行态与 revision 容量满额时不会到达这里。
 * @param chatId 群组 ID。
 * @param userId 成员 ID。
 * @param event 验证状态机事件。
 */
export function dispatchVerification(
  chatId: number,
  userId: number,
  event: VerificationEvent
): void {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  const previousWasPersisted: boolean =
    isPersistedVerificationState(entry?.state);
  const {
    next,
    effects,
    snapshotChanged = false,
    rescheduleTimer = false,
    retainPersistedSnapshot = false,
  }: VerificationTransition = transitionVerification(entry?.state, event);
  if (next !== entry?.state) {
    cancelReminderDelivery(key);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    if (next === undefined) {
      verificationEntries.delete(key);
    } else {
      verificationEntries.set(key, {
        state: next,
        timer: startVerificationTimer(chatId, userId, next),
        terminalRetries: 0,
        cleanupSettled: false,
      });
    }
  } else if (rescheduleTimer && entry !== undefined && next !== undefined) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = startVerificationTimer(chatId, userId, next);
  }
  if (snapshotChanged || next !== entry?.state) {
    if (retainPersistedSnapshot) {
      publishVerificationDeferred(chatId, userId);
    } else {
      publishVerificationChange(chatId, userId, previousWasPersisted);
    }
  }
  if (effects.length > 0) {
    void trackAntiRaidTask({
      task: runVerificationEffects({
        chatId,
        userId,
        effects,
        dispatchVerification,
      }).catch((error: unknown): void => {
        logger.error("Error running join verification effects:", error);
      }),
    });
  }
}

/**
 * 预算耗尽或许可无法确认时只发布最小延后索引，不递增 revision 或写删除墓碑。
 * @param chatId 群组 ID。
 * @param userId 成员 ID。
 */
function publishVerificationDeferred(chatId: number, userId: number): void {
  if (verificationGeneration.current <= 0) return;
  const key: string = verificationKey(chatId, userId);
  const revision: number | undefined = verificationRevisions.get(key)?.revision;
  if (revision === undefined) return;
  const record: DeferredVerificationRecord = {
    chatId,
    userId,
    generation: verificationGeneration.current,
    revision,
  };
  deferredVerificationRecords.set(key, record);
  verificationRevisions.set(key, { revision, retiredAt: Date.now() });
  self.postMessage({
    type: "verificationDeferred",
    record,
  } satisfies VerificationDeferredEvent);
}

/**
 * 离群或显式关闭时把本进程延后的磁盘终态转成正常 tombstone。
 * @param chatId 群组 ID。
 * @param userId 成员 ID。
 * @returns 存在延后记录并已转换为删除事件时返回 true，否则返回 false。
 */
export function deleteDeferredVerification(
  chatId: number,
  userId: number
): boolean {
  const key: string = verificationKey(chatId, userId);
  const deferred: DeferredVerificationRecord | undefined =
    deferredVerificationRecords.get(key);
  if (deferred === undefined) return false;
  deferredVerificationRecords.delete(key);
  const revision: number = deferred.revision + 1;
  verificationRevisions.set(key, { revision, retiredAt: Date.now() });
  self.postMessage({
    type: "verificationDelete",
    chatId,
    userId,
    generation: verificationGeneration.current,
    revision,
  } satisfies VerificationDeleteEvent);
  return true;
}

/**
 * pending/终态发布 upsert，只在彻底收尾后发布 delete。
 * @param chatId 群组 ID。
 * @param userId 成员 ID。
 * @param previousWasPersisted 转移前的状态是否曾发布过持久化快照。
 */
function publishVerificationChange(
  chatId: number,
  userId: number,
  previousWasPersisted: boolean
): void {
  if (verificationGeneration.current <= 0) return;
  const key: string = verificationKey(chatId, userId);
  const state: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const revision: number =
    (verificationRevisions.get(key)?.revision ?? 0) + 1;
  if (isPersistedVerificationState(state)) {
    verificationRevisions.set(key, { revision });
    self.postMessage({
      type: "verificationUpsert",
      record: verificationSnapshot({ chatId, userId, state, revision }),
    } satisfies VerificationUpsertEvent);
  } else if (previousWasPersisted) {
    verificationRevisions.set(key, { revision, retiredAt: Date.now() });
    self.postMessage({
      type: "verificationDelete",
      chatId,
      userId,
      generation: verificationGeneration.current,
      revision,
    } satisfies VerificationDeleteEvent);
  }
}

/**
 * 为主线程已有持久责任保留恢复槽；满额时只释放非持久去重。
 * 释放前经 reportVerificationRuntimeCapacity 锁住新 key（见 verificationAdmission.ts）。
 * @param key 待验证键（`chatId:userId`）。
 * @returns 已在表中或成功腾出恢复槽位时返回 true；全部槽位均为持久阶段无法腾出时返回 false。
 */
function reserveVerificationRecoverySlot(key: string): boolean {
  if (verificationEntries.has(key) || verificationEntries.size < VERIFICATION_RUNTIME_CAPACITY) return true;
  reportVerificationRuntimeCapacity();
  for (const [dedupeKey, entry] of verificationEntries) {
    if (isPersistedVerificationState(entry.state)) continue;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    cancelReminderDelivery(dedupeKey);
    verificationEntries.delete(dedupeKey);
    return true;
  }
  return false;
}

/**
 * Worker 重建时先清上一代运行态，再接管主线程持久镜像；重复 adopt 按 revision 幂等。
 * 同代增量恢复优先接管已有持久责任，运行态满额时不淘汰持久阶段。
 * @param message 主线程发来的验证恢复快照消息。
 */
export function adoptVerifications(message: AdoptVerificationsMessage): void {
  if (message.generation < verificationGeneration.current) return;
  if (message.generation > verificationGeneration.current) {
    for (const entry of verificationEntries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    verificationEntries.clear();
    verificationRevisions.clear();
    verificationRevisionCapacityFatalState.current = false;
    verificationRuntimeCapacityFatalState.current = false;
    deferredVerificationRecords.clear();
    threadCommentConfirmations.clear();
    clearReminderDeliveries();
    verificationGeneration.current = message.generation;
  }

  const now: number = Date.now();
  for (const record of message.deferredVerifications ?? []) {
    if (record.generation !== message.generation) continue;
    const key: string = verificationKey(record.chatId, record.userId);
    if (!canAdmitVerificationRevision(key)) {
      reportVerificationRevisionCapacity();
      return;
    }
    deferredVerificationRecords.set(key, { ...record });
    verificationRevisions.set(key, {
      revision: record.revision,
      retiredAt: now,
    });
  }

  for (const record of message.verifications) {
    const key: string = verificationKey(record.chatId, record.userId);
    if (!canAdmitVerificationRevision(key)) {
      reportVerificationRevisionCapacity();
      return;
    }
    if ((verificationRevisions.get(key)?.revision ?? 0) >= record.revision) {
      continue;
    }
    if (!reserveVerificationRecoverySlot(key)) return;
    verificationRevisions.set(key, { revision: record.revision });
    // 快照 → 状态的形状转换是纯逻辑，留在 states/verification/adopt.ts；本函数
    // 只负责计时器、提醒与补投这些有副作用的部分。
    const state: VerificationState = adoptVerificationState(record, now);
    // 同代增量重放先清旧 timer。
    const previousEntry: VerificationEntry | undefined = verificationEntries.get(key);
    if (previousEntry?.timer !== undefined) clearTimeout(previousEntry.timer);
    cancelReminderDelivery(key);
    verificationEntries.set(key, {
      state,
      timer: startVerificationTimer(record.chatId, record.userId, state),
      terminalRetries: 0,
      cleanupSettled: false,
    });
    if (state.kind === "pending" && record.expiresAt <= now) {
      dispatchVerification(
        record.chatId,
        record.userId,
        { type: "verifyTimeout", now }
      );
    } else if (state.kind === "pending") {
      ensurePendingReminder({
        chatId: record.chatId,
        userId: record.userId,
        state,
        dispatchVerification,
      });
    } else if (
      isTerminalVerificationPhase(state.kind) &&
      message.resumePersistedTerminals === true
    ) {
      dispatchVerification(record.chatId, record.userId, { type: "terminalPersisted" });
    }
  }
}

/**
 * 只有精确匹配当前终态 revision 的落盘回执才能启动副作用。
 * @param message 主线程发来的验证快照落盘确认消息。
 */
export function handleVerificationPersisted(
  message: VerificationPersistedMessage
): void {
  if (message.generation !== verificationGeneration.current) return;
  const knownRevision: number | undefined =
    verificationRevisions.get(message.key)?.revision;
  if (knownRevision !== message.revision) return;
  const parsed: ParsedVerificationKey | null = parseVerificationKey(message.key);
  if (parsed === null) return;
  const chatId: number = parsed.chatId;
  const userId: number = parsed.userId;
  const entry: VerificationEntry | undefined = verificationEntries.get(message.key);
  const state: VerificationState | undefined = entry?.state;
  if (state === undefined || !isTerminalVerificationPhase(state.kind)) return;
  // 成功播报的落盘回执立即收尾；其它重复回执不得绕过当前终态的退避 timer。
  if (!(state.kind === "expelling" && state.successNoticeSent === true) && entry?.timer !== undefined) return;
  dispatchVerification(chatId, userId, { type: "terminalPersisted" });
}

/**
 * 删除本群（key 以 prefix 开头）的全部 thread comment 确认 owner。
 * @param prefix 群组验证键前缀（`chatId:`）。
 */
function forgetChatThreadCommentConfirmations(prefix: string): void {
  for (const key of threadCommentConfirmations.keys()) {
    if (key.startsWith(prefix)) threadCommentConfirmations.delete(key);
  }
}

/**
 * 删除本群（key 以 prefix 开头）的全部延后验证记录。
 * @param chatId 群组 ID。
 * @param prefix 群组验证键前缀（`chatId:`）。
 */
function deleteChatDeferredVerifications(chatId: number, prefix: string): void {
  for (const key of deferredVerificationRecords.keys()) {
    if (!key.startsWith(prefix)) continue;
    deleteDeferredVerification(chatId, requireVerificationKey(key).userId);
  }
}

/**
 * 关闭入群守卫（`/antiraid disable`）：清理本群频道评论确认 owner，将每条验证记录经 `guardDisabled` 状态机转移收尾，并将延后记录转为删除墓碑。
 * @param chatId 群组 ID。
 */
export function disableJoinGuardChat(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  forgetChatThreadCommentConfirmations(prefix);
  // 按进入时的键快照逐个派发；状态机转移与副作用期间写入的键不在本次处理范围内。
  for (const key of [...verificationEntries.keys()]) {
    if (!key.startsWith(prefix)) continue;
    dispatchVerification(chatId, requireVerificationKey(key).userId, { type: "guardDisabled" });
  }
  deleteChatDeferredVerifications(chatId, prefix);
}

/**
 * 取消某群所有验证 owner，并为每条持久化记录发布 tombstone。
 * @param chatId 群组 ID。
 */
export function deactivateVerificationChat(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  forgetChatThreadCommentConfirmations(prefix);
  for (const [key, entry] of verificationEntries) {
    if (!key.startsWith(prefix)) continue;
    const userId: number = requireVerificationKey(key).userId;
    cancelReminderDelivery(key);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    verificationEntries.delete(key);
    if (isPersistedVerificationState(entry.state)) publishVerificationChange(chatId, userId, true);
  }
  deleteChatDeferredVerifications(chatId, prefix);
}

/** Worker 停止时清理所有本地 timer/owner；主线程镜像仍保留恢复数据。 */
export function stopVerificationRuntime(): void {
  clearReminderDeliveries();
  threadCommentConfirmations.clear();
  for (const entry of verificationEntries.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
  }
  verificationEntries.clear();
  verificationRevisions.clear();
  verificationRevisionCapacityFatalState.current = false;
  verificationRuntimeCapacityFatalState.current = false;
  deferredVerificationRecords.clear();
  verificationGeneration.current = 0;
}
