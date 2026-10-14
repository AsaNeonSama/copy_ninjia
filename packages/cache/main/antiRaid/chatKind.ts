/** owner: main。群类型观测（packages/antiRaid/chatKind.ts）的主线程内存状态。 */

/**
 * 已接管群是否为超级群的主线程权威缓存（入群守卫线程镜像见 cache/workers/antiRaid/chatKind.ts）。
 *
 * 填充：observeChatKind 从 update 的 `chat.type` 写入，并在值变化时向 Anti-Raid Worker 增量推送
 * `chatKind` 消息。重放方：Anti-Raid Worker 重建时由 antiRaid/workerBridge/replay.ts 全量重放。
 * 清理：群 teardown 时由 antiRaid/workerBridge/observers.ts 按群删除；进程重启后从空表开始。
 * 无条目表示尚未观测到该群类型，不沿用旧值。容量上限为 STATE_MANAGED_CHAT_LIMIT，不设淘汰。
 */
export const chatIsSupergroupById: Map<number, boolean> = new Map();
