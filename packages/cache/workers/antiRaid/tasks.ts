/** owner: workers/antiRaid。异步副作用排空追踪与停机取消信号（packages/workers/antiRaid/taskTracker.ts）。 */

/**
 * 已启动且尚未结算的网络副作用 Promise 集合。
 * 填充：trackAntiRaidTask 启动任务时登记；清理：任务结算时移除，Worker 停止时清空；重建：Worker 崩溃重启后从空集合开始，由主线程持久化镜像重新投递；容量：受各路入口并发上限约束。
 */
export const antiRaidInFlightTasks: Set<Promise<unknown>> = new Set();

/**
 * 任务追踪器生命周期代际号，Worker 停止时递增以忽略旧代际任务的迟到结算。
 * 重建：Worker 重启后从零开始；容量：固定为单个数值 holder。
 */
export const antiRaidTaskTrackerGeneration: { current: number } = { current: 0 };

/**
 * Worker 停机排空时的取消控制器，供可能受限流退避阻塞的尽力而为请求（如刷屏禁言，超时见 FLOOD_MUTE_DISPATCH_TIMEOUT_MS）订阅。
 * 填充：首次调用 antiRaidDispatchSignal 时懒创建；清理：quiesceAntiRaidDispatch 就地 abort，resetAntiRaidTaskTracker 置空；重建：Worker 重启后从 null 开始；容量：固定为单个控制器 holder。
 */
export const antiRaidDispatchAbort: { current: AbortController | null } = { current: null };

/** 获取尽力而为请求共用的停机取消信号；控制器未创建时懒初始化。 */
export function antiRaidDispatchSignal(): AbortSignal {
  antiRaidDispatchAbort.current ??= new AbortController();
  return antiRaidDispatchAbort.current.signal;
}
