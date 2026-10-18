/** owner: perThread。当前线程的默认时区与格式化缓存状态（packages/libs/time.ts），跨线程边界见 docs/cn/04-invariants.md。 */

import type { TimeZoneState } from "../../types/time";

/**
 * 当前线程的时区状态单例：主线程在解析 bot.json 后填充，AI、Anti-Raid 与 Disk I/O Worker 分别在收到 init、agentConfig 与 load 消息时填充（Worker 重建时由主线程重放）；运行期不热重载、不淘汰，进程或 Worker 重建后从 null 重新初始化（null 表示尚未初始化）。
 */
export const timeZoneState: { current: TimeZoneState | null } = { current: null };
