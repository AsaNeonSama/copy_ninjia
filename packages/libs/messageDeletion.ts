import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../consts/telegram";
import type { DeleteMessageOutcome } from "../types/telegram";

/**
 * 判断单次删除结局是否表示目标消息已结清（已删除或确认不存在/不可删除）。
 * 纯判定函数，不接触 Telegram 客户端；供只看成败的删除、gag/wed 状态机消息及入群验证残留清理共用。
 * @param outcome 单次消息删除尝试的结果枚举。
 * @returns 消息已删除或确认已不存在/不可删时返回 true，瞬态失败需重试时返回 false。
 */
export function isMessageDeletionSettled(outcome: DeleteMessageOutcome): boolean {
  return outcome === "deleted" || outcome === "gone";
}

/**
 * 按 `TELEGRAM_DELETE_MESSAGES_BATCH_MAX` 分片顺序执行批量消息删除并统计失败批次数。
 * 单批不超上限时直接透传原数组，避免多余切片分配。
 *
 * @param messageIds 待删除的消息 ID 列表。
 * @param deleteBatch 删除单个消息 ID 分片的异步回调，成功返回 `true`。
 * @returns 删除失败的批次数（全部成功或列表为空时为 `0`）。
 */
export async function deleteMessageIdBatches(
  messageIds: readonly number[],
  deleteBatch: (batch: readonly number[]) => Promise<boolean>
): Promise<number> {
  if (messageIds.length === 0) return 0;
  let failedBatches: number = 0;
  for (let start: number = 0; start < messageIds.length; start += TELEGRAM_DELETE_MESSAGES_BATCH_MAX) {
    const batch: readonly number[] =
      start === 0 && messageIds.length <= TELEGRAM_DELETE_MESSAGES_BATCH_MAX
        ? messageIds
        : messageIds.slice(start, start + TELEGRAM_DELETE_MESSAGES_BATCH_MAX);
    const deleted: boolean = await deleteBatch(batch);
    if (!deleted) failedBatches++;
  }
  return failedBatches;
}
