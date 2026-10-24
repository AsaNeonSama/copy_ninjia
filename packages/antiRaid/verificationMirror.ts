import { antiRaidRuntimeState } from "../cache/main/antiRaid/proxy";
import {
  activeVerificationSnapshots,
  clearActiveVerificationSnapshots,
  deleteActiveVerificationSnapshot,
  setActiveVerificationSnapshot,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
  terminalVerificationAttempts,
  verificationCapacityFatalState,
} from "../cache/main/antiRaid/verificationMirror";
import { VERIFICATION_RECORD_CAPACITY } from "../consts/antiRaid/verification";
import { verificationKey } from "../libs/verificationKey";
import { isTerminalVerificationPhase } from "../states/verification/shared";
import { postDiskIO } from "../infra/diskIO";
import { signalBusinessWorkerFatal } from "../infra/workerSupervisor";
import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "../types/antiRaid/verification";
import type {
  VerificationDeleteEvent,
  VerificationUpsertEvent,
} from "../types/antiRaid/events";

/**
 * 提取同代际条目的 revision 水位线；非当前代际条目视为无基线。
 *
 * @param entry 包含代际编号与修订号的镜像条目
 * @returns 与当前 Worker 代际匹配时返回其修订号，否则返回 0
 */
function currentGenerationRevision(
  entry: Readonly<{ generation: number; revision: number }> | undefined
): number {
  if (entry?.generation !== antiRaidRuntimeState.generation) return 0;
  return entry.revision;
}

/**
 * 统计当前验证记录总数（active、deferred 与 pending delete 互斥）。
 *
 * @returns 当前主线程持有的活动快照、延后记录与待确认墓碑总数
 */
function verificationRecordCount(): number {
  return activeVerificationSnapshots.size +
    deferredVerificationRecords.size +
    pendingVerificationDeletes.size;
}

/**
 * 在新验证键超出容量上限 VERIFICATION_RECORD_CAPACITY 时触发业务 Worker 致命错误并拒绝接纳。
 *
 * @param key `chatId:userId` 复合验证键
 * @returns 属于未知新键且已达容量上限时返回 true，否则返回 false
 */
function rejectNewVerificationAtCapacity(key: string): boolean {
  const known: boolean = activeVerificationSnapshots.has(key) ||
    deferredVerificationRecords.has(key) ||
    pendingVerificationDeferrals.has(key) ||
    pendingVerificationDeletes.has(key);
  if (known || verificationRecordCount() < VERIFICATION_RECORD_CAPACITY) {
    return false;
  }
  if (!verificationCapacityFatalState.current) {
    verificationCapacityFatalState.current = true;
    signalBusinessWorkerFatal(new Error(
      `Anti-Raid verification record capacity (${VERIFICATION_RECORD_CAPACITY}) exceeded; ` +
      "refusing new verification state and requiring a supervised restart."
    ));
  }
  return true;
}

/**
 * 接收 Worker 的待验证快照，拒绝旧代际/旧 revision 后更新主线程镜像。
 *
 * @param event Worker 上报的验证快照新增或更新事件
 * @returns 快照属于当前代际且修订号推进并已接纳时返回 true，否则返回 false
 */
export function acceptVerificationUpsert(
  event: VerificationUpsertEvent
): boolean {
  const snapshot: VerificationSnapshot = event.record;
  if (snapshot.generation !== antiRaidRuntimeState.generation) return false;
  const key: string = verificationKey(snapshot.chatId, snapshot.userId);
  if (rejectNewVerificationAtCapacity(key)) return false;
  if (
    deferredVerificationRecords.has(key) ||
    pendingVerificationDeferrals.has(key)
  ) return false;
  const latestRevision: number = Math.max(
    currentGenerationRevision(activeVerificationSnapshots.get(key)),
    currentGenerationRevision(pendingVerificationDeletes.get(key))
  );
  if (snapshot.revision <= latestRevision) return false;
  const critical: boolean = !activeVerificationSnapshots.has(key) ||
    isTerminalVerificationPhase(snapshot.phase);
  setActiveVerificationSnapshot(key, {
    ...snapshot,
    trackedMessageTimes: [...snapshot.trackedMessageTimes],
  });
  pendingVerificationDeletes.delete(key);
  postDiskIO({
    type: "verificationUpsert",
    record: snapshot,
    critical,
  });
  return true;
}

/**
 * 接收 Worker 的 tombstone，保持 active 与待确认删除镜像互斥。
 *
 * @param event Worker 上报的验证记录删除墓碑事件
 * @returns 墓碑属于当前代际且修订号推进并已接纳时返回 true，否则返回 false
 */
export function acceptVerificationDelete(
  event: VerificationDeleteEvent
): boolean {
  if (event.generation !== antiRaidRuntimeState.generation) return false;
  const key: string = verificationKey(event.chatId, event.userId);
  const current: VerificationSnapshot | undefined =
    activeVerificationSnapshots.get(key);
  const deferred: DeferredVerificationRecord | undefined =
    deferredVerificationRecords.get(key) ?? pendingVerificationDeferrals.get(key);
  const pendingRevision: number = currentGenerationRevision(pendingVerificationDeletes.get(key));
  if (
    (!current && deferred === undefined && pendingRevision === 0) ||
    event.revision <= Math.max(
      currentGenerationRevision(current),
      currentGenerationRevision(deferred),
      pendingRevision
    )
  ) return false;
  deleteActiveVerificationSnapshot(key);
  deferredVerificationRecords.delete(key);
  pendingVerificationDeferrals.delete(key);
  terminalVerificationAttempts.delete(key);
  persistedVerificationRevisions.delete(key);
  const deletion: { chatId: number; userId: number; generation: number; revision: number; } = {
    chatId: event.chatId,
    userId: event.userId,
    generation: event.generation,
    revision: event.revision,
  };
  pendingVerificationDeletes.set(key, deletion);
  postDiskIO({ type: "verificationDelete", ...deletion });
  return true;
}

/**
 * 启动 hydrate：用 Disk I/O 恢复出的活动快照整体替换活动镜像，每条的精确落盘水位线取
 * 快照自身的代际与 revision（能载入即已落盘），待确认墓碑清空。预算、延后索引与容量
 * fatal 标记由调用方先经 verificationAttempts.ts 的 resetVerificationAttemptRuntime 复位。
 *
 * @param records 从持久化存储恢复出的验证键到活动快照只读映射
 */
export function replaceActiveVerificationMirror(
  records: ReadonlyMap<string, VerificationSnapshot>
): void {
  clearActiveVerificationSnapshots();
  pendingVerificationDeletes.clear();
  persistedVerificationRevisions.clear();
  for (const [key, record] of records) {
    setActiveVerificationSnapshot(key, {
      ...record,
      trackedMessageTimes: [...record.trackedMessageTimes],
    });
    persistedVerificationRevisions.set(key, {
      generation: record.generation,
      revision: record.revision,
    });
  }
}

/**
 * 把活动镜像与精确落盘水位线一起提升到将要接管它们的 Worker 代际。
 *
 * @param generation 新启动的 Anti-Raid Worker 代际编号
 */
export function advanceActiveVerificationGeneration(generation: number): void {
  for (const [key, record] of activeVerificationSnapshots) {
    const persisted: { generation: number; revision: number } | undefined =
      persistedVerificationRevisions.get(key);
    setActiveVerificationSnapshot(key, { ...record, generation });
    if (
      persisted?.generation === record.generation &&
      persisted.revision === record.revision
    ) {
      persistedVerificationRevisions.set(key, {
        generation,
        revision: record.revision,
      });
    }
  }
}

/**
 * 活动快照的 Disk I/O 落盘回执：只有与当前活动快照同代际、同 revision 的回执才记为
 * 精确落盘水位线并返回 true；迟到或已被更新覆盖的回执返回 false，镜像不变。
 *
 * @param key `chatId:userId` 复合验证键
 * @param generation 已落盘快照的 Worker 代际编号
 * @param revision 已落盘快照的修订号
 * @returns 与当前活动镜像精确匹配并记录落盘水位线时返回 true，否则返回 false
 */
export function recordVerificationPersisted(
  key: string,
  generation: number,
  revision: number
): boolean {
  const current: VerificationSnapshot | undefined = activeVerificationSnapshots.get(key);
  if (current?.generation !== generation || current.revision !== revision) return false;
  persistedVerificationRevisions.set(key, { generation, revision });
  return true;
}

/**
 * 墓碑的 Disk I/O 落盘回执：精确匹配待确认墓碑的代际与 revision 时才移出。
 *
 * @param key `chatId:userId` 复合验证键
 * @param generation 已落盘墓碑的 Worker 代际编号
 * @param revision 已落盘墓碑的修订号
 */
export function settleVerificationDeletePersisted(
  key: string,
  generation: number,
  revision: number
): void {
  const deletion: { generation: number; revision: number } | undefined =
    pendingVerificationDeletes.get(key);
  if (deletion?.generation === generation && deletion.revision === revision) {
    pendingVerificationDeletes.delete(key);
  }
}
