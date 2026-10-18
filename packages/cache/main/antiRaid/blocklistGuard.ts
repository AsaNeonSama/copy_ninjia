/** owner: main。黑名单入群秒踢主线程代理（packages/antiRaid/blocklistGuard.ts）的内存状态。 */

import { BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES } from "../../../consts/antiRaid/blocklist";
import { FifoMap } from "../../../libs/fifoMap";

/**
 * 已记入反刷群滑窗的黑名单入群去重表（`chatId:userId` -> 记账时刻）。
 *
 * 填充：claimBlockedJoiner 命中黑名单且本次需记入反刷群滑窗时先删后写。
 * 清理：每次调用按 JOIN_WINDOW_MS 从队首淘汰过期项；容量上限为 BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES，
 * 满载时由 FifoMap 淘汰最早插入项。主线程独占，Worker 重建不影响，进程重启后从空表开始。
 */
export const recentBlockedJoinCounts: FifoMap<string, number> = new FifoMap(BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES);

/**
 * 已记录「已拉黑频道身份消息因缺删消息权限无法删除」错误的群集合。
 *
 * 填充：deleteBlockedSenderChatMessage 确证缺删消息权限并首次记录错误时加入。
 * 清理：后续同类消息不再确证缺删消息权限时移除，群 teardown 时由 antiRaid/workerBridge/observers.ts 删除。
 * 容量上界为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；Worker 重建不影响，进程重启后从空集开始。
 */
export const blockedSenderChatDeleteDeniedChats: Set<number> = new Set();
