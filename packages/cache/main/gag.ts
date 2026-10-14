/** owner: main。`/gag` 会话运行时状态（packages/commands/gag/）。 */

import type { GagSession } from "../../types/gag";

/**
 * 群 ID 到活跃 gag 会话列表的映射（同群同 targetId 唯一）：
 * - `/gag` 发起时以 starting 阶段写入，提示消息发送成功后切为 active 并启动到期与入口定时换新定时器；
 * - 到期、`/ungag`、群 teardown 或停机排空时切为 ending，待公开提示与发言入口提示全部删除后移除条目。
 * 全局容量上限为 GAG_SESSION_MAX，满额拒绝新会话且不淘汰现有会话；进程重启后从空表开始。
 */
export const gagSessionsByChat: Map<number, GagSession[]> = new Map();

/** gag 新会话准入开关：启动时为 true，停机 quiesce 时置为 false；单例布尔值，进程重启后恢复为 true。 */
export const gagRuntimeAccepting: { current: boolean } = { current: true };

/** gag 到期清理、删除重试与入口换新的在途后台任务集合：任务发起时登记，结算时自摘除；容量与 GAG_SESSION_MAX 同阶，进程重启后从空集开始。 */
export const gagBackgroundTasks: Set<Promise<void>> = new Set();

/** 统计全部群的 gag 会话总数（含 starting、active 与 ending）。 */
export function gagSessionCount(): number {
  let count: number = 0;
  for (const sessions of gagSessionsByChat.values()) count += sessions.length;
  return count;
}

/** 统计全部群处于 active 阶段的 gag 会话总数。 */
export function activeGagSessionCount(): number {
  let count: number = 0;
  for (const sessions of gagSessionsByChat.values()) {
    for (const session of sessions) {
      if (session.phase === "active") count++;
    }
  }
  return count;
}
