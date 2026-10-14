/**
 * Owner: Disk I/O Worker。领域定时 flush 的统一 timer 与合并入队边界。
 */

import {
  dueTimedDiskIOOperations,
  timedDiskIOOperationState,
} from "../../cache/workers/diskIO/timedFlush";
import { enqueueDiskIOOperation } from "./operationQueue";
import type { FlushTimerSlot, TimedDiskIOOperation } from "../../types/diskIO/storage";

/** 按加入顺序执行已到点的定时操作；执行期间新到点的操作排在本轮末尾一并执行。 */
async function runDueTimedDiskIOOperations(): Promise<void> {
  try {
    for (const operation of dueTimedDiskIOOperations) {
      dueTimedDiskIOOperations.delete(operation);
      await operation();
    }
  } finally {
    timedDiskIOOperationState.queued = false;
  }
}

/** 登记一项到点的定时操作；合并操作尚未排队时排进统一操作队列。 */
export function queueTimedDiskIOOperation(operation: TimedDiskIOOperation): void {
  dueTimedDiskIOOperations.add(operation);
  if (timedDiskIOOperationState.queued) return;
  timedDiskIOOperationState.queued = true;
  void enqueueDiskIOOperation(runDueTimedDiskIOOperations);
}

/** 槽位空闲时注册 delayMs 后触发的 unref 定时器，触发后将操作排入定时合并队列。 */
export function armDiskIOFlushTimer(
  slot: FlushTimerSlot,
  delayMs: number,
  operation: TimedDiskIOOperation
): void {
  if (slot.timer !== null) return;
  slot.timer = setTimeout((): void => {
    slot.timer = null;
    queueTimedDiskIOOperation(operation);
  }, delayMs);
  slot.timer.unref();
}

/** 取消槽位上尚未触发的 timer；直接 flush 前调用，槽位空闲时幂等。 */
export function cancelDiskIOFlushTimer(slot: FlushTimerSlot): void {
  if (slot.timer === null) return;
  clearTimeout(slot.timer);
  slot.timer = null;
}
