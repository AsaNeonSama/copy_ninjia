/** Disk I/O 主线程逐请求通道：投递、结局解包与回执结算，等待表机制见 libs/workerRequestTable.ts。 */

import {
  blocklistIdPageReadRequests,
  DISK_IO_REQUEST_CHANNELS,
  diskIORuntime,
  identityPolicyReadRequests,
  joinLogReadRequests,
  luckSecretRequests,
  storageCloseRequests,
} from "../../cache/main/diskIO";
import type { DiskIORequestChannel } from "../../cache/main/diskIO";
import { beginWorkerRequest, failAllWorkerRequests, settleWorkerRequest } from "../../libs/workerRequestTable";
import {
  DISK_IO_REQUEST_REJECTED,
  DISK_IO_REQUEST_TIMED_OUT,
  LOAD_TIMEOUT_MS,
} from "../../consts/diskIO/common";
import { DISK_IO_STORAGE_CLOSE_TIMEOUT_MS } from "../../consts/lifecycle";
import type {
  CloseStorageRequest,
  DiskIORequestMessage,
  EnsureLuckSecretRequest,
  ReadBlocklistIdPageRequest,
  ReadIdentityPoliciesRequest,
  ReadJoinLogRequest,
} from "../../types/diskIO/messages";
import type { DiskIORequestOutcome, StorageCloseOutcome } from "../../types/diskIO/replies";
import type { JoinLogRecord, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { BlocklistIdPage, IdentityPolicyRawReadResult } from "../../types/identityStorage";
import { safePostDiskIO } from "./transport";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";

/**
 * 校验数值为大于 0 的有限浮点数。
 * @param value 待校验的数值。
 * @param label 用于构造 RangeError 的参数英文标签。
 * @returns 通过校验的原数值。
 */
export function requirePositiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number.`);
  return value;
}

/**
 * 一次结算全部请求通道的等待者。
 *
 * @param describe 根据请求通道标签生成失败原因文本的构造函数。
 */
export function rejectAllPendingDiskIORequests(describe: (label: string) => string): void {
  for (const channel of DISK_IO_REQUEST_CHANNELS) {
    failAllWorkerRequests<DiskIORequestOutcome<never>>(channel.table, {
      ok: false,
      failure: "error",
      message: describe(channel.label),
    });
  }
}

/** requestDiskIO 的入参。 */
export interface RequestDiskIOParams<TResult> {
  /** 目标 Disk I/O Worker 实例。 */
  worker: Worker;
  /** 对应领域的请求通道描述符。 */
  channel: DiskIORequestChannel<TResult>;
  /** 单次请求等待回执的超时毫秒数。 */
  timeoutMs: number;
  /** 用等待表发出的 requestId 组装信封；调用方不自行编号。 */
  buildRequest: (requestId: number) => DiskIORequestMessage;
  /** 覆盖文案里的领域名；恢复握手用它区分「恢复期的那一次请求」。 */
  context?: string;
}

/**
 * main -> diskIO 的统一 request/reply 发起点：登记等待者、装超时、投递，同步拒收时
 * 立刻结算。失败结局在这里按领域名组装成 Error 抛给调用方。
 *
 * @param params 请求的目标 Worker、请求通道、超时与消息构造参数。
 * @returns Worker 回执成功时解包出的领域结果载荷。
 */
export async function requestDiskIO<TResult>({
  worker,
  channel,
  timeoutMs,
  buildRequest,
  context,
}: RequestDiskIOParams<TResult>): Promise<TResult> {
  const label: string = context ?? channel.label;
  const outcome: DiskIORequestOutcome<TResult> = await beginWorkerRequest<DiskIORequestOutcome<TResult>>({
    table: channel.table,
    timeoutMs,
    post: (requestId: number): boolean => safePostDiskIO(worker, buildRequest(requestId), `${label} request`),
    onPostError: (error: unknown): void => {
      writeDiskIODiagnostic(`[diskIO] failed to post the ${label} request:`, error);
    },
    timedOut: DISK_IO_REQUEST_TIMED_OUT,
    rejected: DISK_IO_REQUEST_REJECTED,
  });
  if (outcome.ok) return outcome.value;
  switch (outcome.failure) {
    case "timedOut":
      throw new Error(`[diskIO] ${label} request timed out after ${timeoutMs}ms.`);
    case "rejected":
      throw new Error(`[diskIO] persistence Worker rejected the ${label} request.`);
    case "error":
      throw new Error(outcome.message);
  }
}

interface SettleDiskIOReplyParams<TResult> {
  /** 待结算请求所属的通道描述符。 */
  channel: DiskIORequestChannel<TResult>;
  /** 回执对应的请求编号。 */
  requestId: number;
  /** Worker 明确报出的领域错误；缺席才看载荷。 */
  error: string | undefined;
  /** 已经收窄成本通道结果类型的载荷；缺席按失败结算。 */
  payload: TResult | undefined;
}

/**
 * 用一条回执结算对应等待者。迟到、重复或已超时的 requestId 一律忽略；
 * Worker 明确报错或没带载荷时按失败结算，不把缺失载荷解释成空结果。
 *
 * @param params 待结算的通道、请求编号、错误信息与结果载荷。
 */
export function settleDiskIOReply<TResult>({
  channel,
  requestId,
  error,
  payload,
}: SettleDiskIOReplyParams<TResult>): void {
  settleWorkerRequest<DiskIORequestOutcome<TResult>>(
    channel.table,
    requestId,
    error !== undefined || payload === undefined
      ? { ok: false, failure: "error", message: error ?? channel.missingPayload }
      : { ok: true, value: payload }
  );
}

/** requestLuckSecretFromWorker 的入参。 */
export interface RequestLuckSecretParams {
  /** 目标 Disk I/O Worker 实例。 */
  worker: Worker;
  /** 请求运势密钥对应的自然日标识（`YYYY-MM-DD`）。 */
  day: string;
  /** 请求超时毫秒数。 */
  timeoutMs: number;
  /** 报错与诊断日志中使用的请求上下文标签。 */
  context: string;
}

/**
 * 向指定代际请求运势密钥。公开入口与恢复 scoped transport 共用同一套 waiter
 * 记账，Worker 崩溃或恢复失败时由宿主统一拒绝。
 *
 * @param params 运势密钥请求的目标 Worker、日期、超时与上下文说明。
 * @returns 指定日期的运势回执签名密钥。
 */
export function requestLuckSecretFromWorker({
  worker,
  day,
  timeoutMs,
  context,
}: RequestLuckSecretParams): Promise<LuckReceiptSecret> {
  return requestDiskIO<LuckReceiptSecret>({
    worker,
    channel: luckSecretRequests,
    timeoutMs,
    context,
    buildRequest: (requestId: number): EnsureLuckSecretRequest => ({
      type: "ensureLuckSecret",
      requestId,
      day,
    }),
  });
}

/** requestFromWritableWorker 的入参。 */
interface WritableWorkerRequestParams<T> {
  /** 单次请求的超时毫秒数。 */
  readonly timeoutMs: number;
  /** 超时预算非法时报错用的名字。 */
  readonly timeoutLabel: string;
  /** 代际不可写时拒绝文案里的动作（`cannot <action>`）。 */
  readonly action: string;
  /** 向当前可写 Worker 发起请求的回调。 */
  readonly request: (worker: Worker) => Promise<T>;
}

/**
 * 公开读取入口共用的前置：同步校验超时预算，只向当前可写代际发请求；不可写时以
 * `Persistence Worker is unavailable; cannot <action>.` 拒绝。
 * @param params 可写 Worker 请求的超时、标签与请求回调参数。
 * @returns Worker 返回的请求结果。
 */
function requestFromWritableWorker<T>({
  timeoutMs,
  timeoutLabel,
  action,
  request,
}: WritableWorkerRequestParams<T>): Promise<T> {
  requirePositiveFinite(timeoutMs, timeoutLabel);
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) {
    return Promise.reject(new Error(`Persistence Worker is unavailable; cannot ${action}.`));
  }
  return request(worker);
}

/**
 * 配置时区的日期切换后，经唯一 Disk I/O Worker 原子加载或轮换日级运势密钥。
 * @param day 目标日期键（`YYYY-MM-DD`）。
 * @param timeoutMs 请求超时毫秒数。
 * @returns 当日生效的运势回执签名密钥。
 */
export function ensureLuckReceiptSecret(
  day: string,
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<LuckReceiptSecret> {
  return requestFromWritableWorker({
    timeoutMs,
    timeoutLabel: "Luck receipt secret timeout",
    action: "rotate luck receipt secret",
    request: (worker: Worker): Promise<LuckReceiptSecret> => requestLuckSecretFromWorker({
      worker,
      day,
      timeoutMs,
      context: "luck receipt secret request",
    }),
  });
}

/** readJoinLog 的入参。 */
export interface ReadJoinLogParams {
  /** 目标群 ID。 */
  chatId: number;
  /** 起始毫秒时间戳下界（含）。 */
  since: number;
  /** 当前毫秒时间戳上界（含）。 */
  now: number;
  /** 请求超时毫秒数。 */
  timeoutMs?: number;
}

/**
 * 仅供 `/batch_kick` 按需读取本群入群日志；Worker 先提交更早到达的
 * 追写缓冲，返回值覆盖请求之前已处理的全部入群事件。
 * @param params 入群日志读取的时间窗口与群 ID 参数。
 * @returns 指定时间窗口内的本群入群记录列表。
 */
export function readJoinLog({
  chatId,
  since,
  now,
  timeoutMs = LOAD_TIMEOUT_MS,
}: ReadJoinLogParams): Promise<readonly JoinLogRecord[]> {
  return requestFromWritableWorker({
    timeoutMs,
    timeoutLabel: "Join log read timeout",
    action: "read join logs",
    request: (worker: Worker): Promise<readonly JoinLogRecord[]> => requestDiskIO({
      worker,
      channel: joinLogReadRequests,
      timeoutMs,
      buildRequest: (requestId: number): ReadJoinLogRequest => ({ type: "readJoinLog", requestId, chatId, since, now }),
    }),
  });
}

/**
 * 黑白名单与临时广告免检累计 LRU 冷缺失的唯一跨线程批量读取边界。
 * @param ids 待查询的身份 ID 列表。
 * @param timeoutMs 请求超时毫秒数。
 * @returns 指定身份 ID 在 SQLite 中的原始策略读取结果。
 */
export function readIdentityPolicies(
  ids: readonly number[],
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<IdentityPolicyRawReadResult> {
  return requestFromWritableWorker({
    timeoutMs,
    timeoutLabel: "Identity policy read timeout",
    action: "read identity policies",
    request: (worker: Worker): Promise<IdentityPolicyRawReadResult> => requestDiskIO({
      worker,
      channel: identityPolicyReadRequests,
      timeoutMs,
      buildRequest: (requestId: number): ReadIdentityPoliciesRequest => ({ type: "readIdentityPolicies", requestId, ids }),
    }),
  });
}

/**
 * 群级补扫按稳定主键游标读取一页黑名单；普通成员判定不得调用。
 * @param afterId 分页起始游标 ID（不含）；首批次传 `null`。
 * @param timeoutMs 请求超时毫秒数。
 * @returns 下一页黑名单身份 ID 列表与游标状态。
 */
export function readBlocklistIdPage(
  afterId: number | null,
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<BlocklistIdPage> {
  return requestFromWritableWorker({
    timeoutMs,
    timeoutLabel: "Blocklist ID read timeout",
    action: "read a blocklist ID page",
    request: (worker: Worker): Promise<BlocklistIdPage> => requestDiskIO({
      worker,
      channel: blocklistIdPageReadRequests,
      timeoutMs,
      buildRequest: (requestId: number): ReadBlocklistIdPageRequest => ({ type: "readBlocklistIdPage", requestId, afterId }),
    }),
  });
}

/**
 * 停机关库：每条 terminateDiskIO 路径（含未捕获异常的紧急释放）都在当前代际已完成恢复握手、
 * 可写且未发出致命信号时发送一次 closeStorage。先把 writable 置假，此后的业务写在源头进恢复
 * 缓冲、随 terminate 丢弃；Worker 按 FIFO 处理完更早的操作后提交残余写、TRUNCATE checkpoint 并关库。
 * checkpoint 被其它读连接挡住只写诊断（残余写已提交，WAL 留在库旁）。
 * @returns 不满足发送条件或回执确认残余写已提交时为 null；回执报残余写未提交，或请求超时、
 *   被拒、回执报错而无法确认时为描述原因的错误。
 */
export async function closeDiskIOStorage(): Promise<Error | null> {
  const worker: Worker | null = diskIORuntime.worker;
  if (worker === null || !diskIORuntime.initialized || !diskIORuntime.writable || diskIORuntime.fatalSignaled) return null;
  diskIORuntime.writable = false;
  let outcome: StorageCloseOutcome;
  try {
    outcome = await requestDiskIO({
      worker,
      channel: storageCloseRequests,
      timeoutMs: DISK_IO_STORAGE_CLOSE_TIMEOUT_MS,
      buildRequest: (requestId: number): CloseStorageRequest => ({ type: "closeStorage", requestId }),
    });
  } catch (error: unknown) {
    return new Error(
      "[diskIO] could not confirm that residual storage writes were committed before the database closed.",
      { cause: error }
    );
  }
  if (outcome.checkpointBusy) {
    writeDiskIODiagnostic(
      "[diskIO] WAL checkpoint was blocked by another database reader at shutdown; " +
      "the -wal file stays next to the database and must be backed up with it."
    );
  }
  return outcome.committed
    ? null
    : new Error("[diskIO] residual storage writes were not committed before the database closed.");
}
