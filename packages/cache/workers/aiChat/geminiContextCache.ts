/** owner: workers/aiChat。Gemini 回复显式上下文缓存登记表与各群最近请求时间（packages/infra/geminiContextCache.ts、packages/aiChat/gemini/replySession.ts）。 */

import { GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS } from "../../../consts/aiChat/gemini";
import type {
  GeminiContextCacheRegistry,
  GeminiReplyCacheContentSlot,
} from "../../../types/geminiContextCache";

/**
 * text 能力的 Gemini 显式上下文缓存登记表（GeminiContextCacheRegistry）单例：
 * - 填充：provider 启动、切换或首次使用显式缓存时创建并探测模型显式缓存支持度（支持则扫描接管服务端同 displayName 条目，不支持则标为 `"unsupported"`），后台创建成功时写入槽位，命中刷新 lastUsedAt，续期更新 expireAt；
 * - 清理与淘汰：同槽内容变化或新建后清理未使用的旧服务端条目，槽数超 GEMINI_TEXT_CACHE_MAX_SLOTS 时淘汰最久未用槽位，缓存不可用（冷却 GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS）或续期目标不存在时移除本地登记，agent.text 热重载变化或 resetGeminiContextCache 时置为 null（切换后仍为 Google 时立即重建探测）；
 * - 重建：Worker 重建后从 null 开始，随 init 或首次请求重新探测与扫描接管。
 */
export const textGeminiContextCache: { current: GeminiContextCacheRegistry | null } = { current: null };

/**
 * 群 ID 到该群最近一次成功发起 Gemini 回复请求时刻（performance.now() 毫秒）的映射：
 * - 填充：回复请求成功时写入较大时刻（供 replySession.ts 按 GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS 判定首轮请求是否使用显式缓存）；
 * - 清理与容量：invalidateChatRuntimeCache 按群删除，sweepGeminiReplyRequestTimes 定期清理超 GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS 的过期项，resetGeminiContextCache 清空；容量与窗口内活跃群数同阶，Worker 重建后从空表开始。
 */
export const geminiReplyLastRequestAt: Map<number, number> = new Map();

/**
 * 清理距今已超过 GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS 的群回复请求时间记录。
 *
 * @param now 当前单调时钟毫秒数（`performance.now()`）
 */
export function sweepGeminiReplyRequestTimes(now: number): void {
  for (const [chatId, at] of geminiReplyLastRequestAt) {
    if (now - at > GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS) geminiReplyLastRequestAt.delete(chatId);
  }
}

/** Gemini 回复共用显式缓存输入内容与指纹单槽：replySession.ts 在 acquireGeminiContextCache 需要内容（扫描状态为 running 或 done）且模型、系统指令、工具声明 JSON 或 toolConfig 变化时重算并整体替换，resetGeminiContextCache 时置为 null；单例对象，Worker 重建后从 null 开始。 */
export const textGeminiReplyCacheContent: { current: GeminiReplyCacheContentSlot | null } = { current: null };

/** 清空本地 Gemini 显式缓存登记表、各群最近请求时间与缓存内容单槽。 */
export function resetGeminiContextCache(): void {
  textGeminiContextCache.current = null;
  geminiReplyLastRequestAt.clear();
  textGeminiReplyCacheContent.current = null;
}
