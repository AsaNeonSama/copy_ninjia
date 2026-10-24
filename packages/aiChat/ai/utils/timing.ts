import { TYPING_DELAY_BASE_MS, TYPING_DELAY_JITTER_MS, TYPING_DELAY_MAX_MS, TYPING_DELAY_PER_CHAR_MS } from "../../../consts/aiChat/tools";

/**
 * 按消息字符长度、随机抖动与上限常量计算单条消息发送前的输入状态等待时长。
 * @param nextPart 即将发送的下一条消息文本。
 * @returns 拟人输入状态等待毫秒数。
 */
export function typingDelayMs(nextPart: string): number {
  const base: number = TYPING_DELAY_BASE_MS + nextPart.length * TYPING_DELAY_PER_CHAR_MS;
  const jitter: number = Math.random() * TYPING_DELAY_JITTER_MS;
  return Math.min(base + jitter, TYPING_DELAY_MAX_MS);
}

/**
 * 生成给定区间内的随机延迟毫秒数。
 * @param min 下界毫秒数。
 * @param max 上界毫秒数。
 * @returns 位于 `[min, max)` 区间内的随机毫秒数。
 */
export function randomDelayMs(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
