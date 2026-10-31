/** owner: main。入群验证的主线程镜像与终态延后状态（packages/antiRaid/verificationMirror.ts 与
 * packages/antiRaid/verificationAttempts.ts）。 */

import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "../../../types/antiRaid/verification";

/** activeVerificationSnapshots 的可变底层表；仅经下方写入函数修改。 */
const activeSnapshots: Map<string, VerificationSnapshot> = new Map();

/**
 * 主线程持有的待验证纯数据只读镜像（key 为 verificationKey(chatId, userId)）。
 *
 * 权威线程为 Anti-Raid Worker（cache/workers/antiRaid/verification.ts）。
 * 推送时机与模式：启动时 hydratePendingVerifications 从 Disk I/O 恢复记录全量播种，此后由
 * Anti-Raid Worker 按 generation+revision 增量推送更新或删除。
 * 重放方：Anti-Raid Worker 崩溃重建时原地提升 generation 后全量重放给新 Worker；Disk I/O
 * Worker 崩溃重建时由 onDiskIORespawn 全量重放。
 * 清理：验证完成、离群、群 teardown 或转入延后索引时经 deleteActiveVerificationSnapshot 删除，
 * 启动 hydrate 时经 clearActiveVerificationSnapshots 清空。无条目表示无活动验证快照，不沿用旧值。
 * 容量上限为 VERIFICATION_RECORD_CAPACITY，满额拒收新记录并触发受监督重启，不设淘汰。
 */
export const activeVerificationSnapshots: ReadonlyMap<string, VerificationSnapshot> = activeSnapshots;

/** activeVerificationSnapshots 的按群二级索引（chatId -> userId 集合），随写入函数同步增删。 */
const activeUsersByChat: Map<number, Set<number>> = new Map();

/**
 * 写入或替换一条活动快照，并同步更新按群二级索引。
 *
 * @param key 验证记录键（`chatId:userId`）
 * @param snapshot 待写入的活动验证快照
 */
export function setActiveVerificationSnapshot(key: string, snapshot: VerificationSnapshot): void {
  activeSnapshots.set(key, snapshot);
  let users: Set<number> | undefined = activeUsersByChat.get(snapshot.chatId);
  if (users === undefined) {
    users = new Set();
    activeUsersByChat.set(snapshot.chatId, users);
  }
  users.add(snapshot.userId);
}

/**
 * 删除一条活动快照及其按群二级索引。
 *
 * @param key 验证记录键（`chatId:userId`）
 */
export function deleteActiveVerificationSnapshot(key: string): void {
  const snapshot: VerificationSnapshot | undefined = activeSnapshots.get(key);
  if (snapshot === undefined) return;
  activeSnapshots.delete(key);
  const users: Set<number> | undefined = activeUsersByChat.get(snapshot.chatId);
  if (users === undefined) return;
  users.delete(snapshot.userId);
  if (users.size === 0) activeUsersByChat.delete(snapshot.chatId);
}

/** 清空全部活动快照与按群二级索引。 */
export function clearActiveVerificationSnapshots(): void {
  activeSnapshots.clear();
  activeUsersByChat.clear();
}

/**
 * 查询 userId 是否在 chatId 群的活动验证镜像中。
 *
 * @param chatId 群聊 ID
 * @param userId 成员用户 ID
 * @returns 该成员当前是否处于活动入群验证中
 */
export function isActiveVerificationUser(chatId: number, userId: number): boolean {
  if (activeUsersByChat.size === 0) return false;
  return activeUsersByChat.get(chatId)?.has(userId) === true;
}

/**
 * 读取 chatId 群活动验证镜像按群二级索引的只读视图（无条目表示该群当前没有活动验证快照）。
 *
 * @param chatId 群聊 ID
 * @returns 该群当前处于活动入群验证的用户 ID 只读集合；无活动记录时返回 undefined
 */
export function getActiveVerificationUsers(
  chatId: number
): ReadonlySet<number> | undefined {
  return activeUsersByChat.get(chatId);
}

/**
 * 各活动验证 key 已收到 Disk I/O 落盘回执的最新 `{ generation, revision }`。
 * 填充：启动 hydrate 与收到 verificationPersisted 回执时更新。
 * 清理：key 从 activeVerificationSnapshots 删除且收到删除回执时移除，启动 hydrate 时整表重建。
 * 容量与 activeVerificationSnapshots 同阶，不设淘汰。
 */
export const persistedVerificationRevisions: Map<string, { generation: number; revision: number }> = new Map();

/**
 * 已从活动镜像删除、尚待 Disk I/O 落盘回执的验证删除墓碑。
 * 填充：acceptVerificationDelete 接收 Worker 墓碑、deleteDeferredVerificationsForChat 删除延后记录时
 * 写入并投递删除。清理：收到匹配的删除落盘回执（verificationPersisted 且 deleted）、同 key 更新
 * revision 的活动快照被接收、转入延后索引或启动 hydrate 时移除；Disk I/O Worker 重建时全量重放。
 * 容量受待验证记录上限约束，不设淘汰。
 */
export const pendingVerificationDeletes: Map<string, {
  chatId: number;
  userId: number;
  generation: number;
  revision: number;
}> = new Map();

/**
 * 各验证 key 在本进程内的终态执行尝试次数。
 * 填充：grantVerificationAttempt 许可执行时递增，acceptVerificationDeferred 转入延后时置为
 * VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS。清理：验证正常删除或启动 hydrate 时移除。
 * 跨 Anti-Raid Worker 代际保留，进程重启后从空表开始；容量不超过活动与延后验证 key 总数。
 */
export const terminalVerificationAttempts: Map<string, number> = new Map();

/**
 * 终态执行预算耗尽或无法继续执行后从活动镜像移出的延后验证索引。
 *
 * 权威线程为主线程；Worker 上报 defer 且最后快照已落盘时写入，离群、守卫关闭或群 teardown
 * 写入删除墓碑后移除。重放方：Anti-Raid Worker 重建时全量重放给新 isolate；进程重启后从空表开始，
 * 磁盘记录重新进入活动镜像。无条目表示无已生效的延后闩锁，不沿用旧值。容量不超过 VERIFICATION_RECORD_CAPACITY。
 */
export const deferredVerificationRecords: Map<string, DeferredVerificationRecord> =
  new Map();

/**
 * 已请求延后、但最后一份快照尚未收到 Disk I/O 落盘回执的暂存表。
 * 填充：Worker 上报 defer 且对应 revision 尚未落盘时写入（期间完整快照仍留在 activeVerificationSnapshots）。
 * 清理：收到匹配落盘回执后移入 deferredVerificationRecords，或显式删除 / 启动 hydrate 时移除。
 * 容量不超过在途验证写入数。
 */
export const pendingVerificationDeferrals: Map<string, DeferredVerificationRecord> =
  new Map();

/**
 * 验证记录容量越界 fatal 边沿标记；首次越界置 true，启动 hydrate 与 terminate 时置 false。
 * 容量恒为一个布尔值，Worker 崩溃不影响。
 */
export const verificationCapacityFatalState: { current: boolean } = {
  current: false,
};
