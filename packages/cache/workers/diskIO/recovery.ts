/** owner: workers/diskIO。主线程恢复重放窗口与串行操作队列状态（packages/workers/diskIOWorker.ts）。 */

/**
 * 当前是否处于主线程恢复缓冲重放窗口的标记：收到 active 为 true 的 recoveryReplay 消息时置为 true，收到 active 为 false 时置为 false；单例布尔值，不设超时淘汰，Worker 重建后从 false 开始。
 */
export const diskIOReplayWindow: { current: boolean } = { current: false };

/** Disk I/O Worker 串行异步操作链尾节点：新操作入队时替换为最新未结算 Promise，结算后不保留历史节点；单例 Promise，Worker 重建后恢复为已结算初始值。 */
export const diskIOOperationTail: { current: Promise<void> } = {
  current: Promise.resolve(),
};

/** Disk I/O Worker 在途与排队操作计数：入队时递增、结算时递减，上限为 DISK_WORKER_MAX_QUEUED_OPERATIONS；单例标量，Worker 重建后从零开始。 */
export const diskIOOperationCount: { current: number } = { current: 0 };
