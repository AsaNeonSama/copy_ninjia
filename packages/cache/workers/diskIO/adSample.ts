/** owner: workers/diskIO。广告命中样本文件追加状态（packages/workers/diskIO/adSampleFile.ts）。 */

import type { AppendOnlyFileState } from "../../../types/diskIO/storage";

/** 待追加的已序列化广告样本批次与定时刷盘 timer：handleAdSampleMessage 写入，满 FLUSH_MAX_ENTRIES 条、FLUSH_INTERVAL_MS 到期或统一 flush 时整批取走（写失败直接丢弃）；容量上限为 FLUSH_MAX_ENTRIES，Worker 重建后从空缓冲开始。 */
export const adSampleBuffer: { chunks: string[]; timer: ReturnType<typeof setTimeout> | null } = {
  chunks: [],
  timer: null,
};

/** 广告样本文件追加游标单例：打开或写入成功时填充，追加失败时置为 null 并在下次写入前重新探测；Worker 重建后从 null 开始。 */
export const adSampleFileState: { current: AppendOnlyFileState | null } = { current: null };

/** 本 Worker isolate 是否已清扫过 memory/ad-detected/ 孤儿临时文件的标记：首次维护或写入清扫后置为 true，Worker 重建后恢复为 false；单例布尔值。 */
export const adSampleTempsSwept: { current: boolean } = { current: false };

/** 最近一次完成或尝试归档保留期清扫的配置时区自然日：清扫后更新，仅当日期前进时再次扫描，Worker 重建后恢复为 null；单例字符串。 */
export const adSampleArchiveSweepDay: { current: string | null } = { current: null };

/** 每日广告样本归档文件命名的候选序号游标。 */
interface AdSampleArchiveCursor {
  /** 当前游标所属的配置时区自然日。 */
  readonly day: string;
  /** 下一个待探测归档文件名的正整数序号（首个候选对应无序号归档文件）。 */
  readonly nextIndex: number;
}

/** 广告样本归档候选序号游标单例：每日目录扫描完成后填入最小空缺序号并在每次选名后递增，跨日整体替换，Worker 重建后恢复为 null。 */
export const adSampleArchiveCursor: {
  current: AdSampleArchiveCursor | null;
} = { current: null };
