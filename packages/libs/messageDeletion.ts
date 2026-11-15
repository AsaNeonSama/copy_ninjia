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
