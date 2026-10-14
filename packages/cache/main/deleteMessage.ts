/** owner: main。`/delete_message` 待删队列状态（packages/commands/deleteMessage/queue.ts）。 */

import { DELETE_MESSAGE_QUEUE_MAX } from "../../consts/deleteMessage";
import { BoundedDeque } from "../../libs/boundedDeque";
import type { QueuedTargetMessageDeletion } from "../../types/deleteMessage";
import type { FlushWaiter } from "../../types/lifecycle";

/**
 * 待删消息双端队列：命中目标的新消息入队，消费循环按群取批出队；群 teardown 摘除对应群条目，停机超时排空时清空。
 * 容量上限为 DELETE_MESSAGE_QUEUE_MAX，满额时拒绝新条目并计入 droppedCount；进程重启后从空队列开始。
 */
export const deleteMessageQueue: BoundedDeque<QueuedTargetMessageDeletion> =
  new BoundedDeque<QueuedTargetMessageDeletion>(DELETE_MESSAGE_QUEUE_MAX);

/**
 * 待删队列消费状态与取消控制器：消费循环启动时置 running 为 true，队列排空时 running 与 droppedCount 归零；停机排空超时时中止 controller。
 * 单例固定字段，进程重启后从初始值开始。
 */
export const deleteMessageQueueRuntime: {
  running: boolean;
  droppedCount: number;
  controller: AbortController;
} = {
  running: false,
  droppedCount: 0,
  controller: new AbortController(),
};

/** 待删队列排空等待集合（libs/drainWaiter.ts）：停机等待时登记，队列与消费循环归零或超时时结算移除；容量与并发停机调用方同阶，不淘汰，进程重启后从空集开始。 */
export const deleteMessageDrainWaiters: Set<FlushWaiter> = new Set();
