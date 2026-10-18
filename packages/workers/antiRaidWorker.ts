import {
  dispatchVerification,
  adoptVerifications,
  handleVerificationPersisted,
  deactivateVerificationChat,
  disableJoinGuardChat,
  deleteDeferredVerification,
  stopVerificationRuntime,
} from "./antiRaid/verificationRuntime";
import { handleJoinEvent, handleTrackedMessageEvent } from "./antiRaid/verificationEvents";
import { handleVerificationCallbackEvent } from "./antiRaid/verificationCallbacks";
import { installAiCacheUsageSink } from "../infra/aiCacheUsage";
import type { AiCacheUsage } from "../types/aiCache";
import {
  adoptLockdowns,
  abandonLockdownChat,
  deactivateLockdownChat,
  handleLockdownPersisted,
  handleLockdownPersistFailed,
  retryDeniedLockdownRestore,
  stopLockdownRuntime,
} from "./antiRaid/lockdownRuntime";
import { applyAdminChange } from "./antiRaid/adminCache";
import { handleRemoveBlockedMembers } from "./antiRaid/blocklistEffects";
import {
  clearChatAdDetect,
  clearIdentityAdDetect,
  enqueueAdCandidate,
  quiesceAdDetectQueue,
  startAdDetectQueue,
  stopAdDetectQueue,
  sweepAdDetect,
} from "./antiRaid/adDetect/queue";
import {
  clearChatFloodWindows,
  handleFloodCandidate,
  resetFloodWindows,
  sweepFloodWindows,
} from "./antiRaid/floodControl";
import {
  applyBotPermissionsChange,
  botCanRestrictIn,
  resetWorkerBotPermissions,
} from "./antiRaid/botPermissions";
import {
  applyChatKindChange,
  forgetWorkerChatKind,
  resetWorkerChatKind,
} from "./antiRaid/chatKind";
import { bumpBlocklistRemovalEpoch } from "../cache/workers/antiRaid/blocklist";
import { adoptAdDetectConfigMessage } from "./antiRaid/adDetect/config";
import { ANTI_RAID_CACHE_SWEEP_INTERVAL_MS } from "../consts/antiRaid/cache";
import { clearChatAdminCache, resetAdminCache, sweepAdminCache } from "../cache/workers/antiRaid/admins";
import { resetLinkedChannelCache, sweepLinkedChannelCache } from "../cache/workers/antiRaid/linkedChannels";
import { sweepVerificationRevisionCache } from "../cache/workers/antiRaid/verification";
import type {
  AntiRaidWorkerMessage,
  AntiRaidWorkerRequest,
} from "../types/antiRaid/protocol";
import type {
  AdDetectedEvent,
  AdVerdictTrueEvent,
} from "../types/antiRaid/adDetect";
import type {
  AntiRaidAiCacheUsageEvent,
  AntiRaidBarrierCompleteEvent,
  AntiRaidDrainCompleteEvent,
  BlockedMembersRemovedEvent,
} from "../types/antiRaid/events";
import {
  flushPendingMessageDeletions,
  resetPendingMessageDeletions as resetGenericMessageDeletions,
} from "../infra/telegram/actions/messageLifecycle";
import { resetRecentComments, sweepRecentComments } from "./antiRaid/recentComments";
import { antiRaidCacheSweepTimer } from "../cache/workers/antiRaid/worker";
import { antiRaidDispatchSignal } from "../cache/workers/antiRaid/tasks";
import {
  drainAntiRaidTasks,
  quiesceAntiRaidDispatch,
  resetAntiRaidTaskTracker,
  trackAntiRaidTask,
} from "./antiRaid/taskTracker";
import {
  resetWorkerDuplex,
  setWorkerDuplexRequestSignal,
} from "../libs/workerDuplex";
import { atmosphereState } from "../cache/workers/antiRaid/atmosphere";
import { adoptTimeZone } from "../config/time";
import { installBusinessWorkerPort } from "./businessWorkerPort";

/**
 * 入群守卫线程（Bun Worker）：承载入群验证、反刷群私密模式、黑名单移除、广告检测与刷屏禁言的消息路由及定时缓存清理（跨模块不变量见 docs/cn/04-invariants.md）。
 */

declare const self: Worker;

/** 路由一条主线程消息。 */
export function handleAntiRaidWorkerMessage(msg: AntiRaidWorkerMessage): void {
  switch (msg.type) {
    case "agentConfig":
      adoptTimeZone(msg.timeZone);
      atmosphereState.current = msg.atmosphere;
      adoptAdDetectConfigMessage(msg);
      break;
    case "join":
      handleJoinEvent(msg, dispatchVerification);
      break;
    case "left":
      if (!deleteDeferredVerification(msg.chatId, msg.userId)) {
        dispatchVerification(msg.chatId, msg.userId, { type: "left" });
      }
      break;
    case "deactivateChat":
      if (msg.cleanupVerificationMessages) disableJoinGuardChat(msg.chatId);
      else deactivateVerificationChat(msg.chatId);
      if (msg.abandonLockdown) abandonLockdownChat(msg.chatId);
      else deactivateLockdownChat(msg.chatId);
      bumpBlocklistRemovalEpoch(msg.chatId);
      clearChatAdDetect(msg.chatId);
      clearChatFloodWindows(msg.chatId);
      clearChatAdminCache(msg.chatId);
      applyBotPermissionsChange(msg.chatId, undefined);
      forgetWorkerChatKind(msg.chatId);
      break;
    case "deactivateJoinGuard":
      // `/antiraid disable`：仅关闭入群验证与私密模式，保留广告检测、刷屏窗口、权限与群类型镜像及黑名单补扫。
      disableJoinGuardChat(msg.chatId);
      deactivateLockdownChat(msg.chatId);
      break;
    case "message":
      handleTrackedMessageEvent(msg, dispatchVerification);
      break;
    case "callback":
      handleVerificationCallbackEvent(msg, dispatchVerification);
      break;
    case "adopt":
      adoptLockdowns(msg.lockdowns);
      break;
    case "lockdownPersisted":
      handleLockdownPersisted(msg);
      break;
    case "lockdownPersistFailed":
      handleLockdownPersistFailed(msg);
      break;
    case "adoptVerifications":
      adoptVerifications(msg);
      break;
    case "verificationPersisted":
      handleVerificationPersisted(msg);
      break;
    case "adminsChanged":
      applyAdminChange(msg.chatId, msg.userId, msg.isInviterExempt);
      break;
    case "removeBlockedMembers":
      void trackAntiRaidTask({
        task: handleRemoveBlockedMembers({
          msg,
          publish: (event: BlockedMembersRemovedEvent): void => self.postMessage(event),
        }),
        blocklistChatId: msg.chatId,
      });
      break;
    case "adCandidate":
      enqueueAdCandidate(msg);
      break;
    case "clearAdDetect":
      clearChatAdDetect(msg.chatId);
      break;
    case "floodCandidate":
      handleFloodCandidate(msg);
      break;
    case "clearFloodControl":
      clearChatFloodWindows(msg.chatId);
      break;
    case "temporaryAdBypassGranted":
      clearIdentityAdDetect(msg.identityId);
      break;
    case "botPermissionsChanged": {
      // 限制成员权限变为确证可用时，立即触发此前因缺权限拉长的私密模式解除重试。
      const couldRestrict: boolean = botCanRestrictIn(msg.chatId) === true;
      applyBotPermissionsChange(msg.chatId, msg.permissions);
      if (!couldRestrict && msg.permissions?.canRestrictMembers === true) retryDeniedLockdownRestore(msg.chatId);
      break;
    }
    case "chatKind":
      applyChatKindChange(msg.chatId, msg.isSupergroup);
      break;
    case "barrier":
      self.postMessage({ type: "barrierComplete", barrierId: msg.barrierId } satisfies AntiRaidBarrierCompleteEvent);
      break;
    case "drain": {
      // 停机排空：先停止广告检测调度并取消排队中的尽力而为请求，再以无取消信号刷出待执行的延迟删除任务并等待全部在途任务完成。
      quiesceAdDetectQueue();
      quiesceAntiRaidDispatch();
      setWorkerDuplexRequestSignal(null);
      let deletionTasks: readonly Promise<void>[];
      try {
        deletionTasks = flushPendingMessageDeletions();
      } finally {
        setWorkerDuplexRequestSignal(antiRaidDispatchSignal());
      }
      for (const task of deletionTasks) {
        void trackAntiRaidTask({ task });
      }
      void drainAntiRaidTasks().then((): void => {
        self.postMessage({ type: "drainComplete", drainId: msg.drainId } satisfies AntiRaidDrainCompleteEvent);
      });
      break;
    }
  }
}

/** 按各缓存的 TTL 删除过期条目。 */
export function sweepAntiRaidWorkerCaches(now: number = Date.now()): void {
  sweepAdminCache(now);
  sweepLinkedChannelCache(now);
  sweepVerificationRevisionCache(now);
  sweepRecentComments(now);
  sweepAdDetect(now);
  sweepFloodWindows(now);
}

/** Worker 线程启动入口；主线程导入本模块时不得注册 handler 或 sweeper。 */
export function startAntiRaidWorker(): void {
  if (antiRaidCacheSweepTimer.current !== null) return;
  installBusinessWorkerPort<AntiRaidWorkerRequest, AntiRaidWorkerMessage>(handleAntiRaidWorkerMessage);
  setWorkerDuplexRequestSignal(antiRaidDispatchSignal());
  installAiCacheUsageSink((usage: AiCacheUsage): void => {
    self.postMessage({ type: "aiCacheUsage", usage } satisfies AntiRaidAiCacheUsageEvent);
  });
  startAdDetectQueue(
    (event: AdDetectedEvent): void => self.postMessage(event),
    (event: AdVerdictTrueEvent): void => self.postMessage(event)
  );
  antiRaidCacheSweepTimer.current = setInterval(sweepAntiRaidWorkerCaches, ANTI_RAID_CACHE_SWEEP_INTERVAL_MS);
  antiRaidCacheSweepTimer.current.unref();
  process.once("exit", stopAntiRaidWorker);
}

/** 协作式退出时清掉唯一 sweeper；强制 terminate 时整个 Worker isolate 一并销毁。 */
export function stopAntiRaidWorker(): void {
  if (antiRaidCacheSweepTimer.current !== null) {
    clearInterval(antiRaidCacheSweepTimer.current);
    antiRaidCacheSweepTimer.current = null;
  }
  stopVerificationRuntime();
  stopLockdownRuntime();
  stopAdDetectQueue();
  installAiCacheUsageSink(null);
  resetAdminCache();
  resetLinkedChannelCache();
  resetRecentComments();
  resetFloodWindows();
  resetGenericMessageDeletions();
  resetWorkerBotPermissions();
  atmosphereState.current = null;
  resetWorkerChatKind();
  resetAntiRaidTaskTracker();
  resetWorkerDuplex("Anti-Raid Worker stopped before the main-thread request completed.");
  self.onmessage = null;
  process.off("exit", stopAntiRaidWorker);
}

if (!Bun.isMainThread) startAntiRaidWorker();
