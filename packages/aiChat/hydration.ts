/**
 * AI Worker 的记忆与贴纸目录状态灌入及热重载恢复。
 * @see ../../docs/cn/04-invariants.md
 */

import { isAiChatConfigured } from "./availability";
import { requestAiMemoryDelete } from "./memoryMirror";
import { postAiChatOrThrow, startAiChatWorker, syncAiChatConfig } from "./workerBridge";
import { activeStickerCatalogs } from "./stickerMirror";
import {
  aiChatBotInfo,
  aiMemoryRevisionCounters,
  lastInitState,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
} from "../cache/main/aiChat";
import { logger } from "../infra/logger";
import { getChatState } from "../infra/storage/stateStore";
import type { AiBotInfo } from "../types/aiChat/protocol";

/**
 * 将主线程镜像中的 AI 记忆投递给已启动的 Worker；未开启 AI 闲聊的群安排持久化删除。
 */
function postMirroredAiMemories(): void {
  const enabledMemories: Map<number, string> = new Map();
  const dropped: number[] = [];
  for (const [chatId, snapshot] of latestAiMemories) {
    if (getChatState(chatId).isAIChatEnabled === true) enabledMemories.set(chatId, snapshot);
    else dropped.push(chatId);
  }
  for (const chatId of dropped) requestAiMemoryDelete(chatId, false);
  if (dropped.length > 0) {
    logger.log(`Dropping the persisted AI memory of ${dropped.length} chat(s) with AI chat disabled: ${dropped.join(", ")}.`);
  }
  if (enabledMemories.size > 0) {
    postAiChatOrThrow({ type: "hydrate", memories: enabledMemories });
  }
}

/** 将主线程镜像中当前生效的贴纸目录投递给已启动的 Worker。 */
function postMirroredStickerCatalogs(): void {
  if (latestStickerCatalogs.size > 0) {
    postAiChatOrThrow({ type: "hydrateStickerCatalog", catalogs: activeStickerCatalogs() });
  }
}

/**
 * 启动时将恢复出的 AI 记忆快照写入主线程镜像，并在 AI 配置就绪时投递给 Worker。
 * @param memories 按群聊 ID 索引的记忆快照 JSON 映射。
 */
export function hydrateAiMemory(memories: Map<number, string>): void {
  for (const [chatId, snapshot] of memories) {
    latestAiMemories.set(chatId, snapshot);
    latestAiMemoryRevisions.set(chatId, 0);
    aiMemoryRevisionCounters.set(chatId, 0);
  }
  if (isAiChatConfigured()) postMirroredAiMemories();
}

/**
 * 启动时将恢复出的贴纸目录写入主线程镜像，并在 AI 配置就绪时投递给 Worker。
 * @param catalogs 按贴纸包名称索引的目录快照 JSON 映射。
 */
export function hydrateStickerCatalog(catalogs: Map<string, string>): void {
  for (const [pack, snapshot] of catalogs) {
    latestStickerCatalogs.set(pack, snapshot);
  }
  if (isAiChatConfigured()) postMirroredStickerCatalogs();
}

/**
 * 热重载使 AI 配置从不可用变为可用时恢复 Worker：已在运行时同步配置快照，从未启动时启动 Worker 并灌入记忆与贴纸目录镜像。
 */
export function resumeAiChat(): void {
  if (lastInitState.current !== null) {
    syncAiChatConfig({ aiAgent: true, mood: true, stickers: true });
    return;
  }
  const botInfo: AiBotInfo | null = aiChatBotInfo.current;
  if (botInfo === null) {
    throw new Error("AI chat cannot start before initAiChat recorded the bot identity.");
  }
  startAiChatWorker(botInfo);
  postMirroredAiMemories();
  postMirroredStickerCatalogs();
}
