/** owner: perThread。当前线程的默认时区与格式化缓存状态（packages/libs/time.ts），跨线程边界见 docs/cn/04-invariants.md。 */

import type { TimeZoneState } from "../../types/time";

/**
 * 当前线程的时区状态单例（含默认时区、完整时间格式器、UTC 偏移区段以及 `formatLocalTime` / `formatLogTimestamp` 的日期前缀单槽缓存）：
 * - 主线程在解析 `bot.json` 后经 `adoptTimeZone` 填充；AI、Anti-Raid 与 Disk I/O Worker 分别在收到 `init`、`agentConfig` 与 `load` 消息时填充
 *   （Worker 重建时由主线程重放）。
 * - 切换时区时由 `adoptTimeZone` 整体替换重置所有内部缓存槽；运行期不热重载、不淘汰，进程或 Worker 重建后从 `null` 重新初始化（`null` 表示尚未初始化）。
 */
export const timeZoneState: { current: TimeZoneState | null } = { current: null };
