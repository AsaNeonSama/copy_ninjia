/** owner: workers/diskIO。AI 缓存用量统计文件追加状态（packages/workers/diskIO/aiCacheFile.ts）。 */

import type { AppendOnlyFileState } from "../../../types/diskIO/storage";

/** 统计文件追加游标单例：启动恢复 adopt 或每日汇总重写后填充，追加失败时置为 null 并在退避到期后重新探测，Worker 重建或 resetAiCacheState 时恢复为 null。 */
export const aiCacheFileState: { current: AppendOnlyFileState | null } = { current: null };

/** 追加失败后允许重新探测统计文件的最早时间戳（初始零值表示无待退避失败）：追加失败时设置，重开成功或 resetAiCacheState 时归零；单例标量。 */
export const aiCacheReopenState: { retryAt: number } = { retryAt: 0 };

/** 待追加的已序列化用量记录批次与定时刷盘 timer：满 FLUSH_MAX_ENTRIES 条、FLUSH_INTERVAL_MS 到期、统一 flush 或每日汇总前整批取走（写失败直接丢弃）；容量上限为 FLUSH_MAX_ENTRIES，Worker 重建或 resetAiCacheState 时清空。 */
export const aiCacheBuffer: { texts: string[]; timer: ReturnType<typeof setTimeout> | null } = {
  texts: [],
  timer: null,
};

/** 取消定时刷盘 timer 并重置 AI 缓存用量文件游标、退避时间戳与待刷缓冲。 */
export function resetAiCacheState(): void {
  if (aiCacheBuffer.timer !== null) clearTimeout(aiCacheBuffer.timer);
  aiCacheBuffer.texts = [];
  aiCacheBuffer.timer = null;
  aiCacheFileState.current = null;
  aiCacheReopenState.retryAt = 0;
}
