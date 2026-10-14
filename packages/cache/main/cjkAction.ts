/** owner: main。中文动作命令限流状态（packages/commands/cjkAction.ts）。 */

import { CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../consts/commands";
import { TimestampDeque } from "../../libs/timestampDeque";

/**
 * 中文动作命令的全局滑动窗口调用时间戳队列（窗口长度 CJK_ACTION_RATE_LIMIT_WINDOW_MS）：每次判定时先淘汰滑出窗口的队首时间戳，未满额时写入当前时间戳。
 * 容量固定为 CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW；进程重启后从空队列开始。
 */
export const recentActionCallTimestamps: TimestampDeque =
  new TimestampDeque(CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW);
