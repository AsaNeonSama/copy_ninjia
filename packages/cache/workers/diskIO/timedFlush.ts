/** owner: workers/diskIO。定时刷盘任务合并队列状态（packages/workers/diskIO/timedFlush.ts）。 */

import type { TimedDiskIOOperation } from "../../../types/diskIO/storage";

/** 已到期等待合并执行的定时刷盘回调集合：各领域定时 timer 到期时加入，合并执行时按序取出并移除；容量上限为固定定时来源种类数，不淘汰，Worker 重建后从空集开始。 */
export const dueTimedDiskIOOperations: Set<TimedDiskIOOperation> = new Set();

/** 定时刷盘合并任务是否已排入 diskIOOperationTail 串行队列的标记：排入时置为 true，执行完毕时置为 false；单例布尔值，Worker 重建后从 false 开始。 */
export const timedDiskIOOperationState: { queued: boolean } = { queued: false };
