/** owner: main。批量踢人命令（packages/commands/batchKick.ts 与 packages/mini-app-api-server/）的内存状态。 */

import type { MiniAppBatchKickCompletion } from "../../types/miniApp/chats";

/**
 * 正在执行 `/batch_kick` 批次的群集合，同群同一时刻只允许一批（命令与 Mini App API 共享单飞锁）。
 *
 * 填充：提交延迟命令执行器前加入。清理：提交被拒、排队期间被 onSkipped 撤销，或批次任务
 * finally 结算时移除（群 teardown 期间在途批次在感知不再受管后经 finally 自行移除）。
 * 容量上界为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；Worker 重建无关，进程重启后从空集开始。
 */
export const batchKickChats: Set<number> = new Set();

/**
 * 各群最近一次由 Mini App API（`source: "api"`）触发并执行完毕的 `/batch_kick` 完成回调状态。
 *
 * 填充：仅当 `source === "api"` 的批次任务在 `deliverBatchKick` 结算且在途批次序号未被群 teardown 作废时通过完成回调写入。
 * 清理：同群再次通过 API 发起新批次后、完成回调判定本群已不受管或未开启 `/init` 时、以及删数据类群
 * teardown（`purgesChatData`）时移除；进程重启后从空表开始。
 * 容量上界为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；Worker 重建无关。
 */
export const miniAppBatchKickCompletedByChat: Map<
  number,
  Readonly<MiniAppBatchKickCompletion>
> = new Map<number, Readonly<MiniAppBatchKickCompletion>>();

/**
 * 各群当前处于异步预检阶段（查询群类型、读取入群日志）的 `/batch_kick` 发起序号集合。
 *
 * 填充：已开启 `/init` 的群在 `commands/batchKick.ts` 或 `view/chats/batchKick.ts` 发起异步预检前
 * 分配单调序号并加入。清理：预检 `finally` 结算时移除本批序号（集合空时删除群键），或删数据类群
 * teardown（`purgesChatData`）时整群移除以作废在途预检。容量上界为 STATE_MANAGED_CHAT_LIMIT，
 * 不设淘汰；Worker 重建无关，进程重启后从空表开始。
 */
export const batchKickPreflightSeqsByChat: Map<number, Set<number>> = new Map<
  number,
  Set<number>
>();

/**
 * 各群当前已受理在途的 `/batch_kick` 批次序号（`chatId` 到本批发起序号，命令与 Mini App API 共用）。
 *
 * 填充：`startBatchKickTask` 登记单飞锁时分配单调递增序号并写入。
 * 清理：`startBatchKickTask` 未受理或排队期被 `onSkipped` 撤销且登记值仍为本批序号时移除；
 * `deliverBatchKick` `finally` 结算时若登记值仍为本批序号则移除；删数据类群 teardown（`purgesChatData`）
 * 时移除以作废跨 `/init` 生命周期的旧批次。同群单飞（`batchKickChats`），容量上界为 STATE_MANAGED_CHAT_LIMIT，
 * 不设淘汰；Worker 重建无关，进程重启后从空表开始。
 */
export const batchKickInFlightSeqByChat: Map<number, number> = new Map<number, number>();

/** `/batch_kick` 预检与在途批次共用的单调递增发起序号发号器：每次预检或提交批次前递增分配，群 teardown 与 Worker 重建均不重置，进程重启后从零开始；单例标量。 */
export const batchKickSequence: { current: number } = { current: 0 };
