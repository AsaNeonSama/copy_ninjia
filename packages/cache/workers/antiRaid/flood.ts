/** owner: workers/antiRaid。防刷屏发言滑窗缓存（packages/workers/antiRaid/floodControl.ts）。 */

import type {
  FloodWindowCacheState,
  FloodWindowEntry,
} from "../../../types/antiRaid/internal";

/**
 * chatId -> (userId -> 发言滑窗条目)。
 * 填充：收到主线程 floodCandidate 消息时写入或更新，并维护侵入式双向 LRU 链表。
 * 清理：触发禁言后清空队列，空闲超期由 sweepFloodWindows 淘汰，群停管（deactivateChat）按群删除，reset 时清空。
 * 重建：Worker 崩溃重启后从空表重新计数。
 * 容量：全局条目数上限为 FLOOD_WINDOW_MAX_MEMBERS（consts/antiRaid/flood.ts），满载时按 LRU 淘汰最久未发言条目；单条队列长度受群刷屏阈值封顶。
 */
export const floodWindowsByChat: Map<number, Map<number, FloodWindowEntry>> = new Map();

/**
 * 防刷屏滑窗的全局条目计数与双向 LRU 链表头尾指针。
 * 填充与清理：随 floodWindowsByChat 的增删、淘汰、sweep 与 reset 同步更新；重建：Worker 重启后恢复为空链表与零计数；容量：固定为单个状态对象，entryCount 上限为 FLOOD_WINDOW_MAX_MEMBERS。
 */
export const floodWindowCacheStateHolder: { current: FloodWindowCacheState } = {
  current: { entryCount: 0, newest: null, oldest: null },
};
