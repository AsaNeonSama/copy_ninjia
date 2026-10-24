/**
 * Anti-Raid 主线程控制器：只负责 Worker 生命周期、代际切换和公开控制命令。
 * 事件归并、重放数据构建及外部观察者注册分别位于同目录的叶子模块。
 */
import { emergencyLockdownRecoveryRuntime } from "../../cache/main/antiRaid/lockdownMirror";
import { antiRaidBarrier, antiRaidRuntimeState } from "../../cache/main/antiRaid/proxy";
import {
  activeVerificationSnapshots,
  persistedVerificationRevisions,
} from "../../cache/main/antiRaid/verificationMirror";
import { VERIFICATION_RECORD_CAPACITY } from "../../consts/antiRaid/verification";
import { ANTI_RAID_WORKER_URL } from "../../consts/paths";
import {
  postDiskIO,
} from "../../infra/diskIO";
import { prefetchIdentityPolicies } from "../../infra/identityStorage";
import { logger } from "../../infra/logger";
import { replayPendingBlockedRemovals } from "../../infra/blocklist/sweep";
import { superviseDuplexWorker } from "../../infra/supervisedDuplexWorker";
import type { SupervisedWorkerHandle } from "../../infra/supervisedWorker";
import {
  handleAntiRaidWorkerTelegramRequest,
  telegramWorkerResponseTransfer,
} from "../../infra/telegram/workerRequests";
import { WorkerUndeliveredError } from "../../libs/workerDelivery";
import type {
  AdoptableLockdown,
  AdoptLockdownsMessage,
  AntiRaidWorkerMessage,
  AntiRaidWorkerRequest,
} from "../../types/antiRaid/protocol";
import type { AntiRaidWorkerEvent } from "../../types/antiRaid/events";
import type { VerificationSnapshot } from
  "../../types/antiRaid/verification";
import type { WorkerDuplexInbound } from "../../types/workerDuplex";
import {
  buildAdoptLockdownsMessage,
  recoverAbandonedLockdowns,
  seedPersistedLockdownFingerprints,
  stopEmergencyLockdownRecoveries,
} from "../lockdownMirror";
import {
  advanceDeferredVerificationGeneration,
  deleteDeferredVerificationsForChat,
  grantVerificationAttempt,
  resetVerificationAttemptRuntime,
} from "../verificationAttempts";
import { canBypassAdDetection } from "../memberFacts";
import { handleAntiRaidWorkerEvent } from "./events";
import { registerAntiRaidBridgeObservers } from "./observers";
import {
  advanceActiveVerificationGeneration,
  replaceActiveVerificationMirror,
} from "../verificationMirror";
import {
  buildAdoptVerificationsMessage,
  nextAntiRaidGeneration,
  purgeDisabledJoinGuards,
  replayAdDetectAgentConfig,
  replayBotPermissions,
  replayChatKinds,
} from "./replay";
import { isTerminalVerificationPhase } from "../../states/verification/shared";

/**
 * Anti-Raid 专属进程级许可与 Telegram 能力共用既有双工边界。
 *
 * @param request Worker 发起的双工请求载荷
 * @param signal 请求取消信号
 * @returns 双工请求响应值
 */
async function handleAntiRaidWorkerRequest(
  request: AntiRaidWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  if (request.operation === "verificationAttemptPermit") {
    return grantVerificationAttempt(request);
  }
  if (request.operation === "sendTemporaryMessage" && request.purpose === "adWarning") {
    // 引用警告晚于候选入队和模型判定，发送前以主线程当前权限为准；
    // 身份策略冷读失败时按抑制处理。
    const prefetched: boolean = await prefetchIdentityPolicies([request.identityId]);
    if (
      !prefetched ||
      canBypassAdDetection(request.identityId)
    ) return { suppressed: true };
  }
  return handleAntiRaidWorkerTelegramRequest(request, signal);
}

/**
 * 提取 Anti-Raid 双工请求响应需零拷贝转移的底层缓冲区列表。
 *
 * @param request Worker 发起的双工请求载荷
 * @param value 主线程生成的响应值
 * @returns 需转移的 `Bun.Transferable` 列表；无需转移时返回 undefined
 */
function antiRaidWorkerResponseTransfer(
  request: AntiRaidWorkerRequest,
  value: unknown
): Bun.Transferable[] | undefined {
  if (request.operation === "verificationAttemptPermit") return undefined;
  return telegramWorkerResponseTransfer(request, value);
}

const {
  init: initAntiRaidWorker,
  post: postAntiRaid,
  terminate: terminateAntiRaidWorker,
}: SupervisedWorkerHandle<WorkerDuplexInbound<AntiRaidWorkerMessage>> =
  superviseDuplexWorker<
    AntiRaidWorkerMessage,
    AntiRaidWorkerEvent,
    AntiRaidWorkerRequest
  >({
    url: ANTI_RAID_WORKER_URL,
    label: "Anti-raid guard Worker",
    giveUpConsequence:
      "join verification and anti-raid features will silently stay disabled until the process restarts.",
    handleRequest: handleAntiRaidWorkerRequest,
    responseTransfer: antiRaidWorkerResponseTransfer,
    onEvent: (event: AntiRaidWorkerEvent): void => {
      handleAntiRaidWorkerEvent(event, postAntiRaidOrThrow);
    },
    onRespawn: (
      postToNext: (message: AntiRaidWorkerMessage) => boolean
    ): void => {
      antiRaidBarrier.settleAll("failed");
      const generation: number = nextAntiRaidGeneration();
      advanceDeferredVerificationGeneration(generation);
      advanceActiveVerificationGeneration(generation);

      // FIFO：配置、权限与群类型必须先于所有接管快照和新业务消息。
      if (!replayAdDetectAgentConfig(postToNext)) return;
      if (!replayBotPermissions(postToNext)) return;
      if (!replayChatKinds(postToNext)) return;
      if (!postToNext(buildAdoptVerificationsMessage(generation))) return;

      for (const [key, record] of activeVerificationSnapshots) {
        if (!isTerminalVerificationPhase(record.phase)) continue;
        const persisted: { generation: number; revision: number } | undefined =
          persistedVerificationRevisions.get(key);
        if (
          persisted?.generation === record.generation &&
          persisted.revision === record.revision
        ) {
          if (!postToNext({
            type: "verificationPersisted",
            key,
            generation,
            revision: record.revision,
          })) return;
        } else {
          postDiskIO({
            type: "verificationUpsert",
            record: { ...record, generation },
            critical: true,
          });
        }
      }

      const adopt: AdoptLockdownsMessage = buildAdoptLockdownsMessage();
      if (adopt.lockdowns.length > 0 && !postToNext(adopt)) {
        logger.error("Anti-Raid Worker lockdown replay was rejected.");
      }
      purgeDisabledJoinGuards(postToNext);
      replayPendingBlockedRemovals();
    },
    onGiveUp: (): void => {
      antiRaidBarrier.settleAll("failed");
      recoverAbandonedLockdowns();
    },
  });

registerAntiRaidBridgeObservers({
  post: postAntiRaid,
  deactivateChat: deactivateAntiRaidChat,
});

/** 尽力把一条消息投给当前代际的 Anti-Raid Worker；返回是否已投出。 */
export { postAntiRaid };

/**
 * 热重载替换广告检测配置后，把主线程当前快照投给 Worker（见 app/configReload.ts）。
 * 投递被拒绝时由重建路径的 replayAdDetectAgentConfig 按同一份 holder 补齐。
 */
export function syncAntiRaidAgentConfig(): void {
  if (!antiRaidRuntimeState.initialized) return;
  if (!replayAdDetectAgentConfig(postAntiRaid)) {
    logger.error("Anti-Raid Worker rejected the ad detection config reload; the next respawn replays the reloaded snapshot.");
  }
}

/**
 * 向当前代际 Anti-Raid Worker 投递消息；Worker 不可用时抛出 `WorkerUndeliveredError`。
 *
 * @param message 待投递的 Anti-Raid Worker 消息
 */
function postAntiRaidOrThrow(message: AntiRaidWorkerMessage): void {
  if (postAntiRaid(message)) return;
  throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
}

/**
 * 把持久化镜像接管给 Worker。调用点必须早于 runner 投递首条 update，确保 FIFO
 * 中配置与 adopt 均排在新业务消息之前。
 */
export function initAntiRaid(): void {
  if (antiRaidRuntimeState.initialized) return;
  antiRaidRuntimeState.initialized = true;
  antiRaidRuntimeState.verificationVersion = 0;
  antiRaidRuntimeState.lockdownVersion = 0;
  emergencyLockdownRecoveryRuntime.stopped = false;
  seedPersistedLockdownFingerprints();
  const generation: number = nextAntiRaidGeneration();
  advanceActiveVerificationGeneration(generation);
  try {
    initAntiRaidWorker();
    if (!replayAdDetectAgentConfig(postAntiRaid)) {
      throw new WorkerUndeliveredError(
        "Anti-Raid Worker rejected the agent configuration snapshot."
      );
    }
    if (!replayBotPermissions(postAntiRaid)) {
      throw new WorkerUndeliveredError("Anti-Raid Worker rejected the bot permissions snapshot.");
    }
    if (!replayChatKinds(postAntiRaid)) {
      throw new WorkerUndeliveredError("Anti-Raid Worker rejected the chat kind snapshot.");
    }
    postAntiRaidOrThrow(buildAdoptVerificationsMessage(generation, true));
    replayPendingBlockedRemovals(false);
    const adopt: AdoptLockdownsMessage = buildAdoptLockdownsMessage();
    if (adopt.lockdowns.length > 0) {
      postAntiRaidOrThrow(adopt);
      logger.log(
        "Adopted lockdowns still active from previous process exit: " +
        adopt.lockdowns
          .map((lockdown: AdoptableLockdown): number => lockdown.chatId)
          .join(", ")
      );
    }
    // 先 adopt 再拆残留，使 Worker 发出持久化 tombstone。
    purgeDisabledJoinGuards(postAntiRaid);
  } catch (error: unknown) {
    antiRaidRuntimeState.initialized = false;
    stopEmergencyLockdownRecoveries();
    // initAntiRaid 返回后生命周期才置位 antiRaidInitialized，停机路径不会终止这里
    // 已建好的 Worker，失败分支自行终止。
    void terminateAntiRaidWorker().catch((terminateError: unknown): void => {
      logger.error("Failed to terminate the Anti-Raid Worker after its initialization failed:", terminateError);
    });
    throw error;
  }
}

/**
 * 统一群 teardown：取消验证，并对 lockdown 发起可恢复解锁；群已不存在时改为放弃。
 *
 * @param chatId 群聊 ID
 * @param cleanupVerificationMessages 是否删除群内的待验证按钮消息
 * @param abandonLockdown 是否直接放弃私密模式恢复而不发起 Telegram 权限还原
 */
export function deactivateAntiRaidChat(
  chatId: number,
  cleanupVerificationMessages: boolean,
  abandonLockdown: boolean
): void {
  deleteDeferredVerificationsForChat(chatId);
  postAntiRaidOrThrow({
    type: "deactivateChat",
    chatId,
    cleanupVerificationMessages,
    abandonLockdown,
  });
}

/**
 * `/antiraid disable` 只收掉入群验证与 lockdown 链路。
 *
 * @param chatId 群聊 ID
 */
export function deactivateJoinGuardChat(chatId: number): void {
  deleteDeferredVerificationsForChat(chatId);
  postAntiRaidOrThrow({ type: "deactivateJoinGuard", chatId });
}

/**
 * `/ad_detect disable` 丢掉该群已经排进 Worker 的候选消息。
 *
 * @param chatId 群聊 ID
 */
export function clearAdDetection(chatId: number): void {
  postAntiRaidOrThrow({ type: "clearAdDetect", chatId });
}

/**
 * `/flood_control disable` 丢掉该群全部发言窗口。
 *
 * @param chatId 群聊 ID
 */
export function clearFloodControl(chatId: number): void {
  postAntiRaidOrThrow({ type: "clearFloodControl", chatId });
}

/** 停机时终止 Worker；验证与 lockdown 的 write-ahead 镜像仍由主线程持有。 */
export async function terminateAntiRaid(): Promise<void> {
  antiRaidBarrier.settleAll("failed");
  antiRaidRuntimeState.initialized = false;
  stopEmergencyLockdownRecoveries();
  await terminateAntiRaidWorker();
  resetVerificationAttemptRuntime();
}

/**
 * Disk I/O 恢复完成后、Anti-Raid 初始化前灌入主线程验证镜像。
 *
 * @param records 从持久化存储恢复出的验证键到活动快照映射
 */
export function hydratePendingVerifications(
  records: Map<string, VerificationSnapshot>
): void {
  if (antiRaidRuntimeState.initialized) {
    throw new Error(
      "Pending verifications must be hydrated before Anti-Raid initialization."
    );
  }
  if (records.size > VERIFICATION_RECORD_CAPACITY) {
    throw new Error(
      `Pending verification recovery exceeded the ${VERIFICATION_RECORD_CAPACITY}-record capacity.`
    );
  }
  resetVerificationAttemptRuntime();
  replaceActiveVerificationMirror(records);
}
