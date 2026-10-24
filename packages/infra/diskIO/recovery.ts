/** Disk I/O Worker 的恢复握手、镜像重放、重启节流与诊断受控重建。 */

import {
  diskIOFlushBarrier,
  diskIORestartThrottle,
  diskIORuntime,
} from "../../cache/main/diskIO";
import {
  DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD,
} from "../../consts/diskIO/diagnostics";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from
  "../../consts/workerSupervisor";
import type {
  DiskBusinessMessage,
  DiskIORecoveryTransport,
  LoadRequest,
  RecoveryReplayRequest,
  StorageFlushHoldRequest,
} from "../../types/diskIO/messages";
import type { LoadedReply } from "../../types/diskIO/replies";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { FlushResult } from "../../types/lifecycle";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import { stickerPacksForRecovery } from "../../config/stickers";
import { getTimeZone } from "../../config/time";
import {
  pauseDiskIODiagnosticChannel,
  resumeDiskIODiagnosticChannel,
  settleDiskDiagnosticDrainWaiters,
} from "./diagnosticChannel";
import {
  rejectAllPendingDiskIORequests,
  requestLuckSecretFromWorker,
} from "./requests";
import { beginDiskIOFlush, pauseDiskIOOperations, postBufferedDiskIOBusiness, safePostDiskIO } from "./transport";
import { signalDiskIOFatal } from "./fatal";
import { DiskIORecoveryRevisions } from "../../libs/diskIORecoveryRevisions";
import { diskIOMessageCost } from "../../libs/diskIOMessageCost";
import { errorMessage } from "../../libs/errorMessage";

/** 清除运行时恢复握手的超时 timer；重复调用安全。 */
export function clearRuntimeRecoveryTimer(): void {
  if (diskIORuntime.runtimeRecoveryTimer === null) return;
  clearTimeout(diskIORuntime.runtimeRecoveryTimer);
  diskIORuntime.runtimeRecoveryTimer = null;
}

/**
 * 放弃自愈的统一通知：此后没有替补实例会重放或回执，仍在等待 durable 回执的 owner
 * 立即按失败结算，等待诊断排空的进程级 flush 同样以 failed 结算。
 */
function notifyDiskIOGiveUp(): void {
  for (const listener of diskIORuntime.giveUpListeners) listener();
  settleDiskDiagnosticDrainWaiters("failed");
}

/**
 * 终止已失效的实例；同步抛错只记诊断，不改变调用方已经收口的结论。
 *
 * @param worker 待终止的已失效 Disk I/O Worker 实例。
 * @param failure 终止调用抛出异常时写入诊断 sink 的前缀描述。
 */
function terminateUnusableWorker(worker: Worker, failure: string): void {
  try {
    worker.terminate();
  } catch (error: unknown) {
    writeDiskIODiagnostic(failure, error);
  }
}

/**
 * 恢复失败的统一收口：让存储保持不可写、结算所有等待方并终止该实例。
 *
 * @param worker 恢复失败的 Disk I/O Worker 实例。
 * @param reason 恢复失败的原因说明。
 * @param fatal 是否升级为需要进程重启的致命失败（运行时恢复路径为 true）；
 *   为 true 时先经 notifyDiskIOGiveUp 结算放弃自愈的等待方，再发出致命信号。
 */
export function stopWorkerAfterLoadFailure(worker: Worker, reason: string, fatal: boolean): void {
  if (diskIORuntime.worker !== worker) return;
  clearRuntimeRecoveryTimer();
  pauseDiskIOOperations();
  writeDiskIODiagnostic(
    `[diskIO] persistence recovery failed; keeping storage unavailable and refusing writes: ${reason}`
  );
  diskIORuntime.worker = null;
  diskIORuntime.runtimeRecoveryWorker = null;
  diskIORuntime.writable = false;
  pauseDiskIODiagnosticChannel();
  diskIOFlushBarrier.settleAll("failed");
  rejectAllPendingDiskIORequests((): string =>
    `Persistence Worker became unavailable during recovery: ${reason}`);
  terminateUnusableWorker(worker, "[diskIO] failed to terminate unusable persistence Worker:");
  if (!fatal) return;
  notifyDiskIOGiveUp();
  signalDiskIOFatal(new Error(`[diskIO] runtime persistence recovery failed: ${reason}`));
}

/**
 * 判断 `loaded` 回执是否表示存储加载成功且已返回运势回执密钥。
 *
 * @param reply Disk I/O Worker 返回的 `loaded` 回执载荷。
 * @returns 无错误且包含非空运势密钥时返回 `true`，否则返回 `false`。
 */
export function isSuccessfulLoad(reply: LoadedReply): boolean {
  return reply.error === undefined && reply.luckReceiptSecret !== null;
}

/**
 * 判断给定 Worker 是否仍为当前处于运行时恢复握手阶段且尚未进入可写状态的实例。
 *
 * @param worker 待检查的 Disk I/O Worker 实例。
 * @returns 仍为当前恢复代际且尚未可写时返回 `true`，否则返回 `false`。
 */
function isCurrentRecoveryWorker(worker: Worker): boolean {
  return diskIORuntime.worker === worker &&
    diskIORuntime.runtimeRecoveryWorker === worker &&
    !diskIORuntime.writable;
}

interface RecoveryTransportScope {
  transport: DiskIORecoveryTransport;
  deactivate(): void;
  failed(): boolean;
}

/**
 * 为单个领域的镜像重放创建受代际与生命周期约束的恢复传输作用域。
 *
 * @param worker 当前正在执行运行时恢复的 Disk I/O Worker 实例。
 * @param revisions 记录重放已覆盖 revision 的去重跟踪器。
 * @returns 含受限恢复 transport、失效开关与失败状态查询的作用域对象。
 */
function createRecoveryTransportScope(worker: Worker, revisions: DiskIORecoveryRevisions): RecoveryTransportScope {
  let active: boolean = true;
  let transportFailed: boolean = false;
  const isUsable = (): boolean => active && isCurrentRecoveryWorker(worker);
  const transport: DiskIORecoveryTransport = {
    post: (message: DiskBusinessMessage): boolean => {
      if (!isUsable()) {
        transportFailed = true;
        return false;
      }
      const posted: boolean = safePostDiskIO(
        worker,
        message,
        `recovery replay ${message.type}`
      );
      if (posted) revisions.record(message, diskIORuntime.pendingBusinessMessages);
      if (!posted) transportFailed = true;
      return posted;
    },
    ensureLuckReceiptSecret: async (day: string): Promise<LuckReceiptSecret> => {
      if (!isUsable()) {
        transportFailed = true;
        throw new Error("Disk I/O recovery transport is no longer active.");
      }
      try {
        const secret: LuckReceiptSecret = await requestLuckSecretFromWorker({
          worker,
          day,
          timeoutMs: diskIORuntime.runtimeRecoveryTimeoutMs,
          context: "recovery luck receipt secret request",
        });
        if (!isUsable()) {
          transportFailed = true;
          throw new Error("Disk I/O recovery generation changed while loading the luck secret.");
        }
        return secret;
      } catch (error: unknown) {
        transportFailed = true;
        throw error;
      }
    },
  };
  return {
    transport,
    deactivate: (): void => { active = false; },
    failed: (): boolean => transportFailed,
  };
}

/**
 * 开合一对恢复区间标记，投递失败按 fatal 处理：
 * - recoveryReplay：重放区间，区间内写失败升级为停机，关标记后在线写恢复常规失败语义。
 * - storageFlushHold：镜像重放区间，区间内 Worker 暂缓共享 SQLite 的满批与定时提交，关标记后
 *   复核聚合约束并按批次阈值一次提交，复核失败回报 recoveryReplayFailed（见
 *   types/diskIO/messages.ts 的 StorageFlushHoldRequest）。
 *
 * @param worker 当前正在执行恢复的 Disk I/O Worker 实例。
 * @param request 待投递的恢复区间开合控制请求。
 * @param noun 日志里的标记名（如 `recovery replay mark`）。
 * @returns 标记成功投递时返回 `true`；被拒收并已触发恢复失败收口时返回 `false`。
 */
function postRecoveryMarker(
  worker: Worker,
  request: RecoveryReplayRequest | StorageFlushHoldRequest,
  noun: string
): boolean {
  if (safePostDiskIO(worker, request, `${noun} (${request.active ? "open" : "close"})`)) return true;
  stopWorkerAfterLoadFailure(
    worker,
    `Worker rejected the ${request.active ? "opening" : "closing"} ${noun}`,
    true
  );
  return false;
}

/**
 * 在 `loaded` 握手成功后激活 Disk I/O Worker：可选按序重放各领域主线程镜像、排空挂起的业务缓冲，最终开放可写状态与诊断通道。
 *
 * @param worker 已完成 `loaded` 握手的 Disk I/O Worker 实例。
 * @param replayMirrors 运行时重建恢复时为 `true`（先重放主线程镜像），冷启动首次加载时为 `false`。
 */
export async function activateDiskIOWorker(worker: Worker, replayMirrors: boolean): Promise<void> {
  if (diskIORuntime.worker !== worker) return;
  // 镜像重放走运行期恢复的 owner 判定，首次加载只认当前 Worker。
  const stillOwner = (): boolean =>
    replayMirrors ? isCurrentRecoveryWorker(worker) : diskIORuntime.worker === worker;
  const revisions: DiskIORecoveryRevisions = new DiskIORecoveryRevisions();
  if (replayMirrors) {
    // 按显式优先级等待各领域镜像；整个握手保持不可写，恢复 timer 继续覆盖
    // 异步 listener，普通业务增量留在有上限的 FIFO 缓冲里。各领域镜像全部投递
    // 完成前共享 SQLite 不做满批提交。
    if (!postRecoveryMarker(worker, { type: "storageFlushHold", active: true }, "storage flush hold")) return;
    for (const registration of diskIORuntime.respawnListeners) {
      const scope: RecoveryTransportScope = createRecoveryTransportScope(worker, revisions);
      let replayed: boolean;
      try {
        replayed = await registration.listener(scope.transport);
      } catch (error: unknown) {
        scope.deactivate();
        if (!isCurrentRecoveryWorker(worker)) return;
        stopWorkerAfterLoadFailure(
          worker,
          `${registration.owner} mirror replay failed: ${errorMessage(error)}`,
          true
        );
        return;
      }
      scope.deactivate();
      if (!isCurrentRecoveryWorker(worker)) return;
      if (!replayed || scope.failed()) {
        stopWorkerAfterLoadFailure(
          worker,
          `${registration.owner} mirror replay reported failure`,
          true
        );
        return;
      }
    }
    if (!postRecoveryMarker(worker, { type: "storageFlushHold", active: false }, "storage flush hold")) return;
  }
  // 重放区间用 recoveryReplay 标记框住：区间内的写失败按 fatal 停机处理
  // （见 types/diskIO/messages.ts 的 RecoveryReplayRequest）。整段排空是同步的，
  // 两个标记之间只有重放的那一批。
  if (diskIORuntime.pendingBusinessMessages.size > 0) {
    if (!postRecoveryMarker(worker, { type: "recoveryReplay", active: true }, "recovery replay mark")) return;
    while (diskIORuntime.pendingBusinessMessages.size > 0) {
      if (!stillOwner()) return;
      const message: DiskBusinessMessage = diskIORuntime.pendingBusinessMessages.peek()!;
      if (revisions.covers(message)) {
        diskIORuntime.pendingBusinessMessages.shift();
        diskIORuntime.pendingBusinessBytes -= diskIOMessageCost(message);
        continue;
      }
      if (!postBufferedDiskIOBusiness(worker)) {
        stopWorkerAfterLoadFailure(worker, `Worker rejected ${message.type} during recovery replay`, true);
        return;
      }
    }
    if (!postRecoveryMarker(worker, { type: "recoveryReplay", active: false }, "recovery replay mark")) return;
  }
  if (!stillOwner()) return;
  clearRuntimeRecoveryTimer();
  diskIORuntime.runtimeRecoveryWorker = null;
  diskIORuntime.writable = true;
  resumeDiskIODiagnosticChannel(worker);
}

/**
 * 为新建的替补 Disk I/O Worker 启动运行时恢复超时定时器并发起 `load` 握手请求。
 *
 * @param worker 新创建的替补 Disk I/O Worker 实例。
 */
function beginRuntimeRecovery(worker: Worker): void {
  clearRuntimeRecoveryTimer();
  diskIORuntime.runtimeRecoveryWorker = worker;
  diskIORuntime.runtimeRecoveryTimer = setTimeout((): void => {
    diskIORuntime.runtimeRecoveryTimer = null;
    stopWorkerAfterLoadFailure(
      worker,
      `runtime load handshake timed out after ${diskIORuntime.runtimeRecoveryTimeoutMs}ms`,
      true
    );
  }, diskIORuntime.runtimeRecoveryTimeoutMs);
  diskIORuntime.runtimeRecoveryTimer.unref();
  const request: LoadRequest = {
    type: "load",
    timeZone: getTimeZone(),
    stickerPacks: stickerPacksForRecovery(),
  };
  if (!safePostDiskIO(worker, request, "runtime load request")) {
    stopWorkerAfterLoadFailure(worker, "Worker synchronously rejected the runtime load request", true);
  }
}

/** `recoverDiskIOWorker` 的参数选项。 */
interface RecoverDiskIOWorkerOptions {
  /** 创建替补 Disk I/O Worker 实例的工厂函数。 */
  readonly createWorker: () => Worker;
  /** 已失效的当前 Disk I/O Worker 实例。 */
  worker: Worker;
  /** 触发恢复的故障或回收原因描述。 */
  reason: string;
  /** 为 `true` 时显式调用 `worker.terminate()` 终止旧实例。 */
  terminateWorker: boolean;
  /** 触发本次恢复的根因分类（未捕获崩溃或诊断写盘连续失败）。 */
  cause: "crash" | "diagnostic";
}

/**
 * 当前 DiskIO 代际失效后的唯一恢复入口。未捕获异常与诊断连续写盘失败共用同一套
 * 等待者结算、重启节流、load 握手和镜像重放。
 *
 * @param options 失效代际恢复与重建选项。
 */
export function recoverDiskIOWorker({
  createWorker,
  worker,
  reason,
  terminateWorker,
  cause,
}: RecoverDiskIOWorkerOptions): void {
  if (diskIORuntime.worker !== worker) return;
  pauseDiskIOOperations();
  if (terminateWorker) {
    writeDiskIODiagnostic(`[diskIO] recycling persistence Worker after ${reason}.`);
  } else {
    writeDiskIODiagnostic("[diskIO] persistence Worker errored:", reason);
  }
  diskIORuntime.worker = null;
  diskIORuntime.writable = false;
  if (diskIORuntime.diagnosticRecycleWorker === worker) {
    diskIORuntime.diagnosticRecycleWorker = null;
  }
  pauseDiskIODiagnosticChannel();
  if (diskIORuntime.runtimeRecoveryWorker === worker) {
    diskIORuntime.runtimeRecoveryWorker = null;
    clearRuntimeRecoveryTimer();
  }
  const pendingFlushCount: number = diskIOFlushBarrier.pendingCount();
  if (pendingFlushCount > 0) {
    writeDiskIODiagnostic(
      `[diskIO] ${pendingFlushCount} pending flush(es) lost — persistence Worker became unavailable mid-flush, ` +
      "their buffered data was not written to disk."
    );
    diskIOFlushBarrier.settleAll("failed");
  }
  rejectAllPendingDiskIORequests((label: string): string =>
    `Persistence Worker became unavailable while awaiting the ${label} reply.`);
  if (terminateWorker) {
    terminateUnusableWorker(worker, "[diskIO] failed to terminate recycled persistence Worker:");
  }
  const diagnosticRebuilds: number = cause === "diagnostic"
    ? diskIORuntime.consecutiveDiagnosticRebuilds + 1
    : diskIORuntime.consecutiveDiagnosticRebuilds;
  const diagnosticGiveUp: boolean = cause === "diagnostic" &&
    diagnosticRebuilds >= DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD;
  const crashGiveUp: boolean = cause === "crash" &&
    diskIORestartThrottle.shouldGiveUp();
  if (diagnosticGiveUp || crashGiveUp) {
    writeDiskIODiagnostic(
      diagnosticGiveUp
        ? `[diskIO] diagnostic log persistence required ${diagnosticRebuilds} consecutive Worker rebuilds, ` +
          "giving up self-healing and forcing a supervised process restart before any more updates are accepted."
        : `[diskIO] persistence Worker restarted ${WORKER_MAX_RESTARTS} times within ` +
          `${WORKER_RESTART_WINDOW_MS / 1000}s, giving up self-healing and forcing a supervised process restart ` +
          "before any more updates are accepted."
    );
    notifyDiskIOGiveUp();
    signalDiskIOFatal(new Error("Persistence Worker exhausted its runtime restart budget."));
    return;
  }
  if (cause === "diagnostic") {
    diskIORuntime.consecutiveDiagnosticRebuilds = diagnosticRebuilds;
  }
  diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
  const next: Worker = createWorker();
  diskIORuntime.worker = next;
  beginRuntimeRecovery(next);
}

/**
 * 诊断故障触发受控重建前只刷业务领域（scope 为 business），不等待诊断批次；
 * 失败的日志批次仍由主线程 ACK 队列持有。
 *
 * @param worker 待回收的当前 Disk I/O Worker 实例。
 * @returns 业务领域的 flush 结果。
 */
async function flushBusinessBeforeDiagnosticRecycle(
  worker: Worker
): Promise<FlushResult> {
  return (await beginDiskIOFlush(worker, "business", DISK_IO_FLUSH_TIMEOUT_MS)).result;
}

/**
 * 日志连续失败达到阈值后先封住业务入口并确保非日志事实 durable，再替换 Worker。
 *
 * @param worker 发生诊断连续写盘失败的 Disk I/O Worker 实例。
 * @param failureCount 已累计的连续诊断写盘失败次数。
 * @param createWorker 创建替补 Disk I/O Worker 实例的工厂函数。
 */
export function beginDiagnosticWorkerRecycle(
  worker: Worker,
  failureCount: number,
  createWorker: () => Worker
): void {
  if (
    diskIORuntime.worker !== worker ||
    !diskIORuntime.writable ||
    diskIORuntime.diagnosticRecycleWorker !== null
  ) return;
  diskIORuntime.writable = false;
  diskIORuntime.diagnosticRecycleWorker = worker;
  pauseDiskIODiagnosticChannel();
  // flush 屏障只以 FlushResult 结算、从不 reject。
  void flushBusinessBeforeDiagnosticRecycle(worker).then((result: FlushResult): void => {
    if (
      diskIORuntime.worker !== worker ||
      diskIORuntime.diagnosticRecycleWorker !== worker
    ) return;
    diskIORuntime.diagnosticRecycleWorker = null;
    if (result !== "flushed") {
      writeDiskIODiagnostic(
        `[diskIO] refusing diagnostic-triggered Worker recycle because the business flush ${result}; ` +
        "forcing a supervised process restart without guessing whether non-log facts are durable."
      );
      stopWorkerAfterLoadFailure(
        worker,
        `business flush ${result} before diagnostic-triggered recycle`,
        true
      );
      return;
    }
    recoverDiskIOWorker({
      createWorker,
      worker,
      reason:
        `diagnostic log persistence failed ${failureCount} consecutive times`,
      terminateWorker: true,
      cause: "diagnostic",
    });
  });
}
