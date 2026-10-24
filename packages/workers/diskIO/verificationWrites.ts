/** 待验证增量缓冲、timer、append 与持久化回执（所属线程：Disk I/O Worker）。 */

import { mkdirSync } from "node:fs";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { VERIFICATION_RECORD_CAPACITY } from "../../consts/antiRaid/verification";
import {
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_COMPACT_ENTRIES,
  VERIFICATION_ROLLOVER_RETRY_MS,
} from "../../consts/diskIO/verification";
import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../consts/diskIO/appendOnly";
import { VERIFICATION_MEMORY_DIR } from "../../consts/paths";
import {
  verificationBatchFlush,
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverRetryTimer,
  verificationWorkerCache,
} from "../../cache/workers/diskIO/verification";
import { getDateKey } from "../../libs/time";
import { verificationKey } from "../../libs/verificationKey";
import type { VerificationSnapshot } from
  "../../types/antiRaid/verification";
import type {
  VerificationDeleteDiskMessage,
  VerificationFileChange,
  VerificationUpsertDiskMessage,
} from "../../types/diskIO/messages";
import type { VerificationPersistedReply } from "../../types/diskIO/replies";
import type { VerificationFlushTarget } from "../../types/diskIO/storage";
import { appendToDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";
import { storedVerificationSnapshot } from "./verificationCodec";
import {
  compactVerificationDay,
  removeOldVerificationDays,
} from "./verificationRecovery";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";

/** 向主线程发送入群验证持久化回执的回调签名。 */
export type VerificationReplySink = (reply: VerificationPersistedReply) => void;

/**
 * 判断待写变更是否属于同一 generation 且版本号不低于目标 revision。
 * @param change 当前挂起的待写变更。
 * @param generation 消息携带的会话代次。
 * @param revision 消息携带的单调递增版本号。
 * @returns 已存在同代且不旧于目标版本的待写项时返回 true，否则返回 false。
 */
function sameOrNewer(
  change: VerificationFileChange | undefined,
  generation: number,
  revision: number
): boolean {
  return change?.generation === generation && change.revision >= revision;
}

/**
 * 摘除未发生后续覆盖的待写变更并逐条发送 `verificationPersisted` 回执。
 * @param changes 本批已成功落盘的 `[key, change]` 列表。
 * @param reply 向主线程发送持久化回执的出口。
 */
function acknowledge(
  changes: [string, VerificationFileChange][],
  reply: VerificationReplySink
): void {
  for (const [key, change] of changes) {
    if (verificationPendingChanges.get(key) === change) {
      verificationPendingChanges.delete(key);
    }
    reply({
      type: "verificationPersisted",
      key,
      generation: change.generation,
      revision: change.revision,
      deleted: change.value === null,
    });
  }
}

/**
 * 跨日先发布新日 active 快照与 tombstone，成功后删除旧日文件并确认待写变更。
 * @param day 目标 `YYYY-MM-DD` 日期键。
 * @param reply 向主线程发送持久化回执的出口。
 * @param dir 待验证目录路径。
 */
async function rolloverVerificationDay(
  day: string,
  reply: VerificationReplySink,
  dir: string
): Promise<void> {
  const changes: [string, VerificationFileChange][] = [
    ...verificationPendingChanges.entries(),
  ];
  await compactVerificationDay(day, dir);
  await removeOldVerificationDays(day, dir);
  acknowledge(changes, reply);
}

/**
 * 注册跨日轮换失败后的重试定时器。
 * @param reply 向主线程发送持久化回执的出口。
 * @param dir 待验证目录路径。
 */
function scheduleVerificationRolloverRetry(
  reply: VerificationReplySink,
  dir: string
): void {
  armDiskIOFlushTimer(
    verificationRolloverRetryTimer,
    VERIFICATION_ROLLOVER_RETRY_MS,
    (): Promise<void> => maintainVerificationDayForToday(reply, getDateKey(), dir)
  );
}

/**
 * 发布目标日的 active 快照并清理旧日文件；失败时保留镜像并注册重试定时器。
 * @param reply 向主线程发送持久化回执的出口。
 * @param day 目标 `YYYY-MM-DD` 日期键；缺省为当前时刻。
 * @param dir 待验证目录路径；缺省为 `VERIFICATION_MEMORY_DIR`。
 */
export async function maintainVerificationDayForToday(
  reply: VerificationReplySink,
  day: string = getDateKey(),
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<void> {
  cancelDiskIOFlushTimer(verificationFlushTimer);
  cancelDiskIOFlushTimer(verificationRolloverRetryTimer);
  try {
    await rolloverVerificationDay(day, reply, dir);
  } catch (error: unknown) {
    console.error("[diskIOWorker] failed to roll pending verification day:", error);
    scheduleVerificationRolloverRetry(reply, dir);
  }
}

/**
 * 按需注册待验证普通变更的定时落盘 timer。
 * @param reply 向主线程发送持久化回执的出口。
 * @param dir 待验证目录路径。
 */
function scheduleVerificationFlush(
  reply: VerificationReplySink,
  dir: string
): void {
  armDiskIOFlushTimer(
    verificationFlushTimer,
    FLUSH_INTERVAL_MS,
    (): Promise<boolean> => flushVerificationChanges(reply, dir)
  );
}

/**
 * 关键变更落盘：在批处理期间仅登记目标，批外立即 flush。
 * @param reply 向主线程发送持久化回执的出口。
 * @param dir 待验证目录路径。
 * @param day 目标 `YYYY-MM-DD` 日期键。
 */
async function flushCriticalVerificationChanges(
  reply: VerificationReplySink,
  dir: string,
  day: string
): Promise<void> {
  if (verificationBatchFlush.active) {
    verificationBatchFlush.target = { dir, day };
    return;
  }
  await flushVerificationChanges(reply, dir, day);
}

/**
 * 在 operationBatch 执行期间合并待验证关键变更的落盘，在 finally 中统一 flush 一次。
 * @param reply 向主线程发送持久化回执的出口。
 * @param run 批次内顺序处理各消息的异步回调。
 */
export async function withVerificationBatchFlush(
  reply: VerificationReplySink,
  run: () => Promise<void>
): Promise<void> {
  verificationBatchFlush.active = true;
  try {
    await run();
  } finally {
    const target: VerificationFlushTarget | null = verificationBatchFlush.target;
    verificationBatchFlush.active = false;
    verificationBatchFlush.target = null;
    if (target !== null) await flushVerificationChanges(reply, target.dir, target.day);
  }
}

/** 处理待验证 upsert 消息的参数。 */
export interface HandleVerificationUpsertParams {
  /** 待验证快照新增或更新消息。 */
  msg: VerificationUpsertDiskMessage;
  /** 向主线程发送持久化回执的出口。 */
  reply: VerificationReplySink;
  /** 待验证目录路径；缺省为 `VERIFICATION_MEMORY_DIR`。 */
  dir?: string;
  /** 当前 `YYYY-MM-DD` 日期键；缺省为当前时刻。 */
  day?: string;
}

/**
 * 处理待验证 upsert：按 generation/revision 去重后更新镜像，关键变更或满批立即落盘，否则定时落盘。
 * @param params upsert 消息、回执出口及可选目录与日期键。
 */
export async function handleVerificationUpsert({
  msg,
  reply,
  dir = VERIFICATION_MEMORY_DIR,
  day = getDateKey(),
}: HandleVerificationUpsertParams): Promise<void> {
  const key: string = verificationKey(msg.record.chatId, msg.record.userId);
  const pending: VerificationFileChange | undefined =
    verificationPendingChanges.get(key);
  if (sameOrNewer(pending, msg.record.generation, msg.record.revision)) return;
  const current: VerificationSnapshot | undefined = verificationWorkerCache.get(key);
  if (
    current?.generation === msg.record.generation &&
    current.revision >= msg.record.revision
  ) return;
  if (
    current === undefined &&
    verificationWorkerCache.size >= VERIFICATION_RECORD_CAPACITY
  ) {
    throw new RangeError(
      `Verification persistence capacity (${VERIFICATION_RECORD_CAPACITY}) exceeded.`
    );
  }

  const snapshot: VerificationSnapshot = msg.record;
  verificationWorkerCache.set(key, snapshot);
  verificationPendingChanges.set(key, {
    chatId: snapshot.chatId,
    userId: snapshot.userId,
    generation: snapshot.generation,
    revision: snapshot.revision,
    value: snapshot,
  });
  if (msg.critical) {
    await flushCriticalVerificationChanges(reply, dir, day);
  } else if (verificationPendingChanges.size >= FLUSH_MAX_ENTRIES) {
    await flushVerificationChanges(reply, dir, day);
  } else {
    scheduleVerificationFlush(reply, dir);
  }
}

/** 处理待验证删除消息的参数。 */
export interface HandleVerificationDeleteParams {
  /** 待验证快照删除消息。 */
  msg: VerificationDeleteDiskMessage;
  /** 向主线程发送持久化回执的出口。 */
  reply: VerificationReplySink;
  /** 待验证目录路径；缺省为 `VERIFICATION_MEMORY_DIR`。 */
  dir?: string;
  /** 当前 `YYYY-MM-DD` 日期键；缺省为当前时刻。 */
  day?: string;
}

/**
 * 处理待验证删除：从镜像移除并登记 null 墓碑，按关键变更立即落盘或批末落盘。
 * @param params 删除消息、回执出口及可选目录与日期键。
 */
export async function handleVerificationDelete({
  msg,
  reply,
  dir = VERIFICATION_MEMORY_DIR,
  day = getDateKey(),
}: HandleVerificationDeleteParams): Promise<void> {
  const key: string = verificationKey(msg.chatId, msg.userId);
  const pending: VerificationFileChange | undefined =
    verificationPendingChanges.get(key);
  if (sameOrNewer(pending, msg.generation, msg.revision)) return;
  const current: VerificationSnapshot | undefined = verificationWorkerCache.get(key);
  if (
    current?.generation === msg.generation &&
    current.revision >= msg.revision
  ) return;

  verificationWorkerCache.delete(key);
  verificationPendingChanges.set(key, {
    chatId: msg.chatId,
    userId: msg.userId,
    generation: msg.generation,
    revision: msg.revision,
    value: null,
  });
  await flushCriticalVerificationChanges(reply, dir, day);
}

/**
 * 刷写待验证增量：跨日或尚未接管当日文件时先走 `rolloverVerificationDay` 轮换日文件，
 * 否则批量追加本窗口最终变化，并在历史越过阈值时原子收敛 active 镜像。
 * @param reply 向主线程发送持久化回执的出口。
 * @param dir 待验证目录路径；缺省为 `VERIFICATION_MEMORY_DIR`。
 * @param day 目标 `YYYY-MM-DD` 日期键；缺省为当前时刻。
 * @returns 待写变更全部落盘成功或为空时返回 true，写盘失败时返回 false。
 */
export async function flushVerificationChanges(
  reply: VerificationReplySink,
  dir: string = VERIFICATION_MEMORY_DIR,
  day: string = getDateKey()
): Promise<boolean> {
  cancelDiskIOFlushTimer(verificationFlushTimer);

  try {
    mkdirSync(dir, { recursive: true });
    if (verificationFileState.current?.day !== day) {
      await rolloverVerificationDay(day, reply, dir);
      cancelDiskIOFlushTimer(verificationRolloverRetryTimer);
      return true;
    }
    if (verificationPendingChanges.size === 0) return true;

    const changes: [string, VerificationFileChange][] = [
      ...verificationPendingChanges.entries(),
    ];
    const chunks: string[] = [];
    for (const [key, change] of changes) {
      chunks.push(serializeDayFileEntry(
        key,
        change.value === null
          ? null
          : storedVerificationSnapshot(change.value)
      ));
    }
    const chunk: string = chunks.join(",\n");
    const appendedBytes: number = Buffer.byteLength(chunk) +
      (verificationFileState.current.empty ? 4 : 2);
    if (
      verificationFileState.appendedEntries + changes.length >=
        VERIFICATION_FILE_COMPACT_ENTRIES ||
      verificationFileState.appendedBytes + appendedBytes >=
        VERIFICATION_FILE_COMPACT_BYTES
    ) {
      await compactVerificationDay(day, dir);
      acknowledge(changes, reply);
      return true;
    }

    await appendToDayFile({
      dir,
      state: verificationFileState.current,
      chunk,
      mode: PERSISTED_FILE_MODE,
    });
    verificationFileState.appendedEntries += changes.length;
    verificationFileState.appendedBytes += appendedBytes;
    acknowledge(changes, reply);
    return true;
  } catch (error: unknown) {
    verificationFileState.current = null;
    console.error("[diskIOWorker] failed to append pending verification JSON:", error);
    scheduleVerificationFlush(reply, dir);
    return false;
  }
}
