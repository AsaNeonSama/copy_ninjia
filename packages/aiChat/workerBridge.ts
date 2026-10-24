/**
 * AI 闲聊主线程代理：监督 AI Worker 生命周期、转发配置与生命周期消息、接收记忆与贴纸目录快照并转投 Disk I/O。
 * @see ../../docs/cn/04-invariants.md
 */

import { superviseDuplexWorker } from "../infra/supervisedDuplexWorker";
import { AI_CHAT_WORKER_URL } from "../consts/paths";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { logger } from "../infra/logger";
import { postDiskIO } from "../infra/diskIO";
import { relayAiCacheUsage } from "../infra/aiCacheUsageRelay";
import { isAiChatConfigured } from "./availability";
import { getAgentDeploymentConfig } from "../config/agent";
import { getMoodConfig } from "../config/mood";
import { getPersona } from "../config/persona";
import { voiceToolPromptCache } from "../cache/perThread/config";
import { getStickerConfig } from "../config/stickers";
import { beginAiMemoryTeardown, finishAiMemoryTeardown, nextAiMemoryRevision, requestAiMemoryDelete, settleAiMemoryTeardownWorker } from "./memoryMirror";
import {
  aiChatBotInfo,
  aiChatWorkerState,
  aiChatInvalidateRequests,
  aiMemoryFlushBarrier,
  aiMemoryUsages,
  lastInitState,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  moodRequests,
  postPurgeAiMemoryPersistRevisions,
  purgedAiMemoryChats,
  pendingAiMemoryTeardowns,
  voiceSynthesisRequests,
  webDigestRequests,
} from "../cache/main/aiChat";
import { AI_WORKER_JOB_UNAVAILABLE } from "../consts/aiChat/workerJob";
import {
  AI_CHAT_INVALIDATE_TIMEOUT_MS,
  AI_MEMORY_FLUSH_TIMEOUT_MS,
} from "../consts/lifecycle";
import { MOOD_REQUEST_TIMEOUT_MS } from "../consts/aiChat/mood";
import type { FlushResult } from "../types/lifecycle";
import { adoptTtsUsage, getTtsUsage } from "../infra/storage/stateStore";
import type {
  AiBotInfo,
  AiChatWorkerEvent,
  AiChatWorkerMessage,
  AiConfigReloadMessage,
  AiInitMessage,
} from "../types/aiChat/protocol";
import type { HotDeploymentConfigChanges } from "../types/config";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import { getTimeZone } from "../config/time";
import { botAtmosphere } from "../infra/atmosphere";
import type { AiMemoryTeardown } from "../types/aiChat/waiters";
import type { WorkerRequestOutcome } from "../types/workerRequest";
import { beginWorkerRequest, failAllWorkerRequests, settleWorkerRequest } from "../libs/workerRequestTable";
import type { SupervisedWorkerHandle } from "../infra/supervisedWorker";
import type { WorkerDuplexInbound } from "../types/workerDuplex";
import type { TelegramWorkerRequest } from "../types/telegramWorker";
import {
  handleAiWorkerTelegramRequest,
  telegramWorkerResponseTransfer,
} from "../infra/telegram/workerRequests";
import { activeStickerCatalogs, mirrorStickerCatalog, pruneStickerCatalogMirror } from "./stickerMirror";
import { clearAbuseMarkedUsers, markAbuseUser } from "./abuseMark";
import { requestVoiceSynthesis } from "./voiceSynthesis";
import type { VoiceSynthesisRequest } from "./voiceSynthesis";
import type { VoiceSynthesisResult } from "../types/aiChat/voiceMessage";
import { requestWebDigest } from "./webDigest";
import type { WebDigestCompositionResult, WebDigestRequest } from "../types/webDigest";

/**
 * 解包心情与群失效等 Worker 请求的结算结果：`ok` 为真时返回响应值，否则抛出携带的 `Error`。
 * @param outcome Worker 请求结算结果。
 * @returns 成功时的响应值 `T`。
 */
function unwrapWorkerRequestOutcome<T>(outcome: WorkerRequestOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

/**
 * 旧实例的回执不可能再到达（崩溃重建、放弃自愈或停机）时统一失败结算全部在途等待者：
 * 记忆 flush、心情查询/重抽、群失效、语音合成与摘要组稿。
 * @param moodReason 心情请求失败结算的错误消息。
 * @param invalidateReason 群失效请求失败结算的错误消息。
 */
function failAllAiChatWaiters(moodReason: string, invalidateReason: string): void {
  aiMemoryFlushBarrier.settleAll("failed");
  failAllWorkerRequests<WorkerRequestOutcome<string>>(moodRequests, { ok: false, error: new Error(moodReason) });
  failAllWorkerRequests<WorkerRequestOutcome<undefined>>(
    aiChatInvalidateRequests,
    { ok: false, error: new Error(invalidateReason) }
  );
  failAllWorkerRequests<VoiceSynthesisResult>(voiceSynthesisRequests, AI_WORKER_JOB_UNAVAILABLE);
  failAllWorkerRequests<WebDigestCompositionResult>(webDigestRequests, AI_WORKER_JOB_UNAVAILABLE);
}

const { init: initAiChatWorker, post, terminate: terminateAiChatWorker }: SupervisedWorkerHandle<WorkerDuplexInbound<AiChatWorkerMessage>> = superviseDuplexWorker<AiChatWorkerMessage, AiChatWorkerEvent, TelegramWorkerRequest>({
  url: AI_CHAT_WORKER_URL,
  label: "AI Worker",
  giveUpConsequence: "AI chat feature will silently stay disabled until the process restarts.",
  handleRequest: handleAiWorkerTelegramRequest,
  responseTransfer: telegramWorkerResponseTransfer,
  onEvent: (event: AiChatWorkerEvent): void => {
    switch (event.type) {
      case "memory":
        if (purgedAiMemoryChats.has(event.chatId)) {
          requestAiMemoryDelete(event.chatId, false);
          break;
        }
        {
          const revision: number = nextAiMemoryRevision(event.chatId);
          const persistImmediately: boolean =
            event.persistImmediately === true &&
            postPurgeAiMemoryPersistRevisions.has(event.chatId);
          if (persistImmediately) {
            postPurgeAiMemoryPersistRevisions.set(event.chatId, revision);
          }
          latestAiMemories.set(event.chatId, event.snapshot);
          latestAiMemoryRevisions.set(event.chatId, revision);
          aiMemoryUsages.set(event.chatId, event.usage);
          postDiskIO({
            type: "aiMemory",
            chatId: event.chatId,
            revision,
            snapshot: event.snapshot,
            persistImmediately,
          });
        }
        break;
      case "memoryUsages":
        for (const [chatId, usage] of event.usages) {
          if (purgedAiMemoryChats.has(chatId)) continue;
          aiMemoryUsages.set(chatId, usage);
        }
        break;
      case "memoryDeleted":
        purgedAiMemoryChats.delete(event.chatId);
        requestAiMemoryDelete(event.chatId, false);
        break;
      case "stickerCatalog":
        mirrorStickerCatalog(event.pack, event.snapshot);
        break;
      case "memoryFlushed": {
        aiMemoryFlushBarrier.settle(event.flushId, "flushed");
        break;
      }
      case "chatInvalidated": {
        const teardown: AiMemoryTeardown | undefined = pendingAiMemoryTeardowns.get(event.chatId);
        if (teardown?.requestId === event.requestId) {
          teardown.workerSettled = true;
          finishAiMemoryTeardown(event.chatId);
        }
        settleWorkerRequest(aiChatInvalidateRequests, event.requestId, { ok: true, value: undefined });
        break;
      }
      case "moodQueried":
      case "moodSwitched":
        settleWorkerRequest(moodRequests, event.requestId, { ok: true, value: event.moodName });
        break;
      case "voiceSynthesized":
        settleWorkerRequest(voiceSynthesisRequests, event.requestId, event.result);
        break;
      case "webDigestComposed":
        settleWorkerRequest(webDigestRequests, event.requestId, event.result);
        break;
      case "ttsUsage":
        adoptTtsUsage(event.usage);
        break;
      case "aiCacheUsage":
        relayAiCacheUsage(event.usage);
        break;
      case "abuseMark":
        markAbuseUser(event.userId);
        break;
    }
  },
  onRespawn: (postToNext: (message: AiChatWorkerMessage) => boolean): void => {
    failAllAiChatWaiters(
      "AI Worker crashed before acknowledging the mood request.",
      "AI Worker crashed before completing chat invalidation."
    );
    settleAiMemoryTeardownWorker();
    if (lastInitState.current && !postToNext(lastInitState.current)) return;
    if (lastInitState.current && !postToNext({ type: "hydrateTtsUsage", usage: getTtsUsage() })) return;
    if (latestAiMemories.size > 0) {
      if (!postToNext({ type: "hydrate", memories: latestAiMemories })) return;
    }
    if (latestStickerCatalogs.size > 0) {
      if (!postToNext({ type: "hydrateStickerCatalog", catalogs: activeStickerCatalogs() })) {
        logger.error("AI Worker sticker catalog replay was rejected.");
      }
    }
  },
  onGiveUp: (): void => {
    aiChatWorkerState.available = false;
    lastInitState.current = null;
    failAllAiChatWaiters(
      "AI Worker gave up restarting before acknowledging the mood request.",
      "AI Worker gave up before completing chat invalidation."
    );
    purgedAiMemoryChats.clear();
    for (const [chatId, revision] of postPurgeAiMemoryPersistRevisions) {
      if (revision === null) postPurgeAiMemoryPersistRevisions.delete(chatId);
    }
    settleAiMemoryTeardownWorker();
  },
});

/**
 * 向当前 AI Worker 投递协议消息；同步拒绝时关闭可用标记并抛错。
 * @param message 待投递给 AI Worker 的协议消息。
 */
export function postAiChatOrThrow(message: AiChatWorkerMessage): void {
  if (post(message)) return;
  aiChatWorkerState.available = false;
  throw new Error("AI Worker is unavailable.");
}

/**
 * 启动 AI Worker 并依次投递 `init` 与 `hydrateTtsUsage`，成功后记录 `lastInitState` 并标记可用；
 * 投递失败时终止已创建的 Worker 并抛错。
 * @param botInfo 机器人自身账号身份信息。
 */
export function startAiChatWorker(botInfo: AiBotInfo): void {
  pruneStickerCatalogMirror(getStickerConfig().packs);
  initAiChatWorker();
  const message: AiInitMessage = {
    type: "init",
    timeZone: getTimeZone(),
    botInfo,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    atmosphere: botAtmosphere(),
    agent: getAgentDeploymentConfig(),
    mood: getMoodConfig(),
    stickers: getStickerConfig(),
    persona: getPersona(),
    voiceToolPrompt: voiceToolPromptCache.current,
  };
  try {
    postAiChatOrThrow(message);
    postAiChatOrThrow({ type: "hydrateTtsUsage", usage: getTtsUsage() });
  } catch (error: unknown) {
    void terminateAiChatWorker().catch((terminateError: unknown): void => {
      logger.error("Failed to terminate the AI Worker after its initialization failed:", terminateError);
    });
    throw error;
  }
  lastInitState.current = message;
  aiChatWorkerState.available = true;
}

/**
 * 记录机器人账号身份，并在 AI 配置就绪时启动 AI Worker。
 * @param botInfo 机器人自身账号身份信息。
 */
export function initAiChat(botInfo: AiBotInfo): void {
  const identity: AiBotInfo = { id: botInfo.id, username: botInfo.username, first_name: botInfo.first_name };
  aiChatBotInfo.current = identity;
  if (!isAiChatConfigured()) {
    logger.log("AI agent configuration is unavailable; the AI chat worker stays down and /ai_chat enable is refused.");
    return;
  }
  startAiChatWorker(identity);
}

/** syncAiChatConfig 要重投的配置领域；与 HotDeploymentConfigChanges 的同名字段一致。 */
export type AiConfigDomains = Pick<HotDeploymentConfigChanges, "aiAgent" | "mood" | "stickers">;

/**
 * 更新 `lastInitState` 中的配置快照并向运行中的 AI Worker 投递 `configReload`。
 * @param domains 发生变更并需同步给 AI Worker 的配置领域标记。
 */
export function syncAiChatConfig(domains: AiConfigDomains): void {
  if (domains.stickers) pruneStickerCatalogMirror(getStickerConfig().packs);
  const init: AiInitMessage | null = lastInitState.current;
  if (init === null) return;
  lastInitState.current = {
    ...init,
    agent: getAgentDeploymentConfig(),
    mood: getMoodConfig(),
    stickers: getStickerConfig(),
  };
  const message: AiConfigReloadMessage = {
    type: "configReload",
    agent: domains.aiAgent ? getAgentDeploymentConfig() : undefined,
    mood: domains.mood ? getMoodConfig() : undefined,
    stickers: domains.stickers ? getStickerConfig() : undefined,
  };
  if (!post(message)) {
    logger.error("AI Worker rejected the deployment config reload; the next respawn replays the reloaded snapshot.");
  }
}

/**
 * 请求 AI Worker 立即上报全部 dirty 的群记忆与贴纸目录快照并等待完成；Worker 尚未初始化时直接兑现 `"flushed"`。
 * @param timeoutMs 等待刷盘回执的超时毫秒数，默认 `AI_MEMORY_FLUSH_TIMEOUT_MS`。
 * @returns 刷盘屏障结算状态（`"flushed"`、`"timedOut"` 或 `"failed"`）。
 */
export function flushAiMemory(timeoutMs: number = AI_MEMORY_FLUSH_TIMEOUT_MS): Promise<FlushResult> {
  if (lastInitState.current === null) return Promise.resolve("flushed");
  return aiMemoryFlushBarrier.begin(
    (id: number): boolean => post({ type: "flushMemory", flushId: id }),
    timeoutMs
  );
}

/** 终止 AI Worker 并清理在途等待表与临时状态。 */
export async function terminateAiChat(): Promise<void> {
  failAllAiChatWaiters(
    "AI Worker is shutting down before acknowledging the mood request.",
    "AI Worker is shutting down before completing chat invalidation."
  );
  aiChatWorkerState.available = false;
  clearAbuseMarkedUsers();
  purgedAiMemoryChats.clear();
  postPurgeAiMemoryPersistRevisions.clear();
  await terminateAiChatWorker();
  settleAiMemoryTeardownWorker();
}

/**
 * 向 AI Worker 查询或重抽全局心情并等待结果回执。
 * @param requestType 心情操作类型（查询当前心情或重抽心情）。
 * @returns 当前生效或新抽出的心情名称。
 */
export async function requestAiMood(requestType: "queryMood" | "switchMood"): Promise<string> {
  const deadlineAt: number = Date.now() + MOOD_REQUEST_TIMEOUT_MS;
  return unwrapWorkerRequestOutcome(await beginWorkerRequest<WorkerRequestOutcome<string>>({
    table: moodRequests,
    timeoutMs: MOOD_REQUEST_TIMEOUT_MS,
    post: (requestId: number): boolean => {
      if (post({ type: requestType, requestId, deadlineAt })) return true;
      aiChatWorkerState.available = false;
      return false;
    },
    onPostError: (error: unknown): void => {
      logger.error(`Failed to post the AI ${requestType} request:`, error);
    },
    timedOut: { ok: false, error: new Error(`AI ${requestType} request timed out after ${MOOD_REQUEST_TIMEOUT_MS}ms.`) },
    rejected: { ok: false, error: new Error("AI Worker is unavailable.") },
  }));
}

/**
 * 向 AI Worker 请求合成一句语音。
 * @param request 语音合成请求参数，包含待合成文本、配额口径与取消信号。
 * @returns 语音合成结果或失败原因。
 */
export function synthesizeVoice(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
  return requestVoiceSynthesis(request, {
    post,
    workerAvailable: aiChatWorkerState.available && lastInitState.current !== null,
  });
}

/**
 * 向 AI Worker 请求生成一份联网摘要。
 * @param request 联网摘要检索与组稿参数。
 * @param signal 调用方取消信号。
 * @returns 联网摘要组稿结果或失败原因。
 */
export function composeWebDigest(request: WebDigestRequest, signal: AbortSignal): Promise<WebDigestCompositionResult> {
  return requestWebDigest(request, signal, {
    post,
    workerAvailable: aiChatWorkerState.available && lastInitState.current !== null,
  });
}

/**
 * 使指定群聊在 AI Worker 中的运行时失效并持久化删除其 AI 记忆。
 * @param chatId 群聊 ID。
 */
export async function invalidateAiChat(chatId: number): Promise<void> {
  if (aiChatWorkerState.available) purgedAiMemoryChats.add(chatId);
  const persistedDelete: Promise<void> = requestAiMemoryDelete(chatId, true);
  let workerInvalidated: Promise<void> | undefined;
  if (aiChatWorkerState.available) {
    workerInvalidated = beginWorkerRequest<WorkerRequestOutcome<undefined>>({
      table: aiChatInvalidateRequests,
      timeoutMs: AI_CHAT_INVALIDATE_TIMEOUT_MS,
      post: (requestId: number): boolean => {
        const teardown: AiMemoryTeardown | undefined = pendingAiMemoryTeardowns.get(chatId);
        if (teardown !== undefined) teardown.requestId = requestId;
        return post({ type: "invalidateChat", chatId, requestId });
      },
      onPostError: (error: unknown): void => {
        logger.error(`Failed to post the AI chat invalidation request for chat ${chatId}:`, error);
      },
      timedOut: {
        ok: false,
        error: new Error(`AI chat invalidation for chat ${chatId} timed out after ${AI_CHAT_INVALIDATE_TIMEOUT_MS}ms.`),
      },
      rejected: { ok: false, error: new Error("AI Worker is unavailable while invalidating chat runtime.") },
    }).then(unwrapWorkerRequestOutcome);
  }
  const settlements: PromiseSettledResult<void>[] = await Promise.allSettled([
    persistedDelete,
    workerInvalidated ?? Promise.resolve(),
  ]);
  const labels: readonly string[] = ["durable memory deletion", "Worker runtime invalidation"];
  const failures: unknown[] = [];
  for (let index: number = 0; index < settlements.length; index++) {
    const settlement: PromiseSettledResult<void> = settlements[index]!;
    if (settlement.status === "fulfilled") continue;
    logger.error(
      `AI chat ${labels[index]} rejected for chat ${chatId}:`,
      settlement.reason
    );
    failures.push(settlement.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `AI chat invalidation failed for chat ${chatId}.`);
  }
}

registerChatTeardown("aiChat", async (chatId: number): Promise<void> => {
  beginAiMemoryTeardown(chatId);
  try {
    await invalidateAiChat(chatId);
  } finally {
    finishAiMemoryTeardown(chatId);
  }
});
