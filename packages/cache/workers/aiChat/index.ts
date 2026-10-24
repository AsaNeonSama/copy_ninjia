/** owner: workers/aiChat。AI 闲聊 Worker 按群运行时缓存失效与测试重置聚合入口。 */

import { repliedBotImageBackfills, resetAiChatBotImageCache } from "./botImages";
import { resetAiChatCompactionCache } from "./compaction";
import { geminiReplyLastRequestAt, resetGeminiContextCache } from "./geminiContextCache";
import { clearChatHeartbeatCache, resetAiChatHeartbeatCache } from "./heartbeat";
import { resetAiChatIdentityCache } from "./identity";
import { resetImageGenerationCache } from "./imageGeneration";
import { resetImageReferenceAlbumCache } from "./imageReferenceAlbums";
import { resetAiChatMemoryCache } from "./memory";
import { resetAiChatMoodCache } from "./mood";
import { resetAiProviderSchedulerCache } from "./providerScheduler";
import { invalidateChatReplyCache, resetAiChatReplyCache } from "./replies";
import { resetReplyPrefixCache } from "./replyPrefix";

/**
 * 清理指定群的回复轮、聊天动作心跳、识图回填等待与 Gemini 最近回复请求时间缓存。
 *
 * @param chatId 群聊 ID
 */
export function invalidateChatRuntimeCache(chatId: number): void {
  invalidateChatReplyCache(chatId);
  clearChatHeartbeatCache(chatId);
  repliedBotImageBackfills.delete(chatId);
  geminiReplyLastRequestAt.delete(chatId);
}

/** 重置本模块聚合的 AI 闲聊 Worker 各子领域缓存（测试隔离用）。 */
export function resetAiChatWorkerCache(): void {
  resetAiChatHeartbeatCache();
  resetAiChatBotImageCache();
  resetAiChatCompactionCache();
  resetGeminiContextCache();
  resetAiChatIdentityCache();
  resetImageGenerationCache();
  resetImageReferenceAlbumCache();
  resetAiChatMemoryCache();
  resetAiChatMoodCache();
  resetAiProviderSchedulerCache();
  resetAiChatReplyCache();
  resetReplyPrefixCache();
}
