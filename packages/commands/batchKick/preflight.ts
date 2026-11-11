import {
  batchKickPreflightSeqsByChat,
  miniAppBatchKickCompletedByChat,
  miniAppBatchKickInFlightSeqByChat,
  miniAppBatchKickSequence,
} from "../../cache/main/batchKick";
import { purgesChatData } from "../../libs/chatTeardown";
import type { ChatTeardownReason } from "../../types/chatTeardown";

/**
 * 删数据类群 teardown（`explicitDisable`、`departed`、`gone`）时清理本群批踢预检、在途序号与完成结果。
 * @param chatId 目标群聊 ID。
 * @param reason 触发群 teardown 的原因。
 */
export function purgeBatchKickChatState(chatId: number, reason: ChatTeardownReason): void {
  if (!purgesChatData(reason)) return;
  batchKickPreflightSeqsByChat.delete(chatId);
  miniAppBatchKickCompletedByChat.delete(chatId);
  miniAppBatchKickInFlightSeqByChat.delete(chatId);
}

/**
 * 为已开启 `/init` 的群登记一次 `/batch_kick` 异步预检（群类型探测、入群日志读取），返回单调递增序号。
 * @param chatId 目标群聊 ID。
 * @returns 本次预检分配的单调递增序号。
 */
export function beginBatchKickPreflight(chatId: number): number {
  const seq: number = ++miniAppBatchKickSequence.current;
  let active: Set<number> | undefined = batchKickPreflightSeqsByChat.get(chatId);
  if (active === undefined) {
    active = new Set<number>();
    batchKickPreflightSeqsByChat.set(chatId, active);
  }
  active.add(seq);
  return seq;
}

/**
 * 判断指定群的一轮 `/batch_kick` 异步预检是否仍处于同一 `/init` 生命周期内（未历经删数据类群 teardown）。
 * @param chatId 目标群聊 ID。
 * @param seq `beginBatchKickPreflight` 返回的预检序号。
 * @returns 未被群 teardown 作废时返回 `true`，已作废时返回 `false`。
 */
export function hasLiveBatchKickPreflight(chatId: number, seq: number): boolean {
  return batchKickPreflightSeqsByChat.get(chatId)?.has(seq) === true;
}

/**
 * 结束一轮 `/batch_kick` 异步预检并摘除其序号；本群无其余在途预检时一并移除群键。
 * @param chatId 目标群聊 ID。
 * @param seq `beginBatchKickPreflight` 返回的预检序号。
 */
export function endBatchKickPreflight(chatId: number, seq: number): void {
  const active: Set<number> | undefined = batchKickPreflightSeqsByChat.get(chatId);
  if (active === undefined) return;
  active.delete(seq);
  if (active.size === 0) {
    batchKickPreflightSeqsByChat.delete(chatId);
  }
}
