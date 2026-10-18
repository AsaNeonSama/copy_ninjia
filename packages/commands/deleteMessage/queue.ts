/**
 * `/delete_message` 的待删队列（cache/main/deleteMessage.ts）：入队、唯一消费循环、群 teardown 摘除
 * 与停机排空。消费循环从队首取同一群的连续条目（每批不超过 TELEGRAM_DELETE_MESSAGES_BATCH_MAX）
 * 发一次 deleteMessages，经统一 Telegram 出站；失败由统一 Telegram 错误日志记录，不重试。
 * 循环在队列自己的取消上下文里运行，不继承触发它的 update 的取消信号与话题。
 */

import {
  deleteMessageDrainWaiters,
  deleteMessageQueue,
  deleteMessageQueueRuntime,
} from "../../cache/main/deleteMessage";
import { DELETE_MESSAGE_QUEUE_MAX } from "../../consts/deleteMessage";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../consts/telegram";
import { logger } from "../../infra/logger";
import { deleteMessages } from "../../infra/telegram";
import { runWithUpdateAbortSignal } from "../../infra/updateContext";
import { drainWithWaiter, settleFlushWaiters } from "../../libs/drainWaiter";
import type { QueuedTargetMessageDeletion } from "../../types/deleteMessage";
import type { FlushResult } from "../../types/lifecycle";

/** 消费循环空闲且队列已空时结算停机等待者。 */
function notifyDeletionDrainIfIdle(): void {
  if (deleteMessageQueueRuntime.running || deleteMessageQueue.size > 0) return;
  settleFlushWaiters(deleteMessageDrainWaiters, "flushed");
}

/**
 * 依次删除队列里的全部条目，直到队列为空或取消上下文中止。每批先出队再发请求，请求在途期间
 * 新入队的条目由下一轮取走。
 */
async function consumeTargetMessageDeletions(): Promise<void> {
  const signal: AbortSignal = deleteMessageQueueRuntime.controller.signal;
  let head: QueuedTargetMessageDeletion | undefined = deleteMessageQueue.peek();
  while (head !== undefined && !signal.aborted) {
    const chatId: number = head.chatId;
    const messageIds: number[] = [];
    while (head?.chatId === chatId && messageIds.length < TELEGRAM_DELETE_MESSAGES_BATCH_MAX) {
      messageIds.push(head.messageId);
      deleteMessageQueue.shift();
      head = deleteMessageQueue.peek();
    }
    try {
      await deleteMessages(chatId, messageIds);
    } catch (error: unknown) {
      // runTelegramAction 只在本循环的取消上下文中止时上抛。
      if (!signal.aborted) logger.error("Unexpected error while deleting queued target messages:", error);
    }
    head = deleteMessageQueue.peek();
  }
  deleteMessageQueueRuntime.running = false;
  if (deleteMessageQueue.size === 0 && deleteMessageQueueRuntime.droppedCount > 0) {
    logger.warn(
      `Dropped ${deleteMessageQueueRuntime.droppedCount} target message deletions while the queue was full.`
    );
    deleteMessageQueueRuntime.droppedCount = 0;
  }
  notifyDeletionDrainIfIdle();
}

/**
 * 把目标的一条消息排进待删队列，消费循环空闲时同步启动它。队列已达 DELETE_MESSAGE_QUEUE_MAX
 * 时不入队，本轮满队的第一条记一行 warn，队列排空时再汇总丢弃条数；停机排空中止后不再入队。
 */
export function enqueueTargetMessageDeletion(chatId: number, messageId: number): void {
  if (deleteMessageQueueRuntime.controller.signal.aborted) return;
  if (deleteMessageQueue.size >= DELETE_MESSAGE_QUEUE_MAX) {
    if (deleteMessageQueueRuntime.droppedCount === 0) {
      logger.warn(
        `Target message deletion queue is full (${DELETE_MESSAGE_QUEUE_MAX}); new deletions are dropped until it drains.`
      );
    }
    deleteMessageQueueRuntime.droppedCount += 1;
    return;
  }
  deleteMessageQueue.push({ chatId, messageId });
  if (deleteMessageQueueRuntime.running) return;
  deleteMessageQueueRuntime.running = true;
  void runWithUpdateAbortSignal(deleteMessageQueueRuntime.controller.signal, consumeTargetMessageDeletions);
}

/** 群 teardown：按原顺序摘掉本群尚未发出的条目；已在途的那一批照常结算，消费循环随后自行收尾。 */
export function dropQueuedTargetMessageDeletions(chatId: number): void {
  for (let remaining: number = deleteMessageQueue.size; remaining > 0; remaining -= 1) {
    const entry: QueuedTargetMessageDeletion = deleteMessageQueue.shift()!;
    if (entry.chatId !== chatId) deleteMessageQueue.push(entry);
  }
}

/**
 * 停机排空超出预算：整队丢弃并记一行错误，中止消费循环的取消上下文；在途请求随之撤销，循环
 * 退出时结算等待者。
 */
function abortTargetMessageDeletions(): void {
  const dropped: number = deleteMessageQueue.size;
  deleteMessageQueue.clear();
  if (dropped > 0) {
    logger.error(`Target message deletion drain timed out; dropped ${dropped} queued deletions.`);
  }
  deleteMessageQueueRuntime.controller.abort();
}

/** 生命周期边界：等待待删队列与消费循环归零；超出预算时丢弃剩余条目并返回 `"timedOut"`。 */
export function drainTargetMessageDeletions(timeoutMs: number): Promise<FlushResult> {
  return drainWithWaiter({
    owner: "Target message deletion",
    timeoutMs,
    isIdle: (): boolean => !deleteMessageQueueRuntime.running && deleteMessageQueue.size === 0,
    waiters: deleteMessageDrainWaiters,
    notifyIfIdle: notifyDeletionDrainIfIdle,
    abort: abortTargetMessageDeletions,
  });
}

/** 测试隔离：清空队列并重建取消上下文；消费循环仍在跑时拒绝复位。 */
export function resetTargetMessageDeletionQueue(): void {
  if (deleteMessageQueueRuntime.running) {
    throw new Error("Cannot reset the target message deletion queue while it is consuming.");
  }
  deleteMessageQueue.clear();
  deleteMessageQueueRuntime.droppedCount = 0;
  deleteMessageQueueRuntime.controller = new AbortController();
}
