/** owner: main。批量踢人命令（packages/commands/batchKick.ts）的内存状态。 */

/**
 * 正在执行 `/batch_kick` 批次的群集合，同群同一时刻只允许一批。
 *
 * 填充：提交延迟命令执行器前加入。清理：提交被拒、排队期间被 onSkipped 撤销，或批次任务
 * finally 结算时移除。容量上界为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；Worker 重建不影响，
 * 进程重启后从空集开始。
 */
export const batchKickChats: Set<number> = new Set();
