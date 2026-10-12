/** owner: main。黑名单入群秒踢主线程侧代理（packages/antiRaid/blocklistGuard.ts）的内存状态。 */

import { BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES } from "../../../consts/antiRaid/blocklist";
import { FifoMap } from "../../../libs/fifoMap";

/**
 * 最近已经替哪些 `(chatId, userId)` 的入群记过反刷群计数（键 → 记账时刻）。
 *
 * 同一次物理入群会经两条路径各投一次处置：`chat_member` 更新和
 * `new_chat_members` 服务消息（见 antiRaid/updateIngress.ts 的 handleChatMemberUpdate
 * 与 handleAntiRaidMessageIngress）。处置消息里的 joinedAt 只带一次，由本表去重：
 * 普通入群由 states/verification.ts 的 joinCreatesNewRecord 去重，处置这一路由本表承担。
 *
 * 生命周期：claimBlockedJoiner 命中黑名单且本次要记账时写入；每次调用按
 * JOIN_WINDOW_MS 从最早项淘汰过期项，遇到第一个未过期项即停。写入一律先 delete 再 set，
 * 插入顺序即时间顺序；容量 BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES，满载时 FifoMap 淘汰最早一项。
 * 主线程状态，与 Worker 崩溃重建无关；进程重启后清空。
 */
export const recentBlockedJoinCounts: FifoMap<string, number> = new FifoMap(BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES);

/**
 * 已记过「已拉黑频道身份的消息因缺删消息权限删不掉」错误的群。命中后该群的同类消息
 * 不再逐条记错误；之后某条同类消息不再确证缺删消息权限（照常发删除请求）时移除，
 * 再次确证缺权限时重新记一次。群 teardown 时由 antiRaid/workerBridge/observers.ts
 * 删除；只收录已确证机器人是管理员的已接管群，上界 STATE_MANAGED_CHAT_LIMIT
 * （见 consts/storage.ts）。主线程状态，与 Worker 重建无关，进程重启后清空。
 */
export const blockedSenderChatDeleteDeniedChats: Set<number> = new Set();
