/** owner: workers/aiChat。媒体下载、转码与视觉解析共用有界执行器状态（packages/aiChat/ai/imageDescription.ts、packages/aiChat/ai/tools/replyToolset/imageGeneration.ts）。 */

import {
  MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  MEDIA_DESCRIPTION_MAX_PENDING,
} from "../../../consts/aiChat/media";
import { createPrioritizedBoundedTaskRunner } from "../../../libs/prioritizedBoundedTaskRunner";
import type { PrioritizedBoundedTaskRunner, TaskPriority } from "../../../libs/prioritizedBoundedTaskRunner";

/** 媒体下载、转码与视觉解析底层有界任务执行器实例。 */
const executor: PrioritizedBoundedTaskRunner = createPrioritizedBoundedTaskRunner({
  maxConcurrent: MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  maxPending: MEDIA_DESCRIPTION_MAX_PENDING,
  maxBackgroundPending: MEDIA_DESCRIPTION_MAX_PENDING,
  interactiveBurst: 1,
});

/** 当前在途的冷启动探测等待计数（计入 `MEDIA_DESCRIPTION_MAX_PENDING` 排队总配额）。 */
const probeWaits: { current: number } = { current: 0 };

/**
 * 媒体下载、转码与描述解析共用有界任务执行器单例：模块加载时创建，任务提交时进入队列并在结算时释放；并发上限为 MEDIA_DESCRIPTION_MAX_CONCURRENCY，排队与冷探测等待合计上限为 MEDIA_DESCRIPTION_MAX_PENDING（满额拒绝新排队任务），Worker 重建后从空队列重新创建。
 */
export const mediaTaskRunner: PrioritizedBoundedTaskRunner = {
  get activeCount(): number { return executor.activeCount; },
  get pendingCount(): number { return executor.pendingCount; },
  get backgroundPendingCount(): number { return executor.backgroundPendingCount; },
  run<T>(priority: TaskPriority, task: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    if (!hasMediaTaskCapacity(false)) return Promise.resolve(undefined);
    return executor.run(priority, task, signal);
  },
};

/**
 * 检查当前媒体执行器是否仍有准入容量（waitOnly 为 true 时仅检查排队等待配额）。
 *
 * @param waitOnly 是否仅检查排队等待配额
 * @returns 是否仍有准入容量
 */
export function hasMediaTaskCapacity(waitOnly: boolean): boolean {
  return (!waitOnly && executor.activeCount < MEDIA_DESCRIPTION_MAX_CONCURRENCY) ||
    executor.pendingCount + probeWaits.current < MEDIA_DESCRIPTION_MAX_PENDING;
}

/**
 * 占用一个共享冷探测等待配额并返回幂等释放函数（满额时返回 undefined）。
 *
 * @returns 幂等配额释放函数；排队等待配额已满时返回 `undefined`
 */
export function reserveMediaProbeWait(): (() => void) | undefined {
  if (!hasMediaTaskCapacity(true)) return undefined;
  probeWaits.current += 1;
  let held: boolean = true;
  return (): void => {
    if (!held) return;
    held = false;
    probeWaits.current -= 1;
  };
}
