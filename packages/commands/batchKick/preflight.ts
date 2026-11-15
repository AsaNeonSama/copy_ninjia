import {
  batchKickInFlightSeqByChat,
  batchKickPreflightSeqsByChat,
  batchKickSequence,
  miniAppBatchKickCompletedByChat,
} from "../../cache/main/batchKick";
import { getChatState } from "../../infra/chatStateStorage";
import { purgesChatData } from "../../libs/chatTeardown";
import type { ChatState } from "../../types/chatState";
import type { ChatTeardownReason } from "../../types/chatTeardown";

/**
 * 本群此刻是否仍归 `/batch_kick` 处置：已初始化，且没有确证失去管理员身份。
 * @param chatId 目标群聊 ID。
 * @returns 本群仍受管且未确证失去管理员身份时返回 `true`；否则返回 `false`。
 */
export function isBatchKickChatManaged(chatId: number): boolean {
  const state: Readonly<ChatState> = getChatState(chatId);
  return state.isInitEnabled === true && state.botPermissions?.isAdministrator !== false;
}

/**
 * 删数据类群 teardown（`explicitDisable`、`departed`、`gone`）时清理本群批踢预检、在途批次序号与完成结果。
 * @param chatId 目标群聊 ID。
 * @param reason 触发群 teardown 的原因。
 */
export function purgeBatchKickChatState(chatId: number, reason: ChatTeardownReason): void {
  if (!purgesChatData(reason)) return;
  batchKickPreflightSeqsByChat.delete(chatId);
  miniAppBatchKickCompletedByChat.delete(chatId);
  batchKickInFlightSeqByChat.delete(chatId);
}

/**
 * 为已开启 `/init` 的群登记一次 `/batch_kick` 异步预检（群类型探测、入群日志读取），返回单调递增序号。
 * @param chatId 目标群聊 ID。
 * @returns 本次预检分配的单调递增序号。
 */
export function beginBatchKickPreflight(chatId: number): number {
  const seq: number = ++batchKickSequence.current;
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

/**
 * 为已获取单飞锁的群登记一批 `/batch_kick` 执行任务，返回单调递增序号。
 * @param chatId 目标群聊 ID。
 * @returns 本批次分配的单调递增序号。
 */
export function beginBatchKickExecution(chatId: number): number {
  const seq: number = ++batchKickSequence.current;
  batchKickInFlightSeqByChat.set(chatId, seq);
  return seq;
}

/**
 * 判断指定群的一批 `/batch_kick` 执行任务是否仍处于同一 `/init` 生命周期内（未历经删数据类群 teardown）。
 * @param chatId 目标群聊 ID。
 * @param seq `beginBatchKickExecution` 返回的批次序号。
 * @returns 登记序号仍匹配本批时返回 `true`，已被群 teardown 作废或移除时返回 `false`。
 */
function hasLiveBatchKickExecution(chatId: number, seq: number): boolean {
  return batchKickInFlightSeqByChat.get(chatId) === seq;
}

/**
 * 结束一批 `/batch_kick` 执行任务：仅当本群当前登记序号仍为 `seq` 时移除并返回 `true`。
 * @param chatId 目标群聊 ID。
 * @param seq `beginBatchKickExecution` 返回的批次序号。
 * @returns 结算时本批序号仍有效（未被删数据类群 teardown 提前清除）时返回 `true`，否则返回 `false`。
 */
export function endBatchKickExecution(chatId: number, seq: number): boolean {
  if (batchKickInFlightSeqByChat.get(chatId) !== seq) return false;
  batchKickInFlightSeqByChat.delete(chatId);
  return true;
}

/**
 * 判断一批已受理的 `/batch_kick` 任务此刻是否仍处于原 `/init` 生命周期且受本机器人管辖。
 * @param chatId 目标群聊 ID。
 * @param taskSeq `beginBatchKickExecution` 分配的本批次序号。
 * @returns 未经删数据类群 teardown 且本群仍受管时返回 `true`；否则返回 `false`。
 */
export function isBatchKickTaskLive(chatId: number, taskSeq: number): boolean {
  return hasLiveBatchKickExecution(chatId, taskSeq) && isBatchKickChatManaged(chatId);
}
