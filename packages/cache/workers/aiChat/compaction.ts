/** owner: workers/aiChat。中期记忆压缩按群串行调度状态（packages/workers/aiChat/compaction.ts）。 */

import { createKeyedSerialTaskRunner } from "../../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../../libs/keyedSerialTaskRunner";

/** 群 ID 到中期记忆压缩串行任务链尾的映射：任务入队时写入，链排空时由执行器自动删除，resetAiChatCompactionCache 时清空；容量上限为 AI_MEMORY_MAX_CHATS，不设淘汰，Worker 重建后从空表开始。 */
export const compactionChains: Map<number, Promise<void>> = new Map();
/** 绑定 compactionChains 的中期记忆压缩按群串行调度器单例。 */
export const compactionRunner: KeyedSerialTaskRunner<number> =
  createKeyedSerialTaskRunner(compactionChains);
/** 群 ID 到在途与排队压缩任务数的映射：入队时递增，结算时递减并在归零时删除；容量与清理同 compactionChains，Worker 重建后从空表开始。 */
export const compactionPendingCounts: Map<number, number> = new Map();

/** 清空全部群的压缩任务链与待处理计数。 */
export function resetAiChatCompactionCache(): void {
  compactionChains.clear();
  compactionPendingCounts.clear();
}
