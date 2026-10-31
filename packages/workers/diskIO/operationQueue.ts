/** 异步内容 I/O 与消息处理的唯一串行边界（所属线程：Disk I/O Worker）。 */

import { diskIOOperationCount, diskIOOperationTail } from "../../cache/workers/diskIO/recovery";
import { DISK_WORKER_MAX_QUEUED_OPERATIONS } from "../../consts/diskIO/business";

/** 一项 Disk I/O 操作；同步维护任务与异步内容读取共用同一签名。 */
type DiskIOOperation = () => void | Promise<void>;

/** 单项 Disk I/O 串行操作结算时归还队列计数的共用回调。 */
function onDiskIOOperationSettled(): void {
  diskIOOperationCount.current--;
}

/**
 * 将操作追加到串行队列尾部；超出队列上限时直接返回 rejected Promise。
 * @param operation 待串行执行的同步或异步 Disk I/O 操作。
 * @returns 该操作在串行队列中执行完成后的 Promise；队列满额时返回 rejected Promise。
 */
export function enqueueDiskIOOperation(
  operation: DiskIOOperation
): Promise<void> {
  if (diskIOOperationCount.current >= DISK_WORKER_MAX_QUEUED_OPERATIONS) {
    return Promise.reject(new Error("Disk I/O Worker operation capacity was exhausted."));
  }
  diskIOOperationCount.current++;
  const next: Promise<void> = diskIOOperationTail.current.then(operation).finally(onDiskIOOperationSettled);
  diskIOOperationTail.current = next;
  return next;
}
