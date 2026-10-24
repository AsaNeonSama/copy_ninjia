import { logger } from "../infra/logger";
import {
  flushStateToDisk,
} from "../infra/storage/stateStore";
import {
  ANTI_RAID_BARRIER_TIMEOUT_MS,
  ANTI_RAID_DRAIN_MAX_ROUNDS,
} from "../consts/antiRaid/protocol";
import { flushDiskIO, flushDiskIODomain } from "../infra/diskIO";
import { WorkerUndeliveredError } from "../libs/workerDelivery";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../libs/monotonicDeadline";
import { antiRaidBarrier, antiRaidRuntimeState } from "../cache/main/antiRaid/proxy";
import { drainAdDisposals } from "./adDetect";
import { registerBlocklistRemoval } from "./blocklistGuard";
import { prepareDurableAntiRaidMessages } from "./blocklistDelivery";
import { postAntiRaid } from "./workerBridge/controller";
import type { FlushResult } from "../types/lifecycle";
import type { DomainFlushOutcome } from "../types/diskIO/replies";
import type { AntiRaidWorkerMessage } from "../types/antiRaid/protocol";

/**
 * FIFO mailbox barrier：只证明此前消息已同步路由，不等待后台网络副作用。
 *
 * @param timeoutMs 最大等待超时预算（毫秒），默认取 `ANTI_RAID_BARRIER_TIMEOUT_MS`
 * @returns 屏障结算状态（`flushed`、`timedOut` 或 `failed`）
 */
function barrierAntiRaidMailbox(
  timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS
): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return Promise.resolve("flushed");
  return antiRaidBarrier.begin(
    (barrierId: number): boolean => postAntiRaid({ type: "barrier", barrierId }),
    timeoutMs
  );
}

/**
 * 排空 Anti-Raid Worker 的广告检测队列、停止出站调度并刷空延迟删帖队列，
 * 随后等待此前启动的异步副作用全部结算（不处理跨线程持久化握手）。
 *
 * @param timeoutMs 最大等待超时预算（毫秒）
 * @returns 排空结算状态（`flushed`、`timedOut` 或 `failed`）
 */
function drainAntiRaidWorkerTasks(timeoutMs: number): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return Promise.resolve("flushed");
  return antiRaidBarrier.begin(
    (drainId: number): boolean => postAntiRaid({ type: "drain", drainId }),
    timeoutMs
  );
}

/**
 * 停机排空：先排空 Worker 在途任务并停止广告判定节拍，再循环排空主线程广告处置、
 * 邮箱屏障、磁盘与群状态落盘及回执触发的后续 Worker 任务，直至镜像版本收敛或达到 ANTI_RAID_DRAIN_MAX_ROUNDS。
 *
 * @param timeoutMs 最大等待超时预算（毫秒），停机时取 FlushTimeouts 的 `antiRaidMs`
 * @returns 排空结算状态（`flushed`、`timedOut` 或 `failed`）
 */
export async function drainAntiRaid(timeoutMs: number): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return "flushed";
  const deadline: number = createMonotonicDeadline(timeoutMs);
  const quiesceResult: FlushResult =
    await drainAntiRaidWorkerTasks(remainingMonotonicTime(deadline));
  if (quiesceResult !== "flushed") {
    await drainAdDisposals(remainingMonotonicTime(deadline));
    return quiesceResult;
  }
  for (let round: number = 0; round < ANTI_RAID_DRAIN_MAX_ROUNDS; round++) {
    const disposalResult: FlushResult =
      await drainAdDisposals(remainingMonotonicTime(deadline));
    if (disposalResult !== "flushed") return disposalResult;
    const initialBarrier: FlushResult =
      await barrierAntiRaidMailbox(remainingMonotonicTime(deadline));
    if (initialBarrier !== "flushed") return initialBarrier;

    const persistenceBudget: number = remainingMonotonicTime(deadline);
    if (persistenceBudget === 0) return "timedOut";
    const persistenceResults: [
      PromiseSettledResult<FlushResult>,
      PromiseSettledResult<FlushResult>
    ] = await Promise.allSettled([
      flushDiskIO(persistenceBudget),
      flushStateToDisk(persistenceBudget, false),
    ]);
    if (persistenceResults.some(
      (result: PromiseSettledResult<FlushResult>): boolean =>
        result.status === "rejected"
    )) {
      return "failed";
    }
    const diskResult: FlushResult =
      (persistenceResults[0] as PromiseFulfilledResult<FlushResult>).value;
    const stateResult: FlushResult =
      (persistenceResults[1] as PromiseFulfilledResult<FlushResult>).value;
    if (diskResult !== "flushed") return diskResult;
    if (stateResult !== "flushed") return stateResult;

    const receiptBarrier: FlushResult =
      await barrierAntiRaidMailbox(remainingMonotonicTime(deadline));
    if (receiptBarrier !== "flushed") return receiptBarrier;
    const verificationVersionBeforeTasks: number =
      antiRaidRuntimeState.verificationVersion;
    const lockdownVersionBeforeTasks: number =
      antiRaidRuntimeState.lockdownVersion;
    const taskResult: FlushResult =
      await drainAntiRaidWorkerTasks(remainingMonotonicTime(deadline));
    if (taskResult !== "flushed") return taskResult;
    if (
      antiRaidRuntimeState.verificationVersion === verificationVersionBeforeTasks &&
      antiRaidRuntimeState.lockdownVersion === lockdownVersionBeforeTasks
    ) {
      return "flushed";
    }
  }
  logger.error(
    `Anti-Raid drain did not converge after ${ANTI_RAID_DRAIN_MAX_ROUNDS} persistence rounds.`
  );
  return "failed";
}

/**
 * 判断消息批次是否包含黑名单处置消息（removeBlockedMembers）。
 *
 * @param messages 待投递的 Anti-Raid Worker 消息批次
 * @returns 包含至少一条 `removeBlockedMembers` 消息时返回 true，否则返回 false
 */
function containsBlockedRemoval(messages: readonly AntiRaidWorkerMessage[]): boolean {
  for (const message of messages) {
    if (message.type === "removeBlockedMembers") return true;
  }
  return false;
}

/** 标识本次 durable 投递期间发生变化的 Anti-Raid 镜像领域。 */
interface ChangedAntiRaidMirrors {
  /** 入群验证镜像在本轮投递中是否发生变更。 */
  readonly verification: boolean;
  /** 反刷群私密模式镜像在本轮投递中是否发生变更。 */
  readonly lockdown: boolean;
}

/**
 * 提取领域屏障回执的落盘结果。
 *
 * @param outcome DiskIO 领域屏障回执
 * @returns 领域落盘状态（`flushed`、`timedOut` 或 `failed`）
 */
function flushOutcomeResult(outcome: DomainFlushOutcome): FlushResult {
  return outcome.result;
}

/**
 * 刷新发生变化的 Anti-Raid 镜像领域（`verification` 与 `chatState`）。
 *
 * @param changed 本次投递期间发生变更的镜像领域标记
 * @param timeoutMs 最大等待超时预算（毫秒）
 * @returns 验证镜像与群状态镜像各自落盘结算结果的元组 Promise
 */
function flushAntiRaidMirrors(
  changed: ChangedAntiRaidMirrors,
  timeoutMs: number
): Promise<[PromiseSettledResult<FlushResult>, PromiseSettledResult<FlushResult>]> {
  return Promise.allSettled([
    changed.verification ? flushDiskIODomain("verification", timeoutMs).then(flushOutcomeResult) : "flushed",
    changed.lockdown ? flushDiskIODomain("chatState", timeoutMs).then(flushOutcomeResult) : "flushed",
  ]);
}

/**
 * 向 Worker 投递消息并等待邮箱屏障与已变更镜像的领域落盘屏障。
 *
 * @param messages 待投递给 Anti-Raid Worker 的消息批次
 * @param replacedJoins 黑名单移除批次取消时需回退的 `removalId -> join` 消息映射
 * @returns 实际投递给 Worker 的消息条数（见 prepareDurableAntiRaidMessages 与 types/blocklist.ts 的 BlockedMemberRemover）。
 */
export async function postAntiRaidDurably(
  messages: readonly AntiRaidWorkerMessage[],
  replacedJoins?: ReadonlyMap<number, AntiRaidWorkerMessage>
): Promise<number> {
  let messagesToPost: readonly AntiRaidWorkerMessage[] = messages;
  if (containsBlockedRemoval(messages)) {
    messagesToPost = await prepareDurableAntiRaidMessages(
      messages,
      replacedJoins
    );
  }
  if (messagesToPost.length === 0) return 0;
  const postedCount: number = messagesToPost.length;
  const verificationVersionBefore: number = antiRaidRuntimeState.verificationVersion;
  const lockdownVersionBefore: number = antiRaidRuntimeState.lockdownVersion;
  for (const message of messagesToPost) {
    // 投递失败抛 WorkerUndeliveredError；后续屏障或落盘失败抛普通 Error（见 libs/workerDelivery.ts）。
    if (!postAntiRaid(message)) {
      throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
    }
  }
  const barrierResult: FlushResult =
    await barrierAntiRaidMailbox(ANTI_RAID_BARRIER_TIMEOUT_MS);
  if (barrierResult !== "flushed") {
    throw new Error(`Anti-Raid Worker barrier ${barrierResult}.`);
  }
  const changed: ChangedAntiRaidMirrors = {
    verification: antiRaidRuntimeState.verificationVersion !== verificationVersionBefore,
    lockdown: antiRaidRuntimeState.lockdownVersion !== lockdownVersionBefore,
  };
  if (!changed.verification && !changed.lockdown) return postedCount;
  const persistenceResults: [
    PromiseSettledResult<FlushResult>,
    PromiseSettledResult<FlushResult>
  ] = await flushAntiRaidMirrors(changed, ANTI_RAID_BARRIER_TIMEOUT_MS);
  const failures: unknown[] = persistenceResults
    .filter(
      (
        result: PromiseSettledResult<FlushResult>
      ): result is PromiseRejectedResult => result.status === "rejected"
    )
    .map(
      (result: PromiseRejectedResult): unknown =>
        result.reason as unknown
    );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Anti-Raid persistence boundary rejected."
    );
  }
  const verificationResult: FlushResult =
    (persistenceResults[0] as PromiseFulfilledResult<FlushResult>).value;
  const chatStateResult: FlushResult =
    (persistenceResults[1] as PromiseFulfilledResult<FlushResult>).value;
  if (verificationResult !== "flushed" || chatStateResult !== "flushed") {
    throw new Error(
      `Anti-Raid persistence failed: verification=${verificationResult}, chatState=${chatStateResult}.`
    );
  }
  return postedCount;
}

// 黑名单清扫的执行 owner（判定在 infra/blocklist/，执行在 Worker）。
registerBlocklistRemoval(postAntiRaidDurably);
