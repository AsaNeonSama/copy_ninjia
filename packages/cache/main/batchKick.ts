/** owner: main。批量踢人命令（packages/commands/batchKick.ts 与 packages/mini-app-api-server/）的内存状态。 */

import type { MiniAppBatchKickCompletion } from "../../types/miniApp";

/**
 * 正在执行 `/batch_kick` 批次的群集合，同群同一时刻只允许一批（命令与 Mini App API 共享单飞锁）。
 *
 * 填充：提交延迟命令执行器前加入。清理：提交被拒、排队期间被 onSkipped 撤销，或批次任务
 * finally 结算时移除。容量上界为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；Worker 重建不影响，
 * 进程重启后从空集开始。
 */
export const batchKickChats: Set<number> = new Set();

/**
 * 各群最近一次由 Mini App API（`source: "api"`）触发并执行完毕的 `/batch_kick` 完成回调状态。
 *
 * 填充：仅当 `source === "api"` 的批次任务在 `deliverBatchKick` 结算后通过完成回调写入。
 * 清理：同群再次通过 API 发起新批次前、群关闭 `/init` 时移除；进程重启后从空表开始。
 * 容量上界为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；Worker 重建不影响。
 */
export const miniAppBatchKickCompletedByChat: Map<
  number,
  Readonly<MiniAppBatchKickCompletion>
> = new Map<number, Readonly<MiniAppBatchKickCompletion>>();
