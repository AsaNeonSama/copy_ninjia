/** owner: workers/aiChat。聊天状态心跳（typing 等动作）状态（packages/aiChat/ai/chatActionHeartbeat.ts）。 */

import type { ChatActionHeartbeatEntry } from "../../../types/aiChat/chatAction";

/**
 * 群 ID 到共享聊天动作心跳条目的映射：同群在途回复轮创建并按引用计数复用，引用归零、群失效或 AI 禁用时由 clearChatHeartbeatCache 清除定时器并删除。
 * 容量与同时存在在途回复轮的受管群数同阶，不设淘汰；Worker 重建后从空表开始。
 */
export const typingHeartbeats: Map<number, ChatActionHeartbeatEntry> = new Map();

/** 停止指定群的聊天动作心跳定时器并移除条目。 */
export function clearChatHeartbeatCache(chatId: number): void {
  const entry: ChatActionHeartbeatEntry | undefined = typingHeartbeats.get(chatId);
  if (!entry) return;
  clearInterval(entry.timer);
  clearTimeout(entry.restTimer ?? undefined);
  entry.owner = null;
  entry.action = "idle";
  typingHeartbeats.delete(chatId);
}

/** 停止全部群的聊天动作心跳定时器并清空映射。 */
export function resetAiChatHeartbeatCache(): void {
  for (const chatId of [...typingHeartbeats.keys()]) clearChatHeartbeatCache(chatId);
}
