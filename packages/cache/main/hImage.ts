/** owner: main。`/h_image` 命令限流状态（packages/commands/hImage.ts）。 */

import { H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../consts/hImage";
import { TimestampDeque } from "../../libs/timestampDeque";

/**
 * `/h_image` 全局滑动窗口调用时间戳队列（窗口长度 H_IMAGE_RATE_LIMIT_WINDOW_MS）：每次判定时先淘汰滑出窗口的队首时间戳，未满额时写入当前时间戳。
 * 容量固定为 H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW；进程重启后从空队列开始。
 */
export const recentHImageCallTimestamps: TimestampDeque =
  new TimestampDeque(H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW);
