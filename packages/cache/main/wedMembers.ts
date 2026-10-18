/** owner: main。`/wed` 已发言成员池与落盘合并状态（packages/commands/wed/persistence.ts），跨线程边界见 docs/cn/04-invariants.md。 */
import type { WedMemberState } from "../../types/wed";
import type { WedMembersDeleteDiskMessage } from "../../types/diskIO/messages";

/**
 * 群 ID 到 `/wed` 已发言候选成员池的权威映射：
 * - 填充：启动时从 Disk I/O Worker 快照恢复，运行期新成员个人发言时追加到末尾；
 * - 清理与淘汰：成员退群、每日复核确认离群或私聊不可达时移除该成员，清除群数据的 teardown（purgeWedMembers）删除整群条目；群数上限为 STATE_MANAGED_CHAT_LIMIT，每群成员上限为 WED_MEMBER_LIMIT（满额按 FIFO 淘汰最早进入的成员）；
 * - 重建：Disk I/O Worker 重建时由主线程全量重放脏快照，进程重启后从磁盘文件恢复（无条目表示无候选成员）。
 */
export const wedMemberStates: Map<number, WedMemberState> = new Map();

/**
 * 群 ID 到未确认落盘整群成员删除消息的映射：teardown 删除成员池时登记，收到匹配 durable 删除回执或同群重建成员池时清除，Disk I/O Worker 重建时全量重放。
 * 与 wedMemberStates 合计群数上限为 STATE_MANAGED_CHAT_LIMIT，不淘汰未确认条目；进程重启后从空表开始（无条目表示无待确认删除）。
 */
export const pendingWedMemberDeletes: Map<number, WedMembersDeleteDiskMessage> = new Map();
/** `/wed` 成员池删除请求的单调递增序号发号器：teardown 时分配，Worker 重建不重置，进程重启后从零开始；单例标量。 */
export const wedMemberDeleteCounter: { current: number } = { current: 0 };

/** `/wed` 成员池批量落盘定时器与变更计数状态：首次变更启动定时器或达阈值提前触发，发送或 resetWedMemberStates 时清理；单例固定字段。 */
export const wedMemberFlushState: {
  timer: ReturnType<typeof setTimeout> | null;
  changes: number;
  immediate: boolean;
} = { timer: null, changes: 0, immediate: false };

/** 清空 `/wed` 成员池、待确认删除表与落盘定时器状态（初始化或测试隔离用）。 */
export function resetWedMemberStates(): void {
  if (wedMemberFlushState.timer !== null) clearTimeout(wedMemberFlushState.timer);
  wedMemberFlushState.timer = null;
  wedMemberFlushState.changes = 0;
  wedMemberFlushState.immediate = false;
  wedMemberStates.clear();
  pendingWedMemberDeletes.clear();
}
