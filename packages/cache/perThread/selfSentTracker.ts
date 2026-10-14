/** owner: perThread。机器人自发消息回环识别状态（packages/infra/selfSentTracker.ts）。 */

import type { SelfSentWaiter } from "../../types/telegram";

/**
 * 刚发出的自发消息表（chatId -> messageId -> 到期定时器）：本线程发送成功时由 markSelfSent 写入，SELF_SENT_MESSAGE_TTL_MS 到期由定时器自删（内层表为空时连带移除外层键）。
 * 容量与 SELF_SENT_MESSAGE_TTL_MS 窗口内发出的消息数同阶；线程重建或 resetSelfSentTracker 时清空。
 */
export const sentMessages: Map<number, Map<number, ReturnType<typeof setTimeout>>> = new Map();

/**
 * 等待自发消息登记结果的频道消息等待表（chatId -> messageId -> Set<SelfSentWaiter>）：waitForBotOwnMessage 在该群仍有在途发送时登记，markSelfSent 命中、超时或该群 inFlightSelfSends 归零时结算并摘除。
 * 容量与会合窗口内待判定的频道消息数同阶；线程重建或 resetSelfSentTracker 时清空。
 */
export const pendingSelfSentWaiters: Map<number, Map<number, Set<SelfSentWaiter>>> = new Map();

/**
 * 群 ID 到本线程尚未结算的产消息出站请求计数的映射：发送前由 beginSelfSentSend 递增，响应完成 markSelfSent 或失败后由 endSelfSentSend 递减并在归零时删键。
 * 容量与同时存在在途发送的聊天数同阶；线程重建或 resetSelfSentTracker 时清空。
 */
export const inFlightSelfSends: Map<number, number> = new Map();

/** 取消全部自发消息定时器、以 false 结算全部等待者并清空状态表。 */
export function resetSelfSentTracker(): void {
  for (const byMessage of sentMessages.values()) {
    for (const timer of byMessage.values()) clearTimeout(timer);
  }
  sentMessages.clear();
  for (const byMessage of pendingSelfSentWaiters.values()) {
    for (const waiters of byMessage.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    }
  }
  pendingSelfSentWaiters.clear();
  inFlightSelfSends.clear();
}
