/** owner: workers/diskIO。`/wed` 成员快照落盘待写状态（packages/workers/diskIO/wedMemberFiles.ts），跨线程边界见 docs/cn/04-invariants.md。 */
import type { WedMembersDeletedPersistedReply } from "../../../types/diskIO/replies";
import type { FlushTimerSlot } from "../../../types/diskIO/storage";

/**
 * 群 ID 到待写入磁盘的 `[id, enteredAt, ...]` 成员快照的持久化镜像：
 * - 镜像语义：权威线程为主线程（cache/main/wedMembers.ts），主线程在批量窗口关闭时全量推送脏群快照，本线程写入磁盘成功后释放；Disk I/O Worker 重建后由主线程全量重放；缺失条目表示当前无待写快照。
 * - 容量：群数上限为 STATE_MANAGED_CHAT_LIMIT，每群长度受 WED_MEMBER_LIMIT 约束，不淘汰未写快照；进程重启后从磁盘文件恢复。
 */
export const pendingWedMembers: Map<number, readonly number[]> = new Map();

/** 待刷盘的 `/wed` 群 ID 集合：与 pendingWedMembers 同步登记，刷盘成功或 resetWedFileWrites 时移除；容量上限为 STATE_MANAGED_CHAT_LIMIT，Worker 重建后由主线程重放。 */
export const dirtyWedChats: Set<number> = new Set();

/** 已收到 deleteWedMembers 但尚未完成文件 unlink 的群 ID 到删除序号映射：收到删除消息时登记，unlink 成功、同群新快照到达或 resetWedFileWrites 时移除；容量上限为 STATE_MANAGED_CHAT_LIMIT，Worker 重建后由主线程全量重投未确认删除。 */
export const deletedWedChats: Map<number, number> = new Map();

/** `/wed` 成员文件删除 durable 回执发送回调单例：Disk I/O Worker 启动时安装，isolate 销毁时释放；单例函数。 */
export const wedMemberDeletePersistedNotifier: { current: (reply: WedMembersDeletedPersistedReply) => void } = {
  current: (): void => { /* 独立 owner 测试未安装 Worker 回执出口。 */ },
};

/** `/wed` 成员文件写入失败后的重试 timer 单例：写失败时创建，重试成功或 resetWedFileWrites 时清除；Worker 重建后从 null 开始。 */
export const wedFileFlushTimer: FlushTimerSlot = { timer: null };

/** 取消重试 timer 并清空 `/wed` 待写快照、待刷群集合与待删群映射。 */
export function resetWedFileWrites(): void {
  if (wedFileFlushTimer.timer !== null) clearTimeout(wedFileFlushTimer.timer);
  wedFileFlushTimer.timer = null;
  pendingWedMembers.clear();
  dirtyWedChats.clear();
  deletedWedChats.clear();
}
