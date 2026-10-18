import { getCurrentTime } from "../../libs/time";
import type { CurrentTimeResult } from "../../types/time";

/**
 * 格式化带标签与配置时区名的当前时间句（提示词稳定前缀与动态内容顺序约束见 docs/cn/04-invariants.md）。
 */
export function currentTimeSentence(label: string): string {
  const now: CurrentTimeResult = getCurrentTime();
  return `${label}：${now.formatted}（${now.timezone}）。`;
}
