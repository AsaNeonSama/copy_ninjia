/** owner: main。磁盘 IO 宿主（packages/infra/diskIO.ts）的内存状态与请求通道。 */

import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import type { FlushWaiter } from "../../types/lifecycle";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../../consts/workerSupervisor";
import { createFlushBarrier } from "../../libs/flushBarrier";
import type { FlushBarrier } from "../../libs/flushBarrier";
import { LinkedQueue } from "../../libs/linkedQueue";
import { createRestartThrottle } from "../../libs/restartThrottle";
import { AcknowledgedBatchQueue } from "../../libs/acknowledgedBatchQueue";
import { DISK_OPERATION_CONTROL_RESERVE, DISK_BUSINESS_BATCH_MAX_MESSAGES, DISK_OPERATION_MAX_RETAINED_BYTES } from "../../consts/diskIO/business";
import {
  DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES,
  DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES,
  DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES,
} from "../../consts/diskIO/diagnostics";
import type {
  DiskBusinessMessage,
  DiskIORespawnRegistration,
  DiskDiagnosticMessage,
  QueuedDiskIOOperationMessage,
} from "../../types/diskIO/messages";
import type {
  DiskIODomain,
  DiskIOReplyListeners,
  DiskIORequestOutcome,
  LoadedReply,
  StorageCloseOutcome,
} from "../../types/diskIO/replies";
import type { WorkerRequestTable } from "../../types/workerRequest";
import type { JoinLogRecord, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { IdentityPolicyRawReadResult, BlocklistIdPage } from "../../types/identityStorage";

/** 启动恢复回调槽：loadPersistedData 填充，收到 loaded 回执或 terminateDiskIO 时结算清空；单例固定字段，进程重启后从初始值开始。 */
export const pendingLoad: {
  resolve: ((reply: LoadedReply) => void) | null;
  reject: ((error: Error) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
} = { resolve: null, reject: null, timer: null };

/** 主线程向 Disk I/O Worker 发起 request/reply 的请求通道描述与等待表。 */
export interface DiskIORequestChannel<TResult> {
  /** 通道领域名称。 */
  readonly label: string;
  /** 回执缺少载荷时的错误文案。 */
  readonly missingPayload: string;
  readonly table: WorkerRequestTable<DiskIORequestOutcome<TResult>>;
}

function createDiskIORequestChannel<TResult>(
  label: string,
  missingPayload: string
): DiskIORequestChannel<TResult> {
  return { label, missingPayload, table: { waiters: new Map(), counter: { current: 0 } } };
}

/** 运势密钥查询通道：发起请求时登记，收到回执、超时、代际失效或 terminateDiskIO 时结算摘除；容量与并发请求数同阶，进程重启后从空表开始。 */
export const luckSecretRequests: DiskIORequestChannel<LuckReceiptSecret> =
  createDiskIORequestChannel("luck receipt secret", "Disk I/O Worker returned no luck receipt secret.");

/** 入群日志读取通道：`/batch_kick` 请求时登记，回执、超时、代际失效或 terminateDiskIO 时结算摘除；容量与并发请求数同阶，进程重启后从空表开始。 */
export const joinLogReadRequests: DiskIORequestChannel<readonly JoinLogRecord[]> =
  createDiskIORequestChannel("join log read", "Disk I/O Worker returned no join records.");

/** 身份策略读取通道：冷缺失请求时登记，回执、超时、代际失效或 terminateDiskIO 时结算摘除；容量与并发请求数同阶，进程重启后从空表开始。 */
export const identityPolicyReadRequests: DiskIORequestChannel<IdentityPolicyRawReadResult> =
  createDiskIORequestChannel("identity policy read", "Disk I/O Worker returned no identity policy rows.");

/** 黑名单主键页读取通道：群级补扫请求时登记，回执、超时、代际失效或 terminateDiskIO 时结算摘除；容量与并发请求数同阶，进程重启后从空表开始。 */
export const blocklistIdPageReadRequests: DiskIORequestChannel<BlocklistIdPage> =
  createDiskIORequestChannel("blocklist ID page read", "Disk I/O Worker returned no blocklist ID page.");

/** 停机关库（closeStorage）请求通道：请求时登记，回执、超时、代际失效或 terminateDiskIO 时结算摘除；容量至多一个在途请求，进程重启后从空表开始。 */
export const storageCloseRequests: DiskIORequestChannel<StorageCloseOutcome> =
  createDiskIORequestChannel("storage close", "Disk I/O Worker returned no storage close outcome.");

/** 全部 Disk I/O 请求通道列表，供代际失效、恢复失败与 terminateDiskIO 统一结算等待者。 */
export const DISK_IO_REQUEST_CHANNELS: readonly DiskIORequestChannel<never>[] = [
  luckSecretRequests,
  joinLogReadRequests,
  identityPolicyReadRequests,
  blocklistIdPageReadRequests,
  storageCloseRequests,
] as readonly DiskIORequestChannel<never>[];

interface DiskIORuntime {
  worker: Worker | null;
  initialized: boolean;
  writable: boolean;
  diagnosticRecycleWorker: Worker | null;
  runtimeRecoveryWorker: Worker | null;
  runtimeRecoveryTimer: ReturnType<typeof setTimeout> | null;
  runtimeRecoveryTimeoutMs: number;
  maxPendingBusinessMessages: number;
  fatalHandler: ((error: Error) => void) | undefined;
  fatalSignaled: boolean;
  pendingBusinessMessages: LinkedQueue<DiskBusinessMessage>;
  pendingBusinessBytes: number;
  operationQueue: AcknowledgedBatchQueue<QueuedDiskIOOperationMessage>;
  operationTimer: ReturnType<typeof setTimeout> | null;
  diagnosticQueue: AcknowledgedBatchQueue<DiskDiagnosticMessage>;
  diagnosticDroppedMessages: number;
  diagnosticDroppedSerializedBytes: number;
  diagnosticRetryTimer: ReturnType<typeof setTimeout> | null;
  consecutiveDiagnosticWriteFailures: number;
  consecutiveDiagnosticRebuilds: number;
  diagnosticDrainWaiters: Set<FlushWaiter>;
  respawnListeners: DiskIORespawnRegistration[];
  replyListeners: DiskIOReplyListeners;
  giveUpListeners: (() => void)[];
}

/**
 * 主线程 Disk I/O Worker 宿主运行态：
 * - initDiskIO 填充 Worker 与配置，terminateDiskIO 结算等待者、清理队列与定时器并恢复默认值。
 * - operationQueue 保存单批在途业务与查询消息（容量上限 maxPendingBusinessMessages + DISK_OPERATION_CONTROL_RESERVE、字节上限 DISK_OPERATION_MAX_RETAINED_BYTES），收到批次 ACK 后释放；Worker 崩溃重建期间业务消息转入 pendingBusinessMessages 按原序重放，查询由宿主拒绝。
 * - diagnosticQueue 保存单批在途诊断与日志消息（容量上限 DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES、字节上限 DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES），ACK 后排空，Worker 重建时原批重发；满额越界累加 diagnosticDroppedMessages 与 diagnosticDroppedSerializedBytes 并在恢复空间后追加汇总日志；diagnosticDrainWaiters 在并发 flush 时登记并在 ACK、超时、放弃自愈或 terminateDiskIO 时结算清空。
 * - respawnListeners、replyListeners、giveUpListeners 由各模块初始化时登记，Worker 重建时保留，进程重启后重新注册。
 */
export const diskIORuntime: DiskIORuntime = {
  worker: null,
  initialized: false,
  writable: false,
  diagnosticRecycleWorker: null,
  runtimeRecoveryWorker: null,
  runtimeRecoveryTimer: null,
  runtimeRecoveryTimeoutMs: LOAD_TIMEOUT_MS,
  maxPendingBusinessMessages: DEFAULT_MAX_PENDING_BUSINESS_MESSAGES,
  fatalHandler: undefined,
  fatalSignaled: false,
  pendingBusinessMessages: new LinkedQueue<DiskBusinessMessage>(),
  pendingBusinessBytes: 0,
  operationQueue: new AcknowledgedBatchQueue<QueuedDiskIOOperationMessage>({
    maxBatchMessages: DISK_BUSINESS_BATCH_MAX_MESSAGES,
    maxMessages: DEFAULT_MAX_PENDING_BUSINESS_MESSAGES + DISK_OPERATION_CONTROL_RESERVE,
    maxCost: DISK_OPERATION_MAX_RETAINED_BYTES,
  }),
  operationTimer: null,
  diagnosticQueue: new AcknowledgedBatchQueue<DiskDiagnosticMessage>({
    maxBatchMessages: DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES,
    maxMessages: DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES,
    maxCost: DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES,
  }),
  diagnosticDroppedMessages: 0,
  diagnosticDroppedSerializedBytes: 0,
  diagnosticRetryTimer: null,
  consecutiveDiagnosticWriteFailures: 0,
  consecutiveDiagnosticRebuilds: 0,
  diagnosticDrainWaiters: new Set(),
  respawnListeners: [],
  replyListeners: {
    midnightMaintenance: [],
    verificationPersisted: [],
    aiMemoryDeletedPersisted: [],
    wedMembersDeletedPersisted: [],
    aiMemoryPersisted: [],
    stickerCatalogPersisted: [],
    luckAppendStalled: [],
    identityStoragePersisted: [],
    joinLogPersisted: [],
  },
  giveUpListeners: [],
};

/** Disk I/O Worker 滑动窗口重启节流器：Worker 重建时记录时间戳并淘汰滑出 WORKER_RESTART_WINDOW_MS 的记录，容量上限为 WORKER_MAX_RESTARTS；进程重启后从空窗口重建。 */
export const diskIORestartThrottle: ReturnType<typeof createRestartThrottle> =
  createRestartThrottle(WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS);

/** Disk I/O flush 在途屏障：发起 flush 时登记，收到回执、超时（DISK_IO_FLUSH_TIMEOUT_MS）、崩溃或 terminateDiskIO 时结算清空；容量与在途 flush 请求数同阶，进程重启后从空表重建。 */
export const diskIOFlushBarrier: FlushBarrier<readonly DiskIODomain[]> =
  createFlushBarrier<readonly DiskIODomain[]>({ timeoutMs: DISK_IO_FLUSH_TIMEOUT_MS });
