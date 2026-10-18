/** owner: workers/antiRaid。入群守卫 Worker 周期清扫 timer 句柄。 */

/**
 * Anti-Raid Worker 统一的周期缓存清扫 interval 句柄。
 * 填充：Worker 启动时创建写入；清理：协作式停止时清除；重建：Worker 崩溃重启后从 null 重新创建；容量：固定为单个 timer。
 */
export const antiRaidCacheSweepTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };
