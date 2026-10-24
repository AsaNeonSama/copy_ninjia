import { isNotNull } from "drizzle-orm";
import { chatStates } from "../schema/chatState";
import { jsonbTextProjection } from "../schema/jsonb";
import { assertTelegramChatId } from "../codec/chatState";
import { parseAiMemorySnapshot } from "../../libs/persistedSnapshotCodec";
import type { StorageDatabase } from "../../types/storageDatabase";
import type { AiMemorySnapshot } from "../../types/aiChat/memory";

/**
 * 单群 AI 上下文列的安全来源路径，不包含行内容。
 * @param source 数据库来源路径标识。
 * @param chatId 群会话 ID。
 * @returns 指向该群 `ai_context` 列的诊断来源路径。
 */
export function aiContextSource(source: string, chatId: number): string {
  return `${source}:chat_states[${chatId}].ai_context`;
}

/**
 * 同一启动只读连接严格恢复 JSONB 上下文；SQL NULL 表示从未保存或已清除。
 * @param database 共享存储数据库连接。
 * @param source 数据库来源路径标识，用于构造致命错误诊断。
 * @returns 按群会话 ID 索引并归一化后的 AI 记忆快照 JSON 文本映射。
 */
export function readStoredAiContexts(database: StorageDatabase, source: string): ReadonlyMap<number, string> {
  const snapshots: Map<number, string> = new Map();
  const rows: readonly Readonly<{ chatId: number; context: string }>[] = database
    .select({ chatId: chatStates.chatId, context: jsonbTextProjection(chatStates.aiContext) })
    .from(chatStates).where(isNotNull(chatStates.aiContext)).all();
  for (const row of rows) {
    const path: string = aiContextSource(source, row.chatId);
    assertTelegramChatId(row.chatId, path);
    const snapshot: AiMemorySnapshot = parseAiMemorySnapshot(row.context, path);
    snapshots.set(row.chatId, JSON.stringify(snapshot));
  }
  return snapshots;
}
