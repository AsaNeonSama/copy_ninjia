import { diskIORuntime } from "../../cache/main/diskIO";
import { FLUSH_INTERVAL_MS } from "../../consts/diskIO/appendOnly";
import { DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES } from "../../consts/diskIO/diagnostics";
import type {
  DiskDiagnosticBatchRequest,
  DiskDiagnosticMessage,
} from "../../types/diskIO/messages";
import type { FlushResult } from "../../types/lifecycle";
import type { AcknowledgedBatch } from "../../libs/acknowledgedBatchQueue";
import { settleFlushWaiters, waitForFlush } from "../../libs/drainWaiter";
import { jsonSerializedBytes } from "../../libs/jsonBytes";
import { saturatingSafeIntegerAdd } from "../../libs/saturatingNumber";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import { safePostDiskIO } from "./transport";

/**
 * 记录因主线程诊断队列满而丢弃的诊断消息计数与字节数，并在本轮首次丢弃时输出告警。
 *
 * @param serializedBytes 被丢弃诊断消息的 JSON 序列化字节数。
 */
function recordDroppedDiskIODiagnostic(serializedBytes: number): void {
  if (diskIORuntime.diagnosticDroppedMessages === 0) {
    writeDiskIODiagnostic(
      "[diskIO] diagnostic queue capacity reached; dropping diagnostics until the durable FIFO drains."
    );
  }
  diskIORuntime.diagnosticDroppedMessages = saturatingSafeIntegerAdd(
    diskIORuntime.diagnosticDroppedMessages,
    1
  );
  diskIORuntime.diagnosticDroppedSerializedBytes = saturatingSafeIntegerAdd(
    diskIORuntime.diagnosticDroppedSerializedBytes,
    serializedBytes
  );
}

/** 有空间后把整段溢出收敛成一条普通 error 日志，保持 FIFO 与 durable ACK。 */
function enqueueDiskIODiagnosticDropSummary(): void {
  const droppedMessages: number = diskIORuntime.diagnosticDroppedMessages;
  if (droppedMessages === 0) return;
  const droppedBytes: number = diskIORuntime.diagnosticDroppedSerializedBytes;
  const summary: DiskDiagnosticMessage = {
    type: "log",
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    level: "error",
    args: [
      "[diskIO] Dropped diagnostic messages after the in-process queue reached its hard limits.",
      {
        droppedMessages,
        droppedSerializedBytes: droppedBytes,
      },
    ],
  };
  if (!diskIORuntime.diagnosticQueue.enqueue(
    summary,
    jsonSerializedBytes(summary)
  )) return;
  diskIORuntime.diagnosticDroppedMessages = 0;
  diskIORuntime.diagnosticDroppedSerializedBytes = 0;
  markAllQueuedDiagnosticsFlushable();
}

/** 清理普通日志缓冲刷盘 timer；提前达到批上限、出现需立即落盘的消息或停机时复用。 */
export function clearDiskDiagnosticFlushTimer(): void {
  if (diskIORuntime.diagnosticFlushTimer === null) return;
  clearTimeout(diskIORuntime.diagnosticFlushTimer);
  diskIORuntime.diagnosticFlushTimer = null;
}

/** 清理诊断重投 timer；代际切换和 terminate 都复用。 */
function clearDiskDiagnosticRetryTimer(): void {
  if (diskIORuntime.diagnosticRetryTimer === null) return;
  clearTimeout(diskIORuntime.diagnosticRetryTimer);
  diskIORuntime.diagnosticRetryTimer = null;
}

/**
 * 判断一条诊断消息是否必须绕过普通日志的定时/满批缓冲并立即刷盘。
 * @param message 待入队的诊断消息。
 * @returns 非日志诊断与 `error` 级别日志返回 `true`，其余级别日志返回 `false`。
 */
function isImmediateDiagnostic(message: DiskDiagnosticMessage): boolean {
  return message.type !== "log" || message.level === "error";
}

/** 把当前队列中的全部诊断消息纳入待发送窗口，并撤销已不再需要的定时刷盘。 */
function markAllQueuedDiagnosticsFlushable(): void {
  clearDiskDiagnosticFlushTimer();
  diskIORuntime.diagnosticFlushPendingCount = diskIORuntime.diagnosticQueue.size;
}

/** 为尚未进入待发送窗口的普通日志安排单次延迟刷盘，不重置既有截止时间。 */
function armDiskDiagnosticFlushTimer(): void {
  if (diskIORuntime.diagnosticFlushTimer !== null) return;
  diskIORuntime.diagnosticFlushTimer = setTimeout((): void => {
    diskIORuntime.diagnosticFlushTimer = null;
    markAllQueuedDiagnosticsFlushable();
    advanceDiskIODiagnostics();
  }, FLUSH_INTERVAL_MS);
  diskIORuntime.diagnosticFlushTimer.unref();
}

/** 依据待发送窗口与 `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` 门槛维护缓冲定时器并按需向当前 Worker 投递下一批。 */
function advanceDiskIODiagnostics(): void {
  if (
    diskIORuntime.diagnosticFlushPendingCount === 0 &&
    diskIORuntime.diagnosticQueue.size >= DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES
  ) {
    diskIORuntime.diagnosticFlushPendingCount = DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES;
  }
  if (diskIORuntime.diagnosticQueue.size <= diskIORuntime.diagnosticFlushPendingCount) {
    clearDiskDiagnosticFlushTimer();
  } else {
    armDiskDiagnosticFlushTimer();
  }
  if (diskIORuntime.diagnosticFlushPendingCount === 0) return;
  const worker: Worker | null = diskIORuntime.worker;
  if (worker !== null && diskIORuntime.writable) {
    pumpDiskIODiagnostics(worker);
  }
}

/**
 * 结算等待诊断 FIFO 清空的全局 flush；领域级 flush 不登记到这里。
 *
 * @param result 诊断队列排空的最终 flush 结果。
 */
export function settleDiskDiagnosticDrainWaiters(result: FlushResult): void {
  settleFlushWaiters(diskIORuntime.diagnosticDrainWaiters, result);
}

/**
 * 在不阻止进程退出的 timer 后重投当前原批；只允许一个重试 timer。
 *
 * @param worker 当前活跃的 Disk I/O Worker 实例。
 * @param retryAfterMs 触发重投前的退避等待毫秒数。
 */
function scheduleDiskDiagnosticRetry(worker: Worker, retryAfterMs: number): void {
  clearDiskDiagnosticRetryTimer();
  diskIORuntime.diagnosticRetryTimer = setTimeout((): void => {
    diskIORuntime.diagnosticRetryTimer = null;
    if (diskIORuntime.worker === worker) {
      advanceDiskIODiagnostics();
    }
  }, retryAfterMs);
  diskIORuntime.diagnosticRetryTimer.unref();
}

/**
 * 把下一批诊断交给指定代际；同一时刻最多存在一个尚未确认的批次。
 *
 * @param worker 目标 Disk I/O Worker 实例。
 */
function pumpDiskIODiagnostics(worker: Worker): void {
  if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return;
  // 已设置重试 timer 时，新日志只入本地 FIFO，不绕过 timer 重新投递。
  if (diskIORuntime.diagnosticRetryTimer !== null) return;
  const batch: AcknowledgedBatch<DiskDiagnosticMessage> | null =
    diskIORuntime.diagnosticQueue.nextDelivery();
  if (batch === null) return;
  const request: DiskDiagnosticBatchRequest = {
    type: "diagnosticBatch",
    batchId: batch.batchId,
    messages: batch.values,
  };
  if (safePostDiskIO(worker, request, "diagnostic batch")) {
    diskIORuntime.diagnosticQueue.markDelivered(batch.batchId);
    return;
  }
  diskIORuntime.diagnosticQueue.markDeliveryRejected();
}

/**
 * 把诊断收入主线程有界 FIFO。普通级别日志（`info`/`operation`/`warn`）在主线程缓冲，
 * 攒满 `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` 条或到达 `FLUSH_INTERVAL_MS` 时随批落盘；
 * `error` 日志、汇总日志、非日志诊断及存在待排空等待者时立即刷盘。DiskIO 尚未可写时仍保留；
 * 单批 ACK 窗口使 Worker mailbox 中同一时刻只有一个批次。越界消息释放引用并合并为后续一条汇总日志。
 *
 * @param message 待入队的诊断日志消息。
 * @returns 恒返回 `true`，表示消息已被此边界接管（入队或计入有界丢弃统计）。
 */
export function enqueueDiskIODiagnostic(message: DiskDiagnosticMessage): boolean {
  enqueueDiskIODiagnosticDropSummary();
  const serializedBytes: number = jsonSerializedBytes(message);
  if (!diskIORuntime.diagnosticQueue.enqueue(message, serializedBytes)) {
    recordDroppedDiskIODiagnostic(serializedBytes);
  }
  if (isImmediateDiagnostic(message) || diskIORuntime.diagnosticDrainWaiters.size > 0) {
    markAllQueuedDiagnosticsFlushable();
  }
  advanceDiskIODiagnostics();
  // true 表示消息已被此边界接管：或在 FIFO 中，或已计入有界丢弃统计。
  // Worker 日志转发据此确认原批。
  return true;
}

/**
 * 当前 DiskIO 代际确认一批诊断后推进发送窗口；迟到 ACK 不影响新代际。
 *
 * @param worker 发出确认回执的 Disk I/O Worker 实例。
 * @param batchId 被确认落盘的诊断批次编号。
 * @returns 当前代际有效且批次确认成功时返回 `true`，否则返回 `false`。
 */
export function acceptDiskIODiagnosticBatch(worker: Worker, batchId: number): boolean {
  if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return false;
  const sizeBefore: number = diskIORuntime.diagnosticQueue.size;
  if (!diskIORuntime.diagnosticQueue.acknowledge(batchId)) return false;
  const acknowledgedCount: number = sizeBefore - diskIORuntime.diagnosticQueue.size;
  diskIORuntime.diagnosticFlushPendingCount = Math.max(
    0,
    diskIORuntime.diagnosticFlushPendingCount - acknowledgedCount
  );
  enqueueDiskIODiagnosticDropSummary();
  advanceDiskIODiagnostics();
  if (diskIORuntime.diagnosticQueue.size === 0) {
    settleDiskDiagnosticDrainWaiters("flushed");
  }
  return true;
}

/**
 * 等待当前全部诊断（含尚在缓冲中的普通级别日志）获得 durable ACK。供进程级 flush 与 `"log"` 领域 flush 使用；
 * 调用方在真正发出 flush 请求前会再次检查新入队的诊断。
 *
 * @param timeoutMs 最大等待超时毫秒数。
 * @returns 诊断队列排空结果（`"flushed"`、`"timedOut"` 或 `"failed"`）。
 */
export function waitForDiskIODiagnostics(timeoutMs: number): Promise<FlushResult> {
  enqueueDiskIODiagnosticDropSummary();
  markAllQueuedDiagnosticsFlushable();
  advanceDiskIODiagnostics();
  if (diskIORuntime.diagnosticQueue.size === 0) return Promise.resolve("flushed");
  if (diskIORuntime.worker === null) return Promise.resolve("failed");
  return waitForFlush({ waiters: diskIORuntime.diagnosticDrainWaiters, timeoutMs });
}

/** `retryDiskIODiagnosticBatch` 的参数选项。 */
export interface RetryDiskIODiagnosticBatchOptions {
  /** 上报写盘失败的 Disk I/O Worker 实例。 */
  worker: Worker;
  /** 需重新开放重投的诊断批次编号。 */
  batchId: number;
  /** 退避重投延迟毫秒数。 */
  retryAfterMs: number;
  /** 为 `true` 时安排退避重试定时器；为 `false` 时仅重新开放批次而不排定时器。 */
  schedule: boolean;
}

/**
 * Worker 明确表示日志刷盘失败时重新开放原批；schedule 为 true 时按退避窗口重发，
 * 为 false 时只开放原批、不安排重试 timer。
 *
 * @param options 诊断批次重投选项。
 * @returns 当前代际匹配且原批次已成功重新开放为待重发时返回 `true`，否则返回 `false`。
 */
export function retryDiskIODiagnosticBatch({
  worker,
  batchId,
  retryAfterMs,
  schedule,
}: RetryDiskIODiagnosticBatchOptions): boolean {
  if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return false;
  if (!diskIORuntime.diagnosticQueue.requestRedelivery(batchId)) return false;
  if (schedule) scheduleDiskDiagnosticRetry(worker, retryAfterMs);
  return true;
}

/**
 * 新 DiskIO 代际完成恢复后重发未确认批次并继续排空 FIFO。
 *
 * @param worker 已完成恢复并进入可写状态的 Disk I/O Worker 实例。
 */
export function resumeDiskIODiagnosticChannel(worker: Worker): void {
  if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return;
  advanceDiskIODiagnostics();
}

/** DiskIO 代际失效时把未确认批次标为待重发，保留尚未到期或未达批上限的缓冲状态与定时器。 */
export function pauseDiskIODiagnosticChannel(): void {
  clearDiskDiagnosticRetryTimer();
  diskIORuntime.diagnosticQueue.markDeliveryRejected();
}

/** 整个宿主 terminate 后不再存在可恢复代际，此时释放全部进程内诊断引用。 */
export function resetDiskIODiagnosticChannel(): void {
  clearDiskDiagnosticRetryTimer();
  clearDiskDiagnosticFlushTimer();
  settleDiskDiagnosticDrainWaiters("failed");
  diskIORuntime.diagnosticQueue.reset();
  diskIORuntime.diagnosticFlushPendingCount = 0;
  diskIORuntime.diagnosticDroppedMessages = 0;
  diskIORuntime.diagnosticDroppedSerializedBytes = 0;
}
