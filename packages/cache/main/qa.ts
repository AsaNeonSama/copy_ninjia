/** owner: main。群问答热缓存、未确认落盘写入表与 `/qa set` 表单会话（packages/infra/qaStore.ts、packages/commands/qa/）。 */

import type { QaFormSession, UnacknowledgedChatQaWrite } from "../../types/qa";

/**
 * 群 ID 到问答映射（问题原文 -> 答案）的权威缓存：
 * - 填充：启动时由 Disk I/O Worker hydrate 灌入，运行期由 infra/qaStore.ts（`/qa set`）写入；
 * - 清理：`/qa remove` 删除单条，清除群数据的 teardown 删除整群；
 * - 容量：群数上限为 STATE_MANAGED_CHAT_LIMIT，每群上限为 CHAT_QA_MAX_PER_CHAT，不淘汰；进程重启后从 SQLite 重建。
 */
export const chatQaEntries: Map<number, Map<string, string>> = new Map();

/**
 * 群 ID 到该群问答列表 JSON 字符串的派生缓存：首次构造 AI trigger 载荷时由 aiChat/messageIngress.ts 生成并写入，infra/qaStore.ts 修改或清空对应群问答时删除该群缓存。
 * 容量与 chatQaEntries 的群数同阶，不淘汰；进程重启后从空表开始。
 */
export const chatQaTriggerJson: Map<number, string> = new Map();

/**
 * 群 ID 到 `/qa set` 未完成表单会话的映射（每群至多一个）：`/qa set` 创建或由同一发起人重开覆盖，两项填齐结算、TTL 到期或群 teardown 时清除。
 * 容量上限为 QA_FORM_SESSION_MAX（等于 STATE_MANAGED_CHAT_LIMIT），满额拒绝新建且不淘汰现有会话；进程重启后从空表开始。
 */
export const qaFormSessions: Map<number, QaFormSession> = new Map();

/**
 * 群问答未确认落盘写入表（chatId -> question -> 最新写入状态）：写入或删除时登记，收到匹配 revision 的 durable ACK 时移除，Disk I/O Worker 重建时全表重放。
 * 容量受 STORAGE_PENDING_MAX_ENTRIES 与 STORAGE_PENDING_MAX_BYTES 约束，超限拒绝新写入且不淘汰未确认条目；进程重启后从空表开始。
 */
export const unacknowledgedChatQaWrites: Map<number, Map<string, UnacknowledgedChatQaWrite>> = new Map();

/** 群问答未确认写入的总条数与估算字节总数：登记或覆盖写入时按差额更新，收到精确 ACK 时扣减，hydrate 或 resetChatQaCache 时清零。 */
export const unacknowledgedChatQaTotals: { entries: number; bytes: number } = { entries: 0, bytes: 0 };

/** 群问答写入的单调递增 revision 发号器：每次写入自增，进程重启或 resetChatQaCache 时重置为初始值。 */
export const nextChatQaRevision: { current: number } = { current: 1 };

/** 清空群问答进程内缓存、表单会话定时器与未确认写入状态（测试隔离用）。 */
export function resetChatQaCache(): void {
  chatQaEntries.clear();
  chatQaTriggerJson.clear();
  for (const session of qaFormSessions.values()) {
    if (session.timer !== null) clearTimeout(session.timer);
  }
  qaFormSessions.clear();
  unacknowledgedChatQaWrites.clear();
  unacknowledgedChatQaTotals.entries = 0;
  unacknowledgedChatQaTotals.bytes = 0;
  nextChatQaRevision.current = 1;
}
