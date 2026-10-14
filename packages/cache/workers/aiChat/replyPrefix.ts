/** owner: workers/aiChat。回复系统提示词与 OpenAI 前缀指纹单槽缓存。 */

import type { PrefixHasherSlot } from "../../../types/prefixFingerprint";
import type { ReplySystemPromptSlot } from "../../../types/aiChat/replies";

/**
 * 最近一次拼接的回复系统提示词及其输入快照。
 * 填充：workers/aiChat/replyModel.ts 的 buildReplySystemPrompt 在输入变化时重拼并整槽覆盖，输入一致时直接复用。
 * 清理：新值覆盖或 resetReplyPrefixCache 置空。
 * 重建：Worker 崩溃重启后从 null 开始。
 * 容量：固定为单个槽位。
 */
export const replySystemPromptSlot: { current: ReplySystemPromptSlot | null } = { current: null };

/**
 * OpenAI 回复 prompt_cache_key 的前缀哈希状态单槽（aiChat/openai/replySession.ts）。
 * 填充：libs/prefixFingerprint.ts 的 stablePrefixFingerprintWithSlot 在前缀变化时重建并覆盖，一致时克隆状态继续计算。
 * 清理：新值覆盖或 resetReplyPrefixCache 置空。
 * 重建：Worker 崩溃重启后从 null 开始。
 * 容量：固定为单个槽位。
 */
export const openAiReplyPrefixSlot: { current: PrefixHasherSlot | null } = { current: null };

/** 清空系统提示词与前缀指纹单槽。 */
export function resetReplyPrefixCache(): void {
  replySystemPromptSlot.current = null;
  openAiReplyPrefixSlot.current = null;
}
