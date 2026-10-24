/**
 * 进程唯一的共享数据 Disk I/O Worker 主线程宿主：统一承载日志、AI/贴纸快照、每日运势、
 * 待验证当日增量 JSON、群状态与持久化身份策略的跨线程读写、恢复握手与落盘屏障。
 * 本模块自身的错误一律经 `writeDiskIODiagnostic` 输出，不经 `logger` 转发。
 * @see ../../docs/cn/04-invariants.md
 */

import {
  diskIOFlushBarrier,
  diskIORuntime,
  pendingLoad,
} from "../cache/main/diskIO";
import { logRelaySink } from "../cache/perThread/logger";
import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import { createDiskIOWorker } from "./diskIO/host";
import { clearRuntimeRecoveryTimer, stopWorkerAfterLoadFailure } from "./diskIO/recovery";
import {
  closeDiskIOStorage,
  rejectAllPendingDiskIORequests,
  requirePositiveFinite,
} from "./diskIO/requests";
import {
  enqueueDiskIODiagnostic,
  resetDiskIODiagnosticChannel,
  waitForDiskIODiagnostics,
} from "./diskIO/diagnosticChannel";
import {
  beginDiskIOFlush,
  fitsDiskIOBusiness,
  queueDiskIOOperationMessage,
  resetDiskIOOperations,
  safePostDiskIO,
} from "./diskIO/transport";
import { AcknowledgedBatchQueue } from "../libs/acknowledgedBatchQueue";
import { diskIOMessageCost } from "../libs/diskIOMessageCost";
import { DISK_OPERATION_CONTROL_RESERVE, DISK_BUSINESS_BATCH_MAX_MESSAGES, DISK_OPERATION_MAX_RETAINED_BYTES } from "../consts/diskIO/business";
import { stickerPacksForRecovery } from "../config/stickers";
import { getTimeZone } from "../config/time";
export {
  onDiskIOGiveUp,
  onDiskIOReply,
  onDiskIORespawn,
} from "./diskIO/observers";
export {
  ensureLuckReceiptSecret,
  readBlocklistIdPage,
  readIdentityPolicies,
  readJoinLog,
} from "./diskIO/requests";
export type { ReadJoinLogParams } from "./diskIO/requests";
import type { FlushResult } from "../types/lifecycle";
import type {
  DiskBusinessMessage,
  DiskFlushScope,
  LoadRequest,
  QueuedDiskIOOperationMessage,
  AdSampleDiskMessage,
  AiCacheUsageDiskMessage,
  LogMessage,
} from "../types/diskIO/messages";
import type {
  DiskIODomain,
  DomainFlushOutcome,
  LoadedData,
  LoadedReply,
} from "../types/diskIO/replies";
import { toErrorOr } from "../libs/errorMessage";

const isMainThread: boolean = Bun.isMainThread;
export interface DiskIOInitOptions {
  /** 运行时恢复无法继续时通知应用停止；启动握手失败仍由 loadPersistedData reject。 */
  onFatal?: (error: Error) => void;
  /** 仅供测试缩短；生产默认与启动 load 握手使用同一预算。 */
  runtimeRecoveryTimeoutMs?: number;
  /** 排队、在途与恢复窗口合计的业务消息上限。 */
  maxPendingBusinessMessages?: number;
}

/**
 * 在主线程显式启动唯一的落盘 Worker，并把 relayLogMessage 装成 logger 的落盘出口。调用方必须
 * 已经取得数据目录的 bot.lock；重复调用幂等，不重置崩溃自愈的放弃阈值。
 * 模块导入本身不创建线程；Worker 线程不初始化本宿主，只使用 logger.ts 的转发模式。
 * @param options Disk I/O 宿主的初始化选项。
 */
export function initDiskIO({
  onFatal,
  runtimeRecoveryTimeoutMs = LOAD_TIMEOUT_MS,
  maxPendingBusinessMessages = DEFAULT_MAX_PENDING_BUSINESS_MESSAGES,
}: DiskIOInitOptions = {}): void {
  if (!isMainThread) {
    throw new Error("Disk I/O can only be initialized by the main thread.");
  }
  if (diskIORuntime.initialized) return;
  const nextRuntimeRecoveryTimeoutMs: number = requirePositiveFinite(
    runtimeRecoveryTimeoutMs,
    "Disk I/O runtime recovery timeout"
  );
  if (!Number.isSafeInteger(maxPendingBusinessMessages) || maxPendingBusinessMessages < 1) {
    throw new RangeError("Disk I/O pending business message capacity must be a positive safe integer.");
  }
  diskIORuntime.fatalHandler = onFatal;
  diskIORuntime.runtimeRecoveryTimeoutMs = nextRuntimeRecoveryTimeoutMs;
  diskIORuntime.maxPendingBusinessMessages = maxPendingBusinessMessages;
  diskIORuntime.operationQueue = new AcknowledgedBatchQueue<QueuedDiskIOOperationMessage>({
    maxBatchMessages: DISK_BUSINESS_BATCH_MAX_MESSAGES,
    maxMessages: maxPendingBusinessMessages + DISK_OPERATION_CONTROL_RESERVE,
    maxCost: DISK_OPERATION_MAX_RETAINED_BYTES,
  });
  diskIORuntime.fatalSignaled = false;
  diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
  diskIORuntime.consecutiveDiagnosticRebuilds = 0;
  diskIORuntime.diagnosticRecycleWorker = null;
  diskIORuntime.writable = false;
  diskIORuntime.worker = createDiskIOWorker();
  diskIORuntime.initialized = true;
  logRelaySink.current = relayLogMessage;
}

/**
 * 供入口生命周期守卫和无副作用 import 测试查询，不代表 Worker 当前可用。
 * @returns 已完成宿主初始化时返回 true，未初始化或已终止时返回 false。
 */
export function isDiskIOInitialized(): boolean {
  return diskIORuntime.initialized;
}

/**
 * 把 error 日志交给主线程有界 FIFO：主线程自身的日志由 logger.ts 直接调用，其它 Worker
 * 线程转发来的日志由 infra/supervisedWorker.ts 调用（logger.ts 的转发模式）。
 * DiskIO Worker 不可写、崩溃或同步拒收时延后重投；容量越界时释放原消息引用并
 * 记入后续汇总，本函数仍返回已接管，来源 Worker 随即释放原批。
 * @param message 已序列化的错误日志消息。
 * @returns 已由诊断通道接管时返回 true，Disk I/O 尚未初始化时返回 false。
 */
export function relayLogMessage(message: LogMessage): boolean {
  // DiskIO owner 未初始化时返回 false，不建立积压。业务 Worker 在 DiskIO
  // 初始化完成后才启动，运行期转发不经过这个分支。
  if (!diskIORuntime.initialized) return false;
  return enqueueDiskIODiagnostic({ type: "log", id: crypto.randomUUID(), ...message });
}

/**
 * 主线程 -> diskIOWorker：排队一条不进入业务恢复缓冲的旁路诊断（广告命中样本与 AI 缓存用量）。
 *
 * 与 postDiskIO 的差别是它进入独立有界 FIFO，不占 pendingBusinessMessages 的
 * 恢复预算，也不触发业务 fatal；Worker 代际失败后原批重发，容量越界则记入
 * 一条后续汇总。样本文件与用量统计是尽力投递的旁路数据，
 * 见 workers/diskIO/adSampleFile.ts 与 workers/diskIO/aiCacheFile.ts。
 * @param message 广告样本或 AI 缓存用量旁路诊断消息。
 * @returns 已由有界诊断通道接管时返回 `true`（调用方无需自行重试）；Disk I/O 尚未初始化时返回 `false`。
 */
export function postDiskIODiagnostic(message: AdSampleDiskMessage | AiCacheUsageDiskMessage): boolean {
  if (!diskIORuntime.initialized) return false;
  return enqueueDiskIODiagnostic(message);
}

/**
 * 主线程 -> diskIOWorker：统一的快照或增量写入；载荷成本只算一次，准入与排队共用。
 * @param message 待投递的业务持久化消息。
 * @returns 已排入恢复缓冲或操作队列时返回 true，无活跃 Worker、超出容量或投递失败时返回 false。
 */
export function postDiskIO(
  message: DiskBusinessMessage
): boolean {
  const worker: Worker | null = diskIORuntime.worker;
  if (worker === null) return false;
  const cost: number = diskIOMessageCost(message);
  if (!fitsDiskIOBusiness(cost)) return false;
  if (!diskIORuntime.writable) {
    diskIORuntime.pendingBusinessMessages.push(message);
    diskIORuntime.pendingBusinessBytes += cost;
    return true;
  }
  if (queueDiskIOOperationMessage(worker, message, cost)) return true;
  stopWorkerAfterLoadFailure(worker, `Worker synchronously rejected ${message.type}`, true);
  return false;
}

/**
 * 启动恢复：向 diskIOWorker 请求上一次成功落盘的全部状态，带超时。
 * 必须在 runner 开始投喂更新之前调用并等待完成（见 app/lifecycle.ts）。
 * 超时、Worker 不存在或恢复回执带 error 时 reject，调用方不得以空状态继续启动。
 * @param timeoutMs 启动加载握手的超时毫秒数。
 * @returns 从持久化存储恢复的全部数据快照。
 */
export function loadPersistedData(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<LoadedData> {
  requirePositiveFinite(timeoutMs, "Disk I/O load timeout");
  // pendingLoad 是单槽，同一时刻只允许一个启动 load 请求。
  if (pendingLoad.timer !== null) {
    throw new Error("[diskIO] a startup load request is already pending.");
  }
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker) {
    return Promise.reject(new Error("Persistence Worker is unavailable; refusing to start with empty persisted state."));
  }
  const request: LoadRequest = { type: "load", timeZone: getTimeZone(), stickerPacks: stickerPacksForRecovery() };
  return new Promise((resolve: (value: LoadedData | PromiseLike<LoadedData>) => void, reject: (reason?: unknown) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      pendingLoad.resolve = null;
      pendingLoad.reject = null;
      pendingLoad.timer = null;
      reject(new Error(`[diskIO] load handshake timed out after ${timeoutMs}ms; refusing to start with empty persisted state.`));
    }, timeoutMs);
    pendingLoad.timer = timer;
    pendingLoad.reject = reject;
    pendingLoad.resolve = (reply: LoadedReply): void => {
      if (reply.error !== undefined) {
        reject(new Error(`[diskIO] persistence recovery failed: ${reply.error}`));
        return;
      }
      if (reply.luckReceiptSecret === null) {
        reject(new Error("[diskIO] persistence recovery returned no luck receipt secret."));
        return;
      }
      resolve({
        wedMembers: reply.wedMembers,
        aiMemories: reply.aiMemories,
        stickerCatalogs: reply.stickerCatalogs,
        luckDay: reply.luckDay,
        luckReceiptSecret: reply.luckReceiptSecret,
        verifications: reply.verifications,
        pendingBlockedRemovals: reply.pendingBlockedRemovals,
        blocklistEntryCount: reply.blocklistEntryCount,
        permissionEntryCount: reply.permissionEntryCount,
        chatStates: reply.chatStates,
        chatQa: reply.chatQa,
      });
    };
    if (!safePostDiskIO(worker, request, "startup load request")) {
      pendingLoad.resolve = null;
      pendingLoad.reject = null;
      pendingLoad.timer = null;
      clearTimeout(timer);
      reject(new Error("[diskIO] persistence Worker rejected the startup load request."));
    }
  });
}

/**
 * 先排空主线程 `diagnosticQueue` 旁路诊断队列，再要求 `diskIOWorker` 立即把所有 dirty 数据（含待验证增量）全部落盘，
 * 并等待完成，用于进程退出前的最后一刷。等待最长 timeoutMs；resolve 只代表
 * 等待已结束，返回值区分 flushed、timedOut 与 failed。Worker 在这次
 * flush 期间崩溃时，onerror 立即以 failed 结算。
 * @param timeoutMs 刷盘等待的总超时毫秒数。
 * @returns 刷盘结算状态（`"flushed"`、`"timedOut"` 或 `"failed"`）。
 */
export async function flushDiskIO(timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS): Promise<FlushResult> {
  requirePositiveFinite(timeoutMs, "Disk I/O flush timeout");
  const deadline: number = performance.now() + timeoutMs;
  while (
    diskIORuntime.diagnosticQueue.size > 0 ||
    diskIORuntime.diagnosticDroppedMessages > 0
  ) {
    const remaining: number = deadline - performance.now();
    if (remaining <= 0) return "timedOut";
    const diagnostics: FlushResult = await waitForDiskIODiagnostics(remaining);
    if (diagnostics !== "flushed") return diagnostics;
    // Promise 续体恢复前可能已有新的主线程诊断入队；循环重检，直到与发送
    // flush 处于同一个同步片段，诊断先于 flush 信封。
  }
  const remaining: number = deadline - performance.now();
  if (remaining <= 0) return "timedOut";
  return (await flushWritableScope("all", remaining)).result;
}

/**
 * 当前代际可写时经 beginDiskIOFlush 发起 scope 范围的 flush；没有 Worker 或已不可写时直接按 failed 结算。
 * @param scope 刷盘的目标范围（全部领域或单个领域）。
 * @param timeoutMs 刷盘等待的超时毫秒数。
 * @returns 包含刷盘结果与失败领域列表的结构化回执。
 */
async function flushWritableScope(scope: DiskFlushScope, timeoutMs: number): Promise<DomainFlushOutcome> {
  requirePositiveFinite(timeoutMs, "Disk I/O flush timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) return { result: "failed" };
  return beginDiskIOFlush(worker, scope, timeoutMs);
}

/**
 * 单个领域的落盘屏障：Worker 只刷这一个领域（共享 SQLite 的各领域共用一个事务，见
 * types/diskIO/messages.ts 的 DiskFlushScope），回执只带该领域自己的失败
 * （见 workers/diskIO/domainFlush.ts）。
 * @param domain 待刷盘的单个持久化领域名。
 * @param timeoutMs 刷盘等待的超时毫秒数。
 * @returns result 为 "flushed" 表示该领域已 durable，"timedOut"/"failed" 表示没写进去；failedDomains 为本次
 *   回执里的失败领域名，超时或 Worker 崩溃中途结算时没有本次回执，为 undefined。
 */
export function flushDiskIODomain(
  domain: DiskIODomain,
  timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS
): Promise<DomainFlushOutcome> {
  return flushWritableScope(domain, timeoutMs);
}

/**
 * 终止落盘 Worker：先按 closeDiskIOStorage 关库，再清空宿主运行态，拒绝所有待决的 load、
 * 读请求与 flush 并 terminate。关库无法确认残余写已提交时照常终止，随后以该错误 reject，
 * 停机把这一步记为失败（结局 unsettled，见 docs/cn/04-invariants.md）。
 */
export async function terminateDiskIO(): Promise<void> {
  const closeFailure: Error | null = await closeDiskIOStorage();
  resetDiskIOOperations();
  const worker: Worker | null = diskIORuntime.worker;
  diskIORuntime.worker = null;
  diskIORuntime.initialized = false;
  diskIORuntime.writable = false;
  diskIORuntime.diagnosticRecycleWorker = null;
  diskIORuntime.runtimeRecoveryWorker = null;
  clearRuntimeRecoveryTimer();
  diskIORuntime.fatalHandler = undefined;
  diskIORuntime.fatalSignaled = false;
  diskIORuntime.runtimeRecoveryTimeoutMs = LOAD_TIMEOUT_MS;
  diskIORuntime.maxPendingBusinessMessages = DEFAULT_MAX_PENDING_BUSINESS_MESSAGES;
  diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
  diskIORuntime.consecutiveDiagnosticRebuilds = 0;
  diskIORuntime.pendingBusinessMessages.clear();
  resetDiskIODiagnosticChannel();
  diskIOFlushBarrier.settleAll("failed");
  const terminationMessage: string = "Persistence Worker terminated before the request completed.";
  if (pendingLoad.timer !== null) clearTimeout(pendingLoad.timer);
  pendingLoad.timer = null;
  pendingLoad.resolve = null;
  pendingLoad.reject?.(new Error(terminationMessage));
  pendingLoad.reject = null;
  rejectAllPendingDiskIORequests((): string => terminationMessage);
  if (worker !== null) {
    try {
      worker.terminate();
    } catch (error: unknown) {
      throw toErrorOr(error, "Persistence Worker termination failed.");
    }
  }
  if (closeFailure !== null) throw closeFailure;
}
