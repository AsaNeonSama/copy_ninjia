/** owner: main。`/delete_message` 待删队列（commands/deleteMessage/queue.ts）的运行时状态；Worker 不得 import。
 * 删除目标保存在群状态的 deleteMessageTargets（types/chatState.ts），不在这里。 */

import { DELETE_MESSAGE_QUEUE_MAX } from "../../consts/deleteMessage";
import { BoundedDeque } from "../../libs/boundedDeque";
import type { QueuedTargetMessageDeletion } from "../../types/deleteMessage";
import type { FlushWaiter } from "../../types/lifecycle";

/**
 * 待删队列：目标的每条新消息由消息 ingress 入队一条，消费循环从队首按群取批后出队。
 * 容量硬顶 DELETE_MESSAGE_QUEUE_MAX，满时新条目不入队；群 teardown 摘除本群条目，停机排空
 * 超出预算时整队丢弃。不落盘，进程重启从空队列开始；主线程不随 Worker 重建。
 */
export const deleteMessageQueue: BoundedDeque<QueuedTargetMessageDeletion> =
  new BoundedDeque<QueuedTargetMessageDeletion>(DELETE_MESSAGE_QUEUE_MAX);

/**
 * 待删队列的消费状态与取消边界：`running` 为唯一消费循环在跑；`droppedCount` 是本轮满队期间
 * 未能入队的条数，队列排空时清零；`controller` 是消费循环的取消上下文，停机排空超出预算时中止。
 * 固定三个字段；测试复位时重建 controller。
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

/**
 * 等待待删队列与消费循环归零的停机等待者（libs/drainWaiter.ts）；归零时结算清空，预算耗尽的
 * 等待者自行出队。容量：同时在等排空的调用方数，只有停机路径登记；不设淘汰。
 */
export const deleteMessageDrainWaiters: Set<FlushWaiter> = new Set();
