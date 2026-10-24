/**
 * AI 闲聊 Worker 入口：负责主线程消息路由、初始化与配置热重载接管、群失效与停机排空，
 * 以及周期性缓存清扫、排队触发补跑和脏记忆/贴纸目录快照上报。
 */

import {
  drainStickerCatalogTasks,
  ensureStickerCatalogs,
  flushDirtyStickerCatalogs,
  hydrateStickerCatalogs,
  pruneStickerCatalogs,
  retryIncompleteStickerCatalogs,
} from "../aiChat/ai/stickers/catalog";
import { installAiCacheUsageSink } from "../infra/aiCacheUsage";
import type { AiCacheUsage } from "../types/aiCache";
import { adoptStickerConfig, getStickerConfig } from "../config/stickers";
import { adoptMoodConfig } from "../config/mood";
import { adoptPersona } from "../config/persona";
import { adoptAgentDeploymentConfig } from "../config/agent";
import { TEXT_GEMINI_CONTEXT_CACHE_SCOPE } from "../aiChat/gemini/contextCache";
import { reportUnimplementedAgentCapabilities } from "../aiChat/provider";
import { startWeatherRefreshLoop, stopWeatherRefreshLoop } from "../aiChat/ai/weather";
import { AI_SNAPSHOT_INTERVAL_MS } from "../consts/aiChat/memory";
import { botInfoState, superAdminUserIdState, atmosphereState } from "../cache/workers/aiChat/identity";
import { adoptTimeZone } from "../config/time";
import { TOKYO_TIME_ZONE } from "../consts/time";
import { sweepImageGenerationCache } from "../cache/workers/aiChat/imageGeneration";
import { sweepGeminiReplyRequestTimes } from "../cache/workers/aiChat/geminiContextCache";
import { probeGeminiContextCache } from "../infra/geminiContextCache";
import { clearChatMemoryCache } from "../cache/workers/aiChat/memory";
import { sweepAiChatReplyCache } from "../cache/workers/aiChat/replies";
import { voiceToolPromptCache } from "../cache/perThread/config";
import {
  aiChatMaintenanceTimer,
  aiChatWorkerAbortController,
  aiChatWorkerDrain,
  aiChatWorkerQuiescing,
} from "../cache/workers/aiChat/worker";
import {
  flushDirtyMemories,
  flushMemorySnapshot,
  hydrateMemories,
  recordChatMessage,
} from "./aiChat/rollingMemory";
import { recordChatMedia } from "./aiChat/mediaIngest";
import { handleCancelVoiceSynthesis, handleSynthesizeVoice } from "./aiChat/voiceSynthesis";
import { handleCancelWebDigest, handleComposeWebDigest } from "./aiChat/webDigest";
import { hydrateTtsUsage } from "../aiChat/ai/ttsUsage";
import { recordBotImage, resolveRepliedBotImage } from "./aiChat/botImages";
import type { BufferedMessage } from "../types/aiChat/memory";
import { applyAiChatConfigReload } from "./aiChat/configReload";
import {
  drainPendingReplyQueues,
  generateAndSendReply,
} from "./aiChat/replyPipeline";
import { invalidateChatReplies, quiesceAiChatReplies } from "./aiChat/replyGeneration";
import { currentMood, switchMood } from "../aiChat/ai/mood";
import type {
  AiCacheUsageEvent,
  AiChatInvalidatedEvent,
  AiChatWorkerMessage,
  AiInvalidateChatMessage,
  AiMemoryDeletedEvent,
  AiMemoryFlushedEvent,
  AiMoodQueriedEvent,
  AiMoodSwitchedEvent,
  RepliedBotImage,
} from "../types/aiChat/protocol";
import type { AiStickerCatalogEvent } from "../types/stickers/protocol";
import { resetWorkerDuplex } from "../libs/workerDuplex";
import type { TelegramWorkerRequest } from "../types/telegramWorker";
import { logger } from "../infra/logger";
import { installBusinessWorkerPort } from "./businessWorkerPort";

declare const self: Worker;

/**
 * 失效指定群的在途回复代际、清空群滚动记忆缓存，并依次上报 memoryDeleted 与 chatInvalidated 事件。
 *
 * @param msg 群失效指令载荷，包含目标群 ID 与请求序号
 */
function handleInvalidateChat(msg: AiInvalidateChatMessage): void {
  const drained: Promise<void> = invalidateChatReplies(msg.chatId);
  clearChatMemoryCache(msg.chatId);
  self.postMessage({ type: "memoryDeleted", chatId: msg.chatId } satisfies AiMemoryDeletedEvent);
  void drained.then((): void => {
    self.postMessage({
      type: "chatInvalidated",
      chatId: msg.chatId,
      requestId: msg.requestId,
    } satisfies AiChatInvalidatedEvent);
  });
}

/**
 * 封闭新任务入口、停止维护定时器与天气刷新，并并行排空在途回复代际与贴纸目录任务。
 * @returns 所有在途回复代际与贴纸目录任务排空完成后的 Promise（幂等复用同一排空句柄）。
 */
function beginAiChatWorkerQuiesce(): Promise<void> {
  aiChatWorkerQuiescing.current = true;
  aiChatWorkerAbortController.current.abort(
    new DOMException("AI chat Worker is quiescing.", "AbortError")
  );
  if (aiChatMaintenanceTimer.current !== null) {
    clearInterval(aiChatMaintenanceTimer.current);
    aiChatMaintenanceTimer.current = null;
  }
  stopWeatherRefreshLoop();
  aiChatWorkerDrain.current ??= Promise.allSettled([
    quiesceAiChatReplies(),
    drainStickerCatalogTasks(),
  ]).then((settlements: PromiseSettledResult<void>[]): void => {
    const labels: readonly string[] = ["reply generation", "sticker catalog"];
    const failures: Error[] = [];
    for (let index: number = 0; index < settlements.length; index++) {
      const settlement: PromiseSettledResult<void> = settlements[index]!;
      if (settlement.status === "rejected") {
        failures.push(new Error(`AI Worker ${labels[index]} drain rejected.`, {
          cause: settlement.reason,
        }));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "AI Worker drain phases rejected.");
    }
  });
  return aiChatWorkerDrain.current;
}

/**
 * 排空所有在途任务后上报最终脏记忆与贴纸目录快照，并回执 memoryFlushed。
 *
 * @param flushId 本次停机刷盘流水号，原样写入 memoryFlushed 回执
 */
async function flushAiChatWorker(flushId: number): Promise<void> {
  await beginAiChatWorkerQuiesce();
  flushDirtyMemories();
  flushDirtyStickerCatalogs((event: AiStickerCatalogEvent): void => self.postMessage(event));
  self.postMessage({ type: "memoryFlushed", flushId } satisfies AiMemoryFlushedEvent);
}

/**
 * 路由一条主线程发往 AI 闲聊 Worker 的消息。
 *
 * @param msg 主线程下发的 AI 闲聊 Worker 消息载荷
 */
export function handleAiChatWorkerMessage(msg: AiChatWorkerMessage): void {
  switch (msg.type) {
    case "init":
      adoptTimeZone(msg.timeZone);
      if (msg.timeZone === TOKYO_TIME_ZONE) startWeatherRefreshLoop();
      adoptAgentDeploymentConfig(msg.agent);
      if (msg.agent.text.provider === "google") probeGeminiContextCache(TEXT_GEMINI_CONTEXT_CACHE_SCOPE);
      adoptMoodConfig(msg.mood);
      adoptStickerConfig(msg.stickers);
      adoptPersona(msg.persona);
      voiceToolPromptCache.current = msg.voiceToolPrompt;
      reportUnimplementedAgentCapabilities();
      botInfoState.current = msg.botInfo;
      superAdminUserIdState.current = msg.superAdminUserId;
      atmosphereState.current = msg.atmosphere;
      ensureStickerCatalogs(getStickerConfig().packs);
      break;
    case "configReload":
      applyAiChatConfigReload(msg);
      break;
    case "record": {
      if (aiChatWorkerQuiescing.current) break;
      const entry: BufferedMessage | null = recordChatMessage(msg);
      const botImage: RepliedBotImage | undefined = msg.replyTo?.botImage;
      if (entry !== null && botImage !== undefined) resolveRepliedBotImage(msg.chatId, entry, botImage);
      if (msg.persistImmediately === true) flushMemorySnapshot(msg.chatId, true);
      break;
    }
    case "recordMedia":
      if (aiChatWorkerQuiescing.current) break;
      recordChatMedia(msg);
      if (msg.persistImmediately === true) flushMemorySnapshot(msg.chatId, true);
      break;
    case "recordBotImage":
      if (aiChatWorkerQuiescing.current) break;
      recordBotImage(msg);
      if (msg.persistImmediately === true) flushMemorySnapshot(msg.chatId, true);
      break;
    case "trigger":
      if (aiChatWorkerQuiescing.current) break;
      generateAndSendReply(msg);
      break;
    case "hydrate":
      hydrateMemories(msg.memories);
      break;
    case "hydrateStickerCatalog":
      hydrateStickerCatalogs(msg.catalogs);
      break;
    case "flushMemory":
      void flushAiChatWorker(msg.flushId).catch((error: unknown): void => {
        logger.error(`AI Worker flush ${msg.flushId} rejected before acknowledgement:`, error);
      });
      break;
    case "invalidateChat":
      handleInvalidateChat(msg);
      break;
    case "queryMood":
      if (Date.now() >= msg.deadlineAt) break;
      self.postMessage({
        type: "moodQueried",
        requestId: msg.requestId,
        moodName: currentMood().name,
      } satisfies AiMoodQueriedEvent);
      break;
    case "switchMood":
      if (Date.now() >= msg.deadlineAt) break;
      self.postMessage({
        type: "moodSwitched",
        requestId: msg.requestId,
        moodName: switchMood().name,
      } satisfies AiMoodSwitchedEvent);
      break;
    case "synthesizeVoice":
      handleSynthesizeVoice(msg);
      break;
    case "cancelVoiceSynthesis":
      handleCancelVoiceSynthesis(msg);
      break;
    case "composeWebDigest":
      handleComposeWebDigest(msg);
      break;
    case "cancelWebDigest":
      handleCancelWebDigest(msg);
      break;
    case "hydrateTtsUsage":
      hydrateTtsUsage(msg.usage);
      break;
  }
}

/**
 * 周期性维护：清扫过期缓存、补跑排队触发、对账贴纸目录并上报脏记忆与脏贴纸目录快照。
 *
 * @param now 当前毫秒时间戳，默认取 `Date.now()`
 */
export function runAiChatWorkerMaintenance(now: number = Date.now()): void {
  if (aiChatWorkerQuiescing.current) return;
  sweepAiChatReplyCache(now);
  drainPendingReplyQueues(now);
  sweepImageGenerationCache(now);
  sweepGeminiReplyRequestTimes(performance.now());
  pruneStickerCatalogs(getStickerConfig().packs);
  retryIncompleteStickerCatalogs(getStickerConfig().packs, now);
  flushDirtyMemories();
  flushDirtyStickerCatalogs((event: AiStickerCatalogEvent): void => self.postMessage(event));
}

/** Worker 线程启动入口；主线程导入本模块时不得注册 handler、计时器或网络刷新。 */
export function startAiChatWorker(): void {
  if (aiChatMaintenanceTimer.current !== null) return;
  aiChatWorkerQuiescing.current = false;
  aiChatWorkerAbortController.current = new AbortController();
  aiChatWorkerDrain.current = null;
  installBusinessWorkerPort<TelegramWorkerRequest, AiChatWorkerMessage>(handleAiChatWorkerMessage);
  installAiCacheUsageSink((usage: AiCacheUsage): void => {
    self.postMessage({ type: "aiCacheUsage", usage } satisfies AiCacheUsageEvent);
  });
  aiChatMaintenanceTimer.current = setInterval(runAiChatWorkerMaintenance, AI_SNAPSHOT_INTERVAL_MS);
  aiChatMaintenanceTimer.current.unref();
  process.once("exit", stopAiChatWorker);
}

/** 协作式停止 AI Worker 的 handler、维护 timer 与天气刷新 owner。 */
export function stopAiChatWorker(): void {
  aiChatWorkerAbortController.current.abort(
    new DOMException("AI chat Worker stopped.", "AbortError")
  );
  if (aiChatMaintenanceTimer.current !== null) {
    clearInterval(aiChatMaintenanceTimer.current);
    aiChatMaintenanceTimer.current = null;
  }
  stopWeatherRefreshLoop();
  installAiCacheUsageSink(null);
  resetWorkerDuplex("AI Worker stopped before the main-thread request completed.");
  self.onmessage = null;
  process.off("exit", stopAiChatWorker);
}

if (!Bun.isMainThread) startAiChatWorker();
