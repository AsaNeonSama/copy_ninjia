/** owner: workers/aiChat。回复轮系统提示词与 OpenAI 稳定前缀指纹的内容等值单槽。 */

import type { PrefixHasherSlot } from "../../../types/prefixFingerprint";
import type { ReplySystemPromptSlot } from "../../../types/aiChat/replies";

/**
 * 上一次拼好的回复系统提示词及其三项输入（人设、行动与停止段、是否挂本地 web_search）。
 *
 * 填充：workers/aiChat/replyModel.ts 的 buildReplySystemPrompt 每轮开头读取；三项输入都相等时
 * 复用 prompt（同一字符串对象，下游指纹单槽因此按引用命中），否则重拼并整槽替换。
 * 清理：只随替换释放旧值。人设热替换或台词语言快照变化时输入不等，下一轮自然重建。
 * Worker 崩溃重建：从 null 起步。容量固定为一份。
 */
export const replySystemPromptSlot: { current: ReplySystemPromptSlot | null } = { current: null };

/**
 * OpenAI 回复 `prompt_cache_key` 指纹的前缀哈希状态：head 为系统提示词与工具声明 JSON
 * （aiChat/openai/replySession.ts）。读写见 libs/prefixFingerprint.ts 的
 * stablePrefixFingerprintWithSlot：两段都与上次相等时只 copy 哈希状态再喂参考记忆，否则重建。
 * 清理：只随替换释放旧值。Worker 崩溃重建：从 null 起步。容量固定为一份。
 */
export const openAiReplyPrefixSlot: { current: PrefixHasherSlot | null } = { current: null };

/** 测试隔离时清空两个单槽。 */
export function resetReplyPrefixCache(): void {
  replySystemPromptSlot.current = null;
  openAiReplyPrefixSlot.current = null;
}
