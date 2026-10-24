import { pendingWedMemberDeletes, wedMemberDeleteCounter, wedMemberFlushState, wedMemberStates, resetWedMemberStates } from "../../cache/main/wedMembers";
import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../consts/diskIO/appendOnly";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { WED_MEMBER_LIMIT } from "../../consts/wed";
import { FifoMap } from "../../libs/fifoMap";
import { flushDiskIODomain, onDiskIORespawn, postDiskIO } from "../../infra/diskIO";
import { onDiskIOReply } from "../../infra/diskIO/observers";
import type { DiskIORecoveryTransport, WedMembersDeleteDiskMessage, WedMembersDiskMessage } from "../../types/diskIO/messages";
import type { DomainFlushOutcome, WedMembersDeletedPersistedReply } from "../../types/diskIO/replies";
import type { WedMemberState } from "../../types/wed";

/**
 * 初始化网关通过后的群按需建立集合，容量满时不挤掉已有群。
 * @param chatId 目标群 ID。
 * @returns 群的成员集合状态；受管群数量已满时返回 undefined。
 */
export function getOrCreateWedMemberState(chatId: number): WedMemberState | undefined {
  let state: WedMemberState | undefined = wedMemberStates.get(chatId);
  if (state !== undefined) return state;
  const pending: WedMembersDeleteDiskMessage | undefined = pendingWedMemberDeletes.get(chatId);
  if (pending === undefined && wedMemberStates.size + pendingWedMemberDeletes.size >= STATE_MANAGED_CHAT_LIMIT) return undefined;
  state = {
    members: new FifoMap(WED_MEMBER_LIMIT),
    latestEnteredAt: 0,
    revision: pending === undefined ? 0 : pending.revision + 1,
    dirty: pending !== undefined,
  };
  wedMemberStates.set(chatId, state);
  if (pending !== undefined) {
    pendingWedMemberDeletes.delete(chatId);
    scheduleWedMemberFlush(true);
  }
  return state;
}

/**
 * init 在联网前接管 DiskIO 已严格验证的全部滑窗（每群不超过 WED_MEMBER_LIMIT）；按文件顺序（即进入顺序）
 * 转成容量 WED_MEMBER_LIMIT 的 FifoMap，末项进入时间即最大进入时间。进程重启不恢复按钮会话。
 * @param snapshots 启动读取到的各群成员滑窗快照。
 */
export function hydrateWedMembers(snapshots: ReadonlyMap<number, ReadonlyMap<number, number>>): void {
  resetWedMemberStates();
  for (const [chatId, entries] of snapshots) {
    const members: FifoMap<number, number> = new FifoMap(WED_MEMBER_LIMIT);
    let latestEnteredAt: number = 0;
    for (const [id, enteredAt] of entries) {
      members.set(id, enteredAt);
      latestEnteredAt = enteredAt;
    }
    wedMemberStates.set(chatId, { members, latestEnteredAt, revision: 0, dirty: false });
  }
}

/**
 * 安排 `/wed` 成员滑窗落盘定时器。
 * @param immediate 是否立即（0ms）触发落盘。
 */
function scheduleWedMemberFlush(immediate: boolean): void {
  if (wedMemberFlushState.timer !== null) {
    if (!immediate || wedMemberFlushState.immediate) return;
    clearTimeout(wedMemberFlushState.timer);
  }
  wedMemberFlushState.immediate = immediate;
  wedMemberFlushState.timer = setTimeout(flushWedMembers, immediate ? 0 : FLUSH_INTERVAL_MS);
  wedMemberFlushState.timer.unref();
}

/**
 * 高频入口只标记实际增删与累计条数；达到统一 DiskIO 阈值后异步生成快照。
 * @param state 有变更的群成员集合状态。
 */
export function markWedMembersDirty(state: WedMemberState): void {
  state.revision++;
  state.dirty = true;
  wedMemberFlushState.changes++;
  scheduleWedMemberFlush(wedMemberFlushState.changes >= FLUSH_MAX_ENTRIES);
}

/**
 * 按进入顺序展开成扁平的 `[id, enteredAt, ...]`，跨线程只复制数字数组。
 * @param chatId 目标群 ID。
 * @param state 群成员集合状态。
 * @returns 待投递给 Disk I/O Worker 的成员快照消息。
 */
function snapshotWedMembers(chatId: number, state: WedMemberState): WedMembersDiskMessage {
  const entries: number[] = [];
  state.members.forEach((enteredAt: number, id: number): void => {
    entries.push(id, enteredAt);
  });
  return { type: "wedMembers", chatId, revision: state.revision, entries };
}

/**
 * TTL、累计阈值和停机共用的投递边界；失败保留最终滑窗，不累计历史快照。
 * @returns 所有待删记录与脏滑窗均被 Disk I/O 接纳时返回 true。
 */
export function flushWedMembers(): boolean {
  if (wedMemberFlushState.timer !== null) clearTimeout(wedMemberFlushState.timer);
  wedMemberFlushState.timer = null;
  wedMemberFlushState.immediate = false;
  wedMemberFlushState.changes = 0;
  let accepted: boolean = true;
  for (const message of pendingWedMemberDeletes.values()) {
    if (!postDiskIO(message)) accepted = false;
  }
  for (const [chatId, state] of wedMemberStates) {
    if (!state.dirty) continue;
    if (postDiskIO(snapshotWedMembers(chatId, state))) state.dirty = false;
    else accepted = false;
  }
  if (!accepted) scheduleWedMemberFlush(false);
  return accepted;
}

/**
 * 从内存中摘掉指定群的 `/wed` 成员池并登记持久化删除请求，等待 Disk I/O 刷盘确认后才清除待删记录。
 *
 * 若该群既无内存成员池也无待删记录则直接返回；投递或刷盘失败时保留 `pendingWedMemberDeletes`
 * 以便重复 teardown、定时刷盘或 Worker 重建重放继续完成删除。若期间该群重建成员池，
 * 新池会提升 `revision` 并接管旧待删记录，迟到的旧回执按 `revision` 比对忽略（见 docs/cn/04-invariants.md）。
 * @param chatId 目标群 ID。
 */
export async function purgeWedMembers(chatId: number): Promise<void> {
  let message: WedMembersDeleteDiskMessage | undefined = pendingWedMemberDeletes.get(chatId);
  if (wedMemberStates.delete(chatId)) {
    message = { type: "deleteWedMembers", chatId, revision: ++wedMemberDeleteCounter.current };
    pendingWedMemberDeletes.set(chatId, message);
  }
  if (message === undefined) return;
  if (!postDiskIO(message)) {
    scheduleWedMemberFlush(false);
    throw new Error(`Disk I/O refused the wed member deletion for chat ${chatId}.`);
  }
  const outcome: DomainFlushOutcome = await flushDiskIODomain("wedMembers");
  if (outcome.result !== "flushed") {
    throw new Error(
      `Failed to delete the wed member snapshot for chat ${chatId}: flush ${outcome.result}.`
    );
  }
  if (pendingWedMemberDeletes.get(chatId) === message) pendingWedMemberDeletes.delete(chatId);
}

/**
 * 先删除滑窗中的 ID，再登记落盘；退群、每日复核和私聊不可访问探测共用此边界。
 * @param chatId 目标群 ID。
 * @param userId 待移除的用户 ID。
 */
export function removeWedMember(chatId: number, userId: number): void {
  const state: WedMemberState | undefined = wedMemberStates.get(chatId);
  if (state?.members.delete(userId)) markWedMembersDirty(state);
}

/**
 * 私聊 ID 无法访问时从所有群奖池移除；查询期间再次发言的群保留新观察。
 * @param userId 待移除的用户 ID。
 * @param observedChats 头像探测期间观察到该用户重新发言的群 ID 集合。
 */
export function removeWedMemberFromAllChats(userId: number, observedChats: ReadonlySet<number>): void {
  for (const chatId of wedMemberStates.keys()) {
    if (!observedChats.has(chatId)) removeWedMember(chatId, userId);
  }
}

/**
 * DiskIO 重建时重放待删责任与最终滑窗；恢复层仅覆盖重放时 FIFO 中的同群旧操作。
 * @param transport Disk I/O 崩溃恢复重放传输通道。
 * @returns 全部待删记录与滑窗快照均成功重放时返回 true。
 */
export function replayWedMembers(transport: DiskIORecoveryTransport): boolean {
  for (const message of pendingWedMemberDeletes.values()) {
    if (!transport.post(message)) return false;
  }
  for (const [chatId, state] of wedMemberStates) {
    if (!transport.post(snapshotWedMembers(chatId, state))) return false;
    state.dirty = false;
  }
  return true;
}

onDiskIORespawn("wed members", DISK_IO_RESPAWN_PRIORITIES.WED_MEMBERS, replayWedMembers);
onDiskIOReply("wedMembersDeletedPersisted", (reply: WedMembersDeletedPersistedReply): void => {
  if (pendingWedMemberDeletes.get(reply.chatId)?.revision === reply.revision) {
    pendingWedMemberDeletes.delete(reply.chatId);
  }
});
