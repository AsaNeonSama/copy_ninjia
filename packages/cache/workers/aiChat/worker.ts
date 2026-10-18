/** owner: workers/aiChat。AI Worker 生命周期与后台维护句柄。 */

/**
 * AI Worker 周期维护 interval 句柄。
 * 填充：Worker 启动时写入；清理：协作式停止时清除；重建：Worker 崩溃重启后从 null 重建；容量：固定为单个 timer。
 */
export const aiChatMaintenanceTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };

/**
 * Worker 是否处于排空拒绝新回复任务的阶段。
 * 填充：收到首条 flushMemory 时置为 true；清理与重建：Worker 启动或重启时置为 false；容量：固定为单个布尔 holder。
 */
export const aiChatWorkerQuiescing: { current: boolean } = { current: false };

/**
 * Worker 排空阶段唯一的结算 Promise。
 * 填充：首条 flushMemory 触发排空时写入，后续 flush 复用；清理与重建：Worker 重启或显式重置时置空；容量：固定为单个 Promise holder。
 */
export const aiChatWorkerDrain: { current: Promise<void> | null } = { current: null };

/**
 * AI Worker 后台任务的统一生命周期取消控制器。
 * 填充：Worker 启动时替换为新实例；清理：进入排空或显式停止时 abort；重建：Worker 崩溃重启后重新创建；容量：固定为单个 controller。
 */
export const aiChatWorkerAbortController: { current: AbortController } = {
  current: new AbortController(),
};
