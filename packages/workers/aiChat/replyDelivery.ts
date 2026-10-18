import { replyDeliveryCounts, replyDeliveryTotal, replyDeliveryWindows } from "../../cache/workers/aiChat/replies";
import { REPLY_DELIVERY_MAX_PER_CHAT, REPLY_DELIVERY_MAX_TOTAL } from "../../consts/aiChat/rateLimit";
import { LinkedQueue } from "../../libs/linkedQueue";
import type { ReplyDeliverySlot, ReplyDeliveryTurn, ReplyDeliveryWindow } from "../../types/aiChat/replies";

/** 跳过已完成项；队首仍是占位时等待，链就绪后只放行这一轮。 */
function advanceDelivery(chatId: number, window: ReplyDeliveryWindow): void {
  while (window.queue.size > 0) {
    const slot: ReplyDeliverySlot | undefined = window.queue.peek();
    if (!slot) throw new Error("AI reply delivery slot missing.");
    if (slot.state !== "done") {
      if (slot.state === "ready") slot.ready.resolve();
      return;
    }
    window.queue.shift();
    const remaining: number = (replyDeliveryCounts.get(chatId) ?? 0) - 1;
    if (remaining > 0) replyDeliveryCounts.set(chatId, remaining);
    else replyDeliveryCounts.delete(chatId);
    replyDeliveryTotal.current--;
    slot.released.resolve();
  }
  if (replyDeliveryWindows.get(chatId) === window) replyDeliveryWindows.delete(chatId);
}

/** 本群是否仍有已预留发送占位、尚未按序回收的存活轮次。 */
export function hasLiveReplyRounds(chatId: number): boolean {
  return replyDeliveryCounts.has(chatId);
}

/**
 * 按入站顺序预留发送占位：群内无在途窗口时作为直接轮当即放行发送，否则作为有序并行轮排入 FIFO 等待前序轮次完成。
 * 生命周期约束见 docs/cn/04-invariants.md。
 */
export function reserveReplyDelivery(chatId: number): ReplyDeliveryTurn | undefined {
  if (!hasReplyDeliveryCapacity(chatId)) return undefined;
  let window: ReplyDeliveryWindow | undefined = replyDeliveryWindows.get(chatId);
  const direct: boolean = window === undefined;
  if (!window) {
    window = {
      queue: new LinkedQueue<ReplyDeliverySlot>(),
      directModelActive: true,
    };
    replyDeliveryWindows.set(chatId, window);
  }
  const ownedWindow: ReplyDeliveryWindow = window;
  const slot: ReplyDeliverySlot = {
    ready: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>(),
    state: direct ? "ready" : "pending",
  };
  if (direct) slot.ready.resolve();
  window.queue.push(slot);
  replyDeliveryCounts.set(chatId, (replyDeliveryCounts.get(chatId) ?? 0) + 1);
  replyDeliveryTotal.current++;
  return {
    direct,
    ready: slot.ready.promise,
    commit: (): void => {
      if (direct) {
        ownedWindow.directModelActive = false;
        return;
      }
      if (slot.state !== "pending") return;
      slot.state = "ready";
      advanceDelivery(chatId, ownedWindow);
    },
    finish: (): Promise<void> => {
      slot.state = "done";
      advanceDelivery(chatId, ownedWindow);
      return slot.released.promise;
    },
  };
}

/** 同步查询所有仍存活代际的单群与全线程预算，不创建窗口或修改计数。 */
export function hasReplyDeliveryCapacity(chatId: number): boolean {
  return replyDeliveryTotal.current < REPLY_DELIVERY_MAX_TOTAL &&
    (replyDeliveryCounts.get(chatId) ?? 0) < REPLY_DELIVERY_MAX_PER_CHAT;
}

/** 该群的直接轮仍在模型阶段；准入与补跑据此在有序并行上限之外另放行这一轮。 */
export function isDirectReplyModelActive(chatId: number): boolean {
  return replyDeliveryWindows.get(chatId)?.directModelActive === true;
}
